import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { DiscoveredFile, SourceAdapter } from '../core/adapter.ts';
import type { ChatEvent, RawLine, SessionMeta } from '../core/types.ts';
import { digestEvent } from './extract.ts';
import { readLines } from './lines.ts';
import { projectKeyFor } from './project.ts';

export interface IndexProgress {
  filesDone: number;
  filesTotal: number;
  current?: string;
}

export interface FileFailure {
  path: string;
  message: string;
}

export interface IndexResult {
  filesTotal: number;
  indexed: number;
  resumed: number;
  skipped: number;
  removed: number;
  errors: FileFailure[];
}

export interface IndexOptions {
  /** Only (re)process these absolute paths (watcher mode). Deleted ones are removed. */
  only?: ReadonlySet<string>;
  /** Called after each file's transaction commits with the affected session id. */
  onSessionUpdated?: (sessionId: string) => void;
  /** Set `aborted` to stop between files. */
  signal?: { aborted: boolean };
}

/** roots per adapter id; missing entries fall back to `adapter.defaultRoots()`. */
export type RootsMap = Readonly<Record<string, readonly string[] | undefined>>;

const TAIL_BYTES = 256;

/** Adapters may export a `parserVersion` (bump it when parse output changes). */
function parserVersionOf(adapter: SourceAdapter): string {
  const v = (adapter as { parserVersion?: string | number }).parserVersion;
  return v === undefined ? '1' : String(v);
}

type Row = Record<string, unknown>;

interface FileRow {
  size: number;
  mtime_ms: number;
  sidecar_mtime: number | null;
  indexed_size: number;
  indexed_lines: number;
  error_count: number;
  tail_hash: string | null;
  parser_state: string | null;
  parser_version: string;
  error: string | null;
}

function getFileRow(db: DatabaseSync, path: string): FileRow | undefined {
  return db.prepare('SELECT * FROM files WHERE path = ?').get(path) as unknown as FileRow | undefined;
}

// ---------------------------------------------------------------------------
// Row removal
// ---------------------------------------------------------------------------

/** Delete every row belonging to the file at `path` (call inside a transaction or alone). */
export function removeFileRows(db: DatabaseSync, path: string): void {
  const ids = (db.prepare('SELECT id FROM sessions WHERE file_path = ?').all(path) as Row[]).map((r) => String(r.id));
  for (const id of ids) removeSessionRows(db, id);
  db.prepare('DELETE FROM files WHERE path = ?').run(path);
}

