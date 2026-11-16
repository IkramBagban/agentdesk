/**
 * Session metadata kept by the Claude desktop app OUTSIDE the Claude Code chat
 * files: display titles, archived state and which session started which.
 *
 * Undocumented internal format, read defensively and READ-ONLY:
 *   <app dir>/claude-code-sessions/<accountId>/<orgId>/local_<uuid>.json
 * Fields used: sessionId ("local_…", the app's id), cliSessionId (the Claude
 * Code session file name = our native id), title, isArchived, createdAt (ms),
 * cwd, originCwd, worktreePath, spawnedFrom {sessionId, userFork, btw},
 * forkedFromSessionId. Anything else is ignored; files that fail to
 * parse are skipped.
 */
import { existsSync, statSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { OverlayResult, SessionOverlay } from '../../core/adapter.ts';

const SESSIONS_DIR = 'claude-code-sessions';
const READ_CONCURRENCY = 32;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TITLE = 500;

/** Placeholder titles the app shows before a real one exists. */
const GENERIC_TITLES = new Set(['new session', 'new chat', 'new conversation', 'untitled', 'untitled session']);

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Candidate Claude app folders for this platform. `AGENTDESK_CLAUDE_APP_DIR`
 * overrides them (it may point at the app folder or at its
 * claude-code-sessions folder).
 */
function appDirCandidates(): string[] {
  const env = process.env.AGENTDESK_CLAUDE_APP_DIR;
  if (env) return [env];
  const home = homedir();
  const out: string[] = [];
  if (process.platform === 'darwin') out.push(join(home, 'Library', 'Application Support', 'Claude'));
  else if (process.platform === 'win32') {
    if (process.env.APPDATA) out.push(join(process.env.APPDATA, 'Claude'));
    out.push(join(home, 'AppData', 'Roaming', 'Claude'));
  } else {
    if (process.env.XDG_CONFIG_HOME) out.push(join(process.env.XDG_CONFIG_HOME, 'Claude'));
    out.push(join(home, '.config', 'Claude'));
  }
  return out;
}

/** The claude-code-sessions folders that exist (deduplicated). */
export function claudeAppSessionDirs(): string[] {
  const out: string[] = [];
  for (const c of appDirCandidates()) {
    const d = isDir(join(c, SESSIONS_DIR)) ? join(c, SESSIONS_DIR) : process.env.AGENTDESK_CLAUDE_APP_DIR && isDir(c) ? c : undefined;
    if (d && !out.includes(d)) out.push(d);
  }
  return out;
}

async function subdirs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

/** local_*.json files at <dir>/<account>/<org>/ (every account and org). */
async function listSessionFiles(dir: string): Promise<string[]> {
  const orgs = (await Promise.all((await subdirs(dir)).map(subdirs))).flat();
  const lists = await Promise.all(
    orgs.map(async (o) => {
      try {
        return (await readdir(o, { withFileTypes: true }))
          .filter((e) => e.isFile() && e.name.startsWith('local_') && e.name.endsWith('.json'))
          .map((e) => join(o, e.name));
      } catch {
        return [];
      }
    }),
  );
  return lists.flat();
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

type Json = Record<string, unknown>;

async function readJson(path: string): Promise<Json | undefined> {
  try {
    const buf = await readFile(path);
    if (buf.length > MAX_FILE_BYTES) return undefined;
    const v: unknown = JSON.parse(buf.toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined;
  } catch {
    return undefined;
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
const obj = (v: unknown): Json | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined);

function msToIso(v: unknown): string | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function isGenericTitle(t: string): boolean {
  return GENERIC_TITLES.has(t.trim().toLowerCase());
}

interface AppRecord {
  localId: string;
  cliId: string;
  activity: number;
  overlay: SessionOverlay;
  parentLocalId?: string;
}

function toRecord(j: Json): AppRecord | undefined {
  const localId = str(j.sessionId);
  const cliId = str(j.cliSessionId);
  if (!localId || !cliId) return undefined;
  const o: SessionOverlay = {};
  const title = str(j.title)?.trim();
  if (title && !isGenericTitle(title)) o.title = title.slice(0, MAX_TITLE);
  if (typeof j.isArchived === 'boolean') o.archived = j.isArchived;
  const created = msToIso(j.createdAt);
  if (created) o.createdAt = created;
  // Group the chat where the app shows it: a worktree session under the repo it
  // came from (originCwd); otherwise the app's current folder, which differs from
  // the chat file's cwd when a chat was moved to a project after it started.
  // Throwaway scratch folders are left alone (they group as "No folder").
  const cwd = str(j.cwd);
  const origin = str(j.originCwd);
  const scratch = (p?: string) => !!p && /[\\/]Claude[\\/]scratch-workspaces[\\/]/.test(p);
  const place = str(j.worktreePath) || (cwd && origin && cwd !== origin) ? origin : (cwd ?? origin);
  if (place && !scratch(place) && !scratch(cwd)) o.projectPath = place;

  const rec: AppRecord = { localId, cliId, activity: Number(j.lastActivityAt ?? j.createdAt) || 0, overlay: o };
  const spawned = obj(j.spawnedFrom);
  const spawnParent = str(spawned?.sessionId);
  const forkParent = str(j.forkedFromSessionId);
  if (spawnParent) {
    rec.parentLocalId = spawnParent;
    // The app sets sideSession: true on every spawned session (also tasks started
    // with "start session"), so it can't tell them apart. User forks and "btw"
    // side questions carry their own flags (present only when true).
    const s = spawned as Json;
    const side = s.userFork === true || s.btw === true;
    o.spawnKind = side ? 'side' : 'spawned';
  } else if (forkParent) {
    rec.parentLocalId = forkParent;
    o.spawnKind = 'side';
  }
  return rec;
}

/** Read the app's session metadata from `dirs` (claude-code-sessions folders). */
export async function readClaudeAppOverlays(dirs: readonly string[] = claudeAppSessionDirs()): Promise<OverlayResult> {
  const entries = new Map<string, SessionOverlay>();
  const watchPaths = dirs.filter((d) => existsSync(d));
  try {
    const files = (await Promise.all(watchPaths.map(listSessionFiles))).flat();
    const json = await mapLimit(files, READ_CONCURRENCY, readJson);
    // one record per cli session; with duplicates (several accounts) the most recently active wins
    const byCli = new Map<string, AppRecord>();
    const byLocal = new Map<string, AppRecord>();
    for (const j of json) {
      const r = j ? toRecord(j) : undefined;
      if (!r) continue;
      byLocal.set(r.localId, r);
      const prev = byCli.get(r.cliId);
      if (!prev || r.activity > prev.activity) byCli.set(r.cliId, r);
    }
    for (const [cliId, r] of byCli) {
      const o = { ...r.overlay };
      const parent = r.parentLocalId ? byLocal.get(r.parentLocalId) : undefined;
      if (parent && parent.cliId !== cliId) o.parentNativeId = parent.cliId;
      else delete o.spawnKind;
      if (Object.keys(o).length) entries.set(cliId, o);
    }
  } catch {
    /* best effort: unknown layout → whatever we got so far */
  }
  return { entries, watchPaths };
}
