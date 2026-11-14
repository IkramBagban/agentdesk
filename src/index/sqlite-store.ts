import type { DatabaseSync } from 'node:sqlite';
import type { ChatEvent, ProjectMeta, SessionMeta, SourceId } from '../core/types.ts';
import type { EventRef, IndexChange, IndexStatus, IndexStore, Page, SearchHit } from './store.ts';

type Row = Record<string, unknown>;

const MARK_OPEN = '';
const MARK_CLOSE = '';

const SESSION_COLS = `id, source_id, native_id, file_path, project_key, project_path, title, first_prompt, started_at,
  updated_at, event_count, message_count, image_count, models, cost_usd, input_tokens, output_tokens, git_branch,
  parent_session_id, parent_tool_use_id, agent_description, links`;

const optStr = (v: unknown): string | undefined => (v == null || v === '' ? undefined : String(v));
const optNum = (v: unknown): number | undefined => (v == null ? undefined : Number(v));

function parseJson<T>(v: unknown, fallback: T): T {
  try {
    return typeof v === 'string' ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

function rowToSession(r: Row): SessionMeta {
  const s: SessionMeta = {
    id: String(r.id),
    sourceId: String(r.source_id),
    nativeId: String(r.native_id),
    filePath: String(r.file_path),
    projectKey: String(r.project_key),
    eventCount: Number(r.event_count),
    messageCount: Number(r.message_count),
    imageCount: Number(r.image_count),
    models: parseJson<string[]>(r.models, []),
    links: parseJson<SessionMeta['links']>(r.links, []),
  };
  const set = <K extends keyof SessionMeta>(k: K, v: SessionMeta[K] | undefined) => {
    if (v !== undefined) s[k] = v;
  };
  set('projectPath', optStr(r.project_path));
  set('title', optStr(r.title));
  set('firstPrompt', optStr(r.first_prompt));
  set('startedAt', optStr(r.started_at));
  set('updatedAt', optStr(r.updated_at));
  set('costUSD', optNum(r.cost_usd));
  set('inputTokens', optNum(r.input_tokens));
  set('outputTokens', optNum(r.output_tokens));
  set('gitBranch', optStr(r.git_branch));
  set('parentSessionId', optStr(r.parent_session_id));
  set('parentToolUseId', optStr(r.parent_tool_use_id));
  set('agentDescription', optStr(r.agent_description));
  return s;
}

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
function unb64<T>(s: string | undefined): T | undefined {
  if (!s) return undefined;
  try {
    return JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as T;
  } catch {
    return undefined;
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Turn free text into a safe FTS5 query: every term quoted (so operators and
 * syntax characters are literal), implicit AND, prefix match on the last term.
 * Returns undefined when nothing searchable remains.
 */
export function sanitizeFtsQuery(q: string): string | undefined {
  const tokens = q
    .replace(/\0/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/"/g, ''))
    .filter((t) => /[\p{L}\p{N}]/u.test(t))
    .slice(0, 16);
  if (!tokens.length) return undefined;
  return tokens.map((t, i) => `"${t}"${i === tokens.length - 1 ? '*' : ''}`).join(' ');
}

function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function displayName(key: string, path: string | undefined): string {
  if (path) {
    const parts = path.split(/[\\/]+/).filter(Boolean);
    if (parts.length) return parts[parts.length - 1] as string;
  }
  return key.replace(/^-+/, '') || key;
}

export class SqliteIndexStore implements IndexStore {
  private listeners = new Set<(e: IndexChange) => void>();
  private progress = { state: 'idle' as IndexStatus['state'], filesDone: 0, filesTotal: 0, lastError: undefined as string | undefined };

  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** Feed a worker message / IndexChange into the store (updates status and notifies subscribers). */
  publish(e: IndexChange): void {
    if (e.type === 'progress') {
      this.progress = {
        state: e.status.state,
        filesDone: e.status.filesDone,
        filesTotal: e.status.filesTotal,
        lastError: e.status.lastError,
      };
    }
    for (const cb of [...this.listeners]) {
      try {
        cb(e);
      } catch {
        /* subscriber errors must not break indexing */
      }
    }
  }

  status(): IndexStatus {
    const row = this.db.prepare('SELECT count(*) AS n FROM sessions WHERE parent_session_id IS NULL').get() as Row;
    const st: IndexStatus = {
      state: this.progress.state,
      filesDone: this.progress.filesDone,
      filesTotal: this.progress.filesTotal,
      sessionCount: Number(row.n),
    };
    if (this.progress.lastError) st.lastError = this.progress.lastError;
    return st;
  }

  listProjects(opts: { sourceId?: SourceId }): ProjectMeta[] {
    const rows = this.db
      .prepare(
        `SELECT source_id, project_key, max(project_path) AS project_path, count(*) AS n, max(updated_at) AS updated_at
         FROM sessions WHERE parent_session_id IS NULL AND (?1 IS NULL OR source_id = ?1)
         GROUP BY source_id, project_key ORDER BY max(updated_at) DESC, project_key`,
      )
      .all(opts.sourceId ?? null) as Row[];
    return rows.map((r) => {
      const path = optStr(r.project_path);
      const p: ProjectMeta = {
        key: String(r.project_key),
        sourceId: String(r.source_id),
        displayName: displayName(String(r.project_key), path),
        sessionCount: Number(r.n),
      };
      if (path) p.path = path;
      const u = optStr(r.updated_at);
      if (u) p.updatedAt = u;
      return p;
    });
  }

  listSessions(opts: {
    sourceId?: SourceId;
    projectKey?: string;
    q?: string;
    includeSubSessions?: boolean;
    cursor?: string;
    limit: number;
  }): Page<SessionMeta> {
    const where: string[] = [];
    const params: (string | number | null)[] = [];
    if (opts.sourceId) {
      where.push('source_id = ?');
      params.push(opts.sourceId);
    }
    if (opts.projectKey) {
      where.push('project_key = ?');
      params.push(opts.projectKey);
    }
    if (!opts.includeSubSessions) where.push('parent_session_id IS NULL');
    if (opts.q?.trim()) {
      const like = `%${likeEscape(opts.q.trim())}%`;
      where.push("(title LIKE ? ESCAPE '\\' OR first_prompt LIKE ? ESCAPE '\\')");
      params.push(like, like);
    }
    const cur = unb64<{ u: string; i: string }>(opts.cursor);
    if (cur && typeof cur.u === 'string' && typeof cur.i === 'string') {
      where.push('(updated_at, id) < (?, ?)');
      params.push(cur.u, cur.i);
    }
    const limit = Math.max(1, Math.min(opts.limit, 500));
    const sql = `SELECT ${SESSION_COLS} FROM sessions ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY updated_at DESC, id DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...params, limit + 1) as Row[];
    const more = rows.length > limit;
    const page = more ? rows.slice(0, limit) : rows;
    const out: Page<SessionMeta> = { items: page.map(rowToSession) };
    if (more) {
      const last = page[page.length - 1] as Row;
      out.nextCursor = b64({ u: String(last.updated_at), i: String(last.id) });
    }
    return out;
  }

  getSession(id: string): SessionMeta | undefined {
    const r = this.db.prepare(`SELECT ${SESSION_COLS} FROM sessions WHERE id = ?`).get(id) as Row | undefined;
    return r ? rowToSession(r) : undefined;
  }

  getSubSessions(parentId: string): SessionMeta[] {
    const rows = this.db
      .prepare(`SELECT ${SESSION_COLS} FROM sessions WHERE parent_session_id = ? ORDER BY started_at, id`)
      .all(parentId) as Row[];
    return rows.map(rowToSession);
  }

  listEventRefs(opts: {
    sessionId: string;
    view: 'conversation' | 'all';
    from: number;
    limit: number;
    direction: 'forward' | 'backward';
  }): { items: EventRef[]; total: number; nextFrom?: number; prevFrom?: number } {
    // literal predicate must match the partial index definition
    const vis = opts.view === 'conversation' ? "AND visibility != 'meta'" : '';
    const limit = Math.max(1, Math.min(opts.limit, 1000));
    const sid = opts.sessionId;
    const cols = 'session_id, seq, line_first_seq, line, offset, length, visibility, off_branch';
    const total = Number(
      (this.db.prepare(`SELECT count(*) AS n FROM events WHERE session_id = ? ${vis}`).get(sid) as Row).n,
    );
    const from = Number.isFinite(opts.from) ? opts.from : 0;
    let rows: Row[];
    let hasMore: boolean;
    if (opts.direction === 'forward') {
      rows = this.db
        .prepare(`SELECT ${cols} FROM events WHERE session_id = ? ${vis} AND seq >= ? ORDER BY seq ASC LIMIT ?`)
        .all(sid, from, limit + 1) as Row[];
      hasMore = rows.length > limit;
      if (hasMore) rows = rows.slice(0, limit);
    } else {
      rows = this.db
        .prepare(`SELECT ${cols} FROM events WHERE session_id = ? ${vis} AND seq < ? ORDER BY seq DESC LIMIT ?`)
        .all(sid, from, limit + 1) as Row[];
      hasMore = rows.length > limit;
      if (hasMore) rows = rows.slice(0, limit);
      rows.reverse();
    }
    const items = rows.map((r) => this.rowToRef(r));
    const out: { items: EventRef[]; total: number; nextFrom?: number; prevFrom?: number } = { items, total };
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) {
      // empty page: still tell the caller about neighbours relative to `from`
      if (opts.direction === 'backward' && this.exists(sid, vis, 'seq >= ?', from)) out.nextFrom = from;
      return out;
    }
    if (opts.direction === 'forward') {
      if (hasMore) out.nextFrom = last.seq + 1;
      if (this.exists(sid, vis, 'seq < ?', first.seq)) out.prevFrom = first.seq;
    } else {
      if (hasMore) out.prevFrom = first.seq;
      if (this.exists(sid, vis, 'seq > ?', last.seq)) out.nextFrom = last.seq + 1;
    }
    return out;
  }

  private exists(sid: string, vis: string, cond: string, arg: number): boolean {
    return !!this.db.prepare(`SELECT 1 FROM events WHERE session_id = ? ${vis} AND ${cond} LIMIT 1`).get(sid, arg);
  }

  private rowToRef(r: Row): EventRef {
    const seq = Number(r.seq);
    const lineFirstSeq = Number(r.line_first_seq);
    return {
      sessionId: String(r.session_id),
      seq,
      lineEventIndex: seq - lineFirstSeq,
      lineFirstSeq,
      line: Number(r.line),
      offset: Number(r.offset),
      length: Number(r.length),
      visibility: String(r.visibility) as ChatEvent['visibility'],
      offBranch: Number(r.off_branch) === 1,
    };
  }

  getEventRef(sessionId: string, seq: number): EventRef | undefined {
    const r = this.db
      .prepare(
        'SELECT session_id, seq, line_first_seq, line, offset, length, visibility, off_branch FROM events WHERE session_id = ? AND seq = ?',
      )
      .get(sessionId, seq) as Row | undefined;
    return r ? this.rowToRef(r) : undefined;
  }

  outline(sessionId: string): { seq: number; preview: string; timestamp?: string; offBranch: boolean }[] {
    const rows = this.db
      .prepare(
        `SELECT seq, preview, ts, off_branch FROM events
         WHERE session_id = ? AND role = 'user' AND visibility = 'conversation' AND synthetic = 0
         ORDER BY seq LIMIT 2000`,
      )
      .all(sessionId) as Row[];
    return rows.map((r) => {
      const o: { seq: number; preview: string; timestamp?: string; offBranch: boolean } = {
        seq: Number(r.seq),
        preview: optStr(r.preview) ?? '',
        offBranch: Number(r.off_branch) === 1,
      };
      const t = optStr(r.ts);
      if (t) o.timestamp = t;
      return o;
    });
  }

  toolLinks(sessionId: string): Map<string, string> {
    const rows = this.db.prepare('SELECT tool_use_id, sub_session_id FROM tool_links WHERE session_id = ?').all(sessionId) as Row[];
    return new Map(rows.map((r) => [String(r.tool_use_id), String(r.sub_session_id)]));
  }

  /** Search pagination is offset-based (bm25 ranking has no stable keyset); cursor = base64 {o}. */
  search(opts: { q: string; sourceId?: SourceId; projectKey?: string; cursor?: string; limit: number }): Page<SearchHit> {
    const match = sanitizeFtsQuery(opts.q);
    if (!match) return { items: [] };
    const limit = Math.max(1, Math.min(opts.limit, 200));
    const offset = Math.max(0, unb64<{ o: number }>(opts.cursor)?.o ?? 0);
    const where = ['events_fts MATCH ?'];
    const params: (string | number)[] = [match];
    if (opts.sourceId) {
      where.push('s.source_id = ?');
      params.push(opts.sourceId);
    }
    if (opts.projectKey) {
      where.push('s.project_key = ?');
      params.push(opts.projectKey);
    }
    let ranked: Row[];
    try {
      ranked = this.db
        .prepare(
          `SELECT e.id AS eid, e.session_id, e.seq, e.role, e.ts, s.title, s.project_key
           FROM events_fts JOIN events e ON e.id = events_fts.rowid JOIN sessions s ON s.id = e.session_id
           WHERE ${where.join(' AND ')}
           ORDER BY bm25(events_fts), COALESCE(e.ts, s.updated_at) DESC, e.id
           LIMIT ? OFFSET ?`,
        )
        .all(...params, limit + 1, offset) as Row[];
    } catch {
      return { items: [] };
    }
    const more = ranked.length > limit;
    const page = more ? ranked.slice(0, limit) : ranked;
    const snippets = new Map<number, string>();
    if (page.length) {
      const ids = page.map((r) => Number(r.eid));
      const rows = this.db
        .prepare(
          `SELECT rowid AS rid, snippet(events_fts, 0, '${MARK_OPEN}', '${MARK_CLOSE}', '…', 24) AS snip
           FROM events_fts WHERE events_fts MATCH ? AND rowid IN (${ids.map(() => '?').join(',')})`,
        )
        .all(match, ...ids) as Row[];
      for (const r of rows) snippets.set(Number(r.rid), String(r.snip ?? ''));
    }
    const items: SearchHit[] = page.map((r) => {
      const snippet = escapeHtml(snippets.get(Number(r.eid)) ?? '')
        .split(MARK_OPEN).join('<mark>')
        .split(MARK_CLOSE).join('</mark>');
      const hit: SearchHit = {
        sessionId: String(r.session_id),
        seq: Number(r.seq),
        projectKey: String(r.project_key),
        role: String(r.role) as ChatEvent['role'],
        snippet,
      };
      const t = optStr(r.title);
      if (t) hit.sessionTitle = t;
      const ts = optStr(r.ts);
      if (ts) hit.timestamp = ts;
      return hit;
    });
    const out: Page<SearchHit> = { items };
    if (more) out.nextCursor = b64({ o: offset + limit });
    return out;
  }

  onChange(cb: (e: IndexChange) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}