function removeSessionRows(db: DatabaseSync, id: string): void {
  db.prepare('DELETE FROM events_fts WHERE rowid IN (SELECT id FROM events WHERE session_id = ?)').run(id);
  db.prepare('DELETE FROM events WHERE session_id = ?').run(id);
  db.prepare(
    "DELETE FROM tool_links WHERE (session_id = ? AND origin = 'event') OR (sub_session_id = ? AND origin = 'sub')",
  ).run(id, id);
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

// ---------------------------------------------------------------------------
// Prepared statements (per connection)
// ---------------------------------------------------------------------------

interface Stmts {
  insEvent: StatementSync;
  insFts: StatementSync;
  insLink: StatementSync;
}

function prepare(db: DatabaseSync): Stmts {
  return {
    insEvent: db.prepare(
      `INSERT INTO events(session_id, seq, line, offset, length, line_first_seq, role, visibility, ts, off_branch, synthetic, preview, dkey)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    ),
    insFts: db.prepare('INSERT INTO events_fts(rowid, text) VALUES (?, ?)'),
    insLink: db.prepare(
      'INSERT OR REPLACE INTO tool_links(session_id, tool_use_id, sub_session_id, origin) VALUES (?, ?, ?, ?)',
    ),
  };
}

const stmtCache = new WeakMap<DatabaseSync, Stmts>();
function stmts(db: DatabaseSync): Stmts {
  let s = stmtCache.get(db);
  if (!s) {
    s = prepare(db);
    stmtCache.set(db, s);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Single file
// ---------------------------------------------------------------------------

function sha1(b: Buffer): string {
  return createHash('sha1').update(b).digest('hex');
}

/**
 * Copy-detection key: forked / resumed sessions (and sub-agent files copied
 * into each fork) repeat the same records with the same native uuid. Events
 * with equal keys are the same message; search shows only one of them.
 */
function dedupeKey(sourceId: string, ev: ChatEvent, indexInLine: number): bigint | null {
  if (!ev.uuid) return null;
  return createHash('sha1').update(`${sourceId}\0${ev.uuid}\0${indexInLine}`).digest().readBigInt64BE(0);
}


/** mtime of the adapter's sidecar file (DiscoveredFile.extra.metaPath), null if none / missing. */
async function sidecarMtime(file: DiscoveredFile): Promise<number | null> {
  const p = file.extra?.metaPath;
  if (typeof p !== 'string') return null;
  try {
    return (await stat(p)).mtimeMs;
  } catch {
    return null;
  }
}

async function readTail(path: string, end: number): Promise<Buffer> {
  const start = Math.max(0, end - TAIL_BYTES);
  const len = end - start;
  if (len <= 0) return Buffer.alloc(0);
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, start);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

type Mode = 'skip' | 'resume' | 'full';

async function decide(
  adapter: SourceAdapter,
  path: string,
  st: { size: number; mtimeMs: number },
  sidecar: number | null,
  prev: FileRow | undefined,
): Promise<{ mode: Mode; tail?: Buffer }> {
  if (!prev || prev.error || prev.parser_version !== parserVersionOf(adapter)) return { mode: 'full' };
  if (prev.sidecar_mtime !== sidecar) return { mode: 'full' }; // sub-agent .meta.json appeared / changed
  if (prev.size === st.size && prev.mtime_ms === st.mtimeMs) return { mode: 'skip' };
  if (
    prev.parser_state &&
    st.size > prev.size &&
    st.size >= prev.indexed_size
  ) {
    // Make sure the already-indexed prefix really is unchanged (pure append).
    const tail = await readTail(path, prev.indexed_size);
    if (sha1(tail) === prev.tail_hash) return { mode: 'resume', tail };
  }
  return { mode: 'full' };
}

export interface FileOutcome {
  mode: Mode;
  sessionId?: string;
}

/**
 * Index (or skip / resume) a single discovered file. Throws on file-level
 * failure after rolling back and recording the error in `files.error`.
 */
export async function indexFile(
  db: DatabaseSync,
  adapter: SourceAdapter,
  file: DiscoveredFile,
): Promise<FileOutcome> {
  const st = await stat(file.path);
  const sidecar = await sidecarMtime(file);
  const prev = getFileRow(db, file.path);
  const decided = await decide(adapter, file.path, st, sidecar, prev);
  let mode = decided.mode;
  if (mode === 'skip') return { mode };

  const s = stmts(db);
  db.exec('BEGIN');
  try {
    const existing = db.prepare('SELECT id FROM sessions WHERE file_path = ? LIMIT 1').get(file.path) as Row | undefined;
    let sessionId = `${adapter.id}:${file.nativeId}`;

    const parser = adapter.createParser(file);
    let startOffset = 0;
    let startLine = 0;
    let tail: Buffer | null = null;
    if (mode === 'resume' && (!prev || !existing)) mode = 'full';
    if (mode === 'resume' && prev && existing) {
      sessionId = String(existing.id);
      parser.resume(JSON.parse(prev.parser_state as string));
      startOffset = prev.indexed_size;
      startLine = prev.indexed_lines;
      tail = decided.tail ?? null;
      // drop events from a previously-partial trailing line; they get re-read
      db.prepare(
        'DELETE FROM events_fts WHERE rowid IN (SELECT id FROM events WHERE session_id = ? AND line >= ?)',
      ).run(sessionId, startLine);
      db.prepare('DELETE FROM events WHERE session_id = ? AND line >= ?').run(sessionId, startLine);
    } else {
      removeFileRows(db, file.path);
      sessionId = unclaimedId(db, sessionId, file.path);
    }

    let line = startLine;
    let completeLines = startLine;
    let lastCompleteEnd = startOffset;
    let parseErrors = prev && mode === 'resume' ? prev.error_count : 0;
    let stateJson: string | null = null;
    const decoder = new TextDecoder('utf-8');

    for await (const rl of readLines(file.path, startOffset, st.size)) {
      if (!rl.complete && stateJson === null) {
        // State as of the last complete line; the partial line is re-read on resume.
        stateJson = JSON.stringify(parser.snapshot());
      }
      const raw = rl.raw;
      const hadCR = raw.length > 0 && raw[raw.length - 1] === 0x0d;
      const content = hadCR ? raw.subarray(0, raw.length - 1) : raw;
      if (content.length > 0) {
        const rawLine: RawLine = {
          line,
          offset: rl.offset,
          length: content.length,
          text: decoder.decode(content),
        };
        let events: ChatEvent[] = [];
        try {
          events = parser.push(rawLine);
        } catch {
          if (rl.complete) parseErrors++; // a partial last line is re-read (and re-counted) on resume
        }
        const firstSeq = events[0]?.seq ?? 0;
        for (const ev of events) {
          const d = digestEvent(ev);
          const res = s.insEvent.run(
            sessionId,
            ev.seq,
            rawLine.line,
            rawLine.offset,
            rawLine.length,
            firstSeq,
            ev.role,
            ev.visibility,
            ev.timestamp ?? null,
            ev.synthetic ? 1 : 0,
            d.preview,
            dedupeKey(adapter.id, ev, ev.seq - firstSeq),
          );
          if (d.fts) s.insFts.run(res.lastInsertRowid, d.fts);
          for (const b of ev.blocks ?? []) {
            if (b.type === 'tool_use' && b.subSessionId) s.insLink.run(sessionId, b.id, b.subSessionId, 'event');
          }
        }
      }
      line++;
      if (rl.complete) {
        completeLines = line;
        lastCompleteEnd = rl.nextOffset;
        // rolling tail of the last TAIL_BYTES of consumed data (raw bytes incl. \r and \n)
        const nl = Buffer.from([0x0a]);
        if (raw.length >= TAIL_BYTES) {
          tail = Buffer.concat([raw.subarray(raw.length - (TAIL_BYTES - 1)), nl]);
        } else {
          const keep = tail ? tail.subarray(Math.max(0, tail.length - (TAIL_BYTES - raw.length - 1))) : Buffer.alloc(0);
          tail = Buffer.concat([keep, raw, nl]);
        }
      }
    }
    if (stateJson === null) stateJson = JSON.stringify(parser.snapshot());

    const { meta, offBranchSeqs } = parser.finish();
    sessionId = finalizeSession(db, sessionId, adapter, file, meta, offBranchSeqs, st.mtimeMs);

    const tailHash = tail ? sha1(tail) : prev && mode === 'resume' ? prev.tail_hash : sha1(Buffer.alloc(0));
    db.prepare(
      `INSERT OR REPLACE INTO files(path, source_id, size, mtime_ms, sidecar_mtime, indexed_size, indexed_lines, tail_hash, parser_state, parser_version, error_count, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      file.path,
      adapter.id,
      st.size,
      st.mtimeMs,
      sidecar,
      lastCompleteEnd,
      completeLines,
      tailHash,
      stateJson,
      parserVersionOf(adapter),
      parseErrors,
    );
    db.exec('COMMIT');
    return { mode, sessionId };
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    const message = err instanceof Error ? err.message : String(err);
    recordFileError(db, adapter, file.path, message);
    throw err;
  }
}

/**
 * Two files can map to the same session id (e.g. a Codex rollout present in both
 * sessions/ and archived_sessions/). The file indexed first keeps the id; others
 * get a path-derived suffix so their rows never mix.
 */
function unclaimedId(db: DatabaseSync, id: string, path: string): string {
  const owner = db.prepare('SELECT file_path FROM sessions WHERE id = ?').get(id) as Row | undefined;
  return owner && owner.file_path !== path ? `${id}~${sha1(Buffer.from(path)).slice(0, 8)}` : id;
}

function recordFileError(db: DatabaseSync, adapter: SourceAdapter, path: string, message: string): void {
  try {
    const upd = db.prepare('UPDATE files SET error = ? WHERE path = ?').run(message, path);
    if (Number(upd.changes) === 0) {
      db.prepare(
        `INSERT INTO files(path, source_id, size, mtime_ms, indexed_size, indexed_lines, parser_version, error)
         VALUES (?, ?, -1, -1, 0, 0, ?, ?)`,
      ).run(path, adapter.id, parserVersionOf(adapter), message);
    }
  } catch {
    /* best effort */
  }
}

function finalizeSession(
  db: DatabaseSync,
  provisionalId: string,
  adapter: SourceAdapter,
  file: DiscoveredFile,
  meta: SessionMeta,
  offBranchSeqs: number[],
  mtimeMs: number,
): string {
  let id = meta.id || provisionalId;
  if (id !== provisionalId && unclaimedId(db, id, file.path) !== id) id = provisionalId;
  if (id !== provisionalId) {
    // adapter chose a different id than `${sourceId}:${nativeId}`: re-key what we inserted
    db.prepare('UPDATE events SET session_id = ? WHERE session_id = ?').run(id, provisionalId);
    db.prepare("UPDATE tool_links SET session_id = ? WHERE session_id = ? AND origin = 'event'").run(id, provisionalId);
  }
  const parentSessionId =
    meta.parentSessionId ?? (file.parentNativeId ? `${adapter.id}:${file.parentNativeId}` : undefined);
  const updatedAt = meta.updatedAt ?? meta.startedAt ?? new Date(mtimeMs).toISOString();

  db.prepare(
    `INSERT OR REPLACE INTO sessions(id, source_id, native_id, file_path, project_key, project_path, title, first_prompt,
       started_at, updated_at, event_count, message_count, image_count, models, cost_usd, input_tokens, output_tokens,
       git_branch, parent_session_id, parent_tool_use_id, agent_description, links)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    meta.sourceId ?? adapter.id,
    meta.nativeId ?? file.nativeId,
    file.path,
    projectKeyFor(meta.projectPath, meta.projectKey ?? file.projectKey),
    meta.projectPath ?? null,
    meta.title ?? null,
    meta.firstPrompt ?? null,
    meta.startedAt ?? null,
    updatedAt,
    meta.eventCount ?? 0,
    meta.messageCount ?? 0,
    meta.imageCount ?? 0,
    JSON.stringify(meta.models ?? []),
    meta.costUSD ?? null,
    meta.inputTokens ?? null,
    meta.outputTokens ?? null,
    meta.gitBranch ?? null,
    parentSessionId ?? null,
    meta.parentToolUseId ?? null,
    meta.agentDescription ?? null,
    JSON.stringify(meta.links ?? []),
  );

  // branch info is recomputed over the whole session every time
  db.prepare('UPDATE events SET off_branch = 0 WHERE session_id = ? AND off_branch = 1').run(id);
  if (offBranchSeqs.length) {
    const upd = db.prepare('UPDATE events SET off_branch = 1 WHERE session_id = ? AND seq = ?');
    for (const seq of offBranchSeqs) upd.run(id, seq);
  }

  if (parentSessionId && meta.parentToolUseId) {
    stmts(db).insLink.run(parentSessionId, meta.parentToolUseId, id, 'sub');
  }
  return id;
}

// ---------------------------------------------------------------------------
// Whole run
// ---------------------------------------------------------------------------

interface Candidate {
  adapter: SourceAdapter;
  file: DiscoveredFile;
}

export async function indexAll(
  db: DatabaseSync,
  adapters: readonly SourceAdapter[],
  roots: RootsMap | undefined,
  onProgress?: (p: IndexProgress) => void,
  opts: IndexOptions = {},
): Promise<IndexResult> {
  const result: IndexResult = { filesTotal: 0, indexed: 0, resumed: 0, skipped: 0, removed: 0, errors: [] };
  const candidates = new Map<string, Candidate>();
  const failedAdapters = new Set<string>();

  for (const adapter of adapters) {
    const adapterRoots = roots?.[adapter.id] ?? adapter.defaultRoots();
    for (const root of adapterRoots) {
      try {
        for (const file of await adapter.discover(root)) {
          if (!candidates.has(file.path)) candidates.set(file.path, { adapter, file });
        }
      } catch (err) {
        failedAdapters.add(adapter.id);
        result.errors.push({ path: root, message: `discover failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
  }

  // deletions
  const adapterIds = new Set(adapters.map((a) => a.id));
  const known = db.prepare('SELECT path, source_id FROM files').all() as Row[];
  for (const r of known) {
    const path = String(r.path);
    const sid = String(r.source_id);
    if (!adapterIds.has(sid) || failedAdapters.has(sid)) continue;
    if (opts.only && !opts.only.has(path)) continue;
    if (!candidates.has(path)) {
      db.exec('BEGIN');
      try {
        removeFileRows(db, path);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      result.removed++;
    }
  }

  let list = [...candidates.values()];
  if (opts.only) list = list.filter((c) => opts.only!.has(c.file.path));
  result.filesTotal = list.length;
  let done = 0;
  onProgress?.({ filesDone: 0, filesTotal: list.length });

  for (const { adapter, file } of list) {
    if (opts.signal?.aborted) break;
    try {
      const out = await indexFile(db, adapter, file);
      if (out.mode === 'skip') result.skipped++;
      else {
        if (out.mode === 'resume') result.resumed++;
        else result.indexed++;
        if (out.sessionId) opts.onSessionUpdated?.(out.sessionId);
      }
    } catch (err) {
      result.errors.push({ path: file.path, message: err instanceof Error ? err.message : String(err) });
    }
    done++;
    onProgress?.({ filesDone: done, filesTotal: list.length, current: file.path });
  }
  if (result.indexed || result.removed) db.exec('PRAGMA incremental_vacuum');
  return result;
}
