import type { DatabaseSync } from 'node:sqlite';
import type { ChatEvent, ProjectMeta, SessionMeta, SessionNode, SourceId } from '../core/types.ts';
import { NO_FOLDER_KEY } from './project.ts';
import { escapeHtml, makeSnippet, sanitizeFtsQuery } from './snippet.ts';
import type { EventRef, IndexChange, IndexStatus, IndexStore, Page, SearchHit } from './store.ts';
import { buildGraph, type GraphNode, type GraphOverlayRow, type GraphSessionRow, type SessionGraph } from './tree.ts';

type Row = Record<string, unknown>;

const MAX_SEARCH_OFFSET = 10_000;

/**
 * bm25() is negative (lower = better); multiplying boosts. Human prompts rank
 * above other conversation (assistant prose, notices), which ranks clearly
 * above 'detail' (tool calls/results, thinking), which otherwise dominate by
 * sheer volume and repetition.
 */
const RANK_BOOST = `(CASE WHEN e.visibility = 'detail' THEN 1.0 WHEN e.role = 'user' AND e.synthetic = 0 THEN 3.0 ELSE 2.5 END)`;

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

function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function displayName(key: string, path: string | undefined): string {
  if (key === NO_FOLDER_KEY) return 'No folder';
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

  /**
   * Spawn graph over top-level sessions + app overlays, rebuilt only when the
   * database changed (data_version covers other connections' commits,
   * total_changes() this connection's own).
   */
  private graphCache: { key: string; graph: SessionGraph } | undefined;
  private graph(): SessionGraph {
    const v = this.db.prepare('SELECT total_changes() AS t').get() as Row;
    const dv = this.db.prepare('PRAGMA data_version').get() as Row;
    const key = `${String(dv.data_version)}:${String(v.t)}`;
    if (this.graphCache?.key === key) return this.graphCache.graph;
    const rows = (
      this.db
        .prepare(
          'SELECT id, source_id, native_id, project_key, project_path, updated_at FROM sessions WHERE parent_session_id IS NULL',
        )
        .all() as Row[]
    ).map((r): GraphSessionRow => {
      const g: GraphSessionRow = {
        id: String(r.id),
        sourceId: String(r.source_id),
        nativeId: String(r.native_id),
        projectKey: String(r.project_key),
        updatedAt: String(r.updated_at ?? ''),
      };
      const pp = optStr(r.project_path);
      if (pp) g.projectPath = pp;
      return g;
    });
    const overlays = (
      this.db
        .prepare('SELECT source_id, native_id, title, parent_native_id, spawn_kind, archived, project_path FROM session_overlays')
        .all() as Row[]
    ).map((r): GraphOverlayRow => {
      const o: GraphOverlayRow = { sourceId: String(r.source_id), nativeId: String(r.native_id) };
      const t = optStr(r.title);
      if (t) o.title = t;
      const p = optStr(r.parent_native_id);
      if (p) o.parentNativeId = p;
      if (r.spawn_kind === 'side' || r.spawn_kind === 'spawned') o.spawnKind = r.spawn_kind;
      if (r.archived != null) o.archived = Number(r.archived) === 1;
      const pp = optStr(r.project_path);
      if (pp) o.projectPath = pp;
      return o;
    });
    const graph = buildGraph(rows, overlays);
    this.graphCache = { key, graph };
    return graph;
  }

  /** Apply what the graph knows (app title, starter, archived, grouping) to a stored session. */
  private overlay(s: SessionMeta, g: SessionGraph = this.graph()): SessionMeta {
    let n = g.nodes.get(s.id);
    if (!n) {
      // sub-agent run: grouped with its parent session
      const parent = s.parentSessionId ? g.nodes.get(s.parentSessionId) : undefined;
      if (parent) s.projectKey = parent.key;
      return s;
    }
    if (n.title) s.title = n.title;
    s.projectKey = n.key;
    if (n.parentId) {
      s.spawnedFromSessionId = n.parentId;
      if (n.spawnKind) s.spawnKind = n.spawnKind;
    }
    if (n.archived) s.archived = true;
    return s;
  }

  listProjects(opts: { sourceId?: SourceId }): ProjectMeta[] {
    // Keys are agent-agnostic (see projectKeyFor), so one folder used by several
    // agents is one project; started sessions count under their root starter's
    // project. The source of the most recently updated session is reported as
    // the project's. Archived sessions are not counted (a project with only
    // archived sessions is still listed, with sessionCount 0).
    const groups = new Map<string, { latest: GraphNode; n: number; path?: string }>();
    for (const node of this.graph().nodes.values()) {
      if (opts.sourceId && node.sourceId !== opts.sourceId) continue;
      const g = groups.get(node.key);
      if (!g) {
        groups.set(node.key, { latest: node, n: node.archived ? 0 : 1, ...(node.path ? { path: node.path } : {}) });
        continue;
      }
      if (!node.archived) g.n++;
      if (node.updatedAt > g.latest.updatedAt) g.latest = node;
      if (node.path && (!g.path || node.path > g.path)) g.path = node.path;
    }
    const list = [...groups.entries()].sort(([ka, a], [kb, b]) =>
      a.latest.updatedAt !== b.latest.updatedAt ? (a.latest.updatedAt < b.latest.updatedAt ? 1 : -1) : ka < kb ? -1 : ka > kb ? 1 : 0,
    );
    return list.map(([key, g]) => {
      const path = key.startsWith('path:') ? key.slice(5) : key === NO_FOLDER_KEY ? undefined : g.path;
      const p: ProjectMeta = {
        key,
        sourceId: g.latest.sourceId,
        displayName: displayName(key, path),
        sessionCount: g.n,
      };
      if (path) p.path = path;
      if (g.latest.updatedAt) p.updatedAt = g.latest.updatedAt;
      return p;
    });
  }

  /** ids whose (app or own) title or first prompt contains `q` */
  private matchQ(q: string): Set<string> {
    const like = `%${likeEscape(q.trim().slice(0, 500))}%`;
    const rows = this.db
      .prepare(
        `SELECT s.id FROM sessions s
         LEFT JOIN session_overlays o ON o.source_id = s.source_id AND o.native_id = s.native_id
         WHERE COALESCE(o.title, s.title) LIKE ?1 ESCAPE '\\' OR s.title LIKE ?1 ESCAPE '\\' OR s.first_prompt LIKE ?1 ESCAPE '\\'`,
      )
      .all(like) as Row[];
    return new Set(rows.map((r) => String(r.id)));
  }

  private fullRows(ids: readonly string[], g: SessionGraph): Map<string, SessionMeta> {
    const out = new Map<string, SessionMeta>();
    if (!ids.length) return out;
    const rows = this.db
      .prepare(`SELECT ${SESSION_COLS} FROM sessions WHERE id IN (SELECT value FROM json_each(?))`)
      .all(JSON.stringify(ids)) as Row[];
    for (const r of rows) out.set(String(r.id), this.overlay(rowToSession(r), g));
    return out;
  }

  listSessions(opts: {
    sourceId?: SourceId;
    projectKey?: string;
    q?: string;
    includeSubSessions?: boolean;
    archived?: 'hide' | 'only' | 'all';
    tree?: boolean;
    cursor?: string;
    limit: number;
  }): Page<SessionNode> {
    const g = this.graph();
    const archived = opts.archived === 'only' || opts.archived === 'all' ? opts.archived : 'hide';
    const qIds = opts.q?.trim() ? this.matchQ(opts.q) : undefined;
    const limit = Math.max(1, Math.min(opts.limit, 500));
    const cur = unb64<{ u: string; i: string }>(opts.cursor);
    const after = cur && typeof cur.u === 'string' && typeof cur.i === 'string' ? cur : undefined;
    // (u, id) DESC order and keyset, comparing like SQLite's binary collation
    const desc = (a: { u: string; i: string }, b: { u: string; i: string }) =>
      a.u !== b.u ? (a.u < b.u ? 1 : -1) : a.i < b.i ? 1 : a.i > b.i ? -1 : 0;
    const isAfter = (x: { u: string; i: string }) => !after || x.u < after.u || (x.u === after.u && x.i < after.i);

    const pass = (sourceId: string, key: string, isArchived: boolean, id: string) =>
      (!opts.sourceId || sourceId === opts.sourceId) &&
      (!opts.projectKey || key === opts.projectKey) &&
      (archived === 'all' || (archived === 'only') === isArchived) &&
      (!qIds || qIds.has(id));

    const included = new Map<string, GraphNode>();
    for (const n of g.nodes.values()) if (pass(n.sourceId, n.key, n.archived, n.id)) included.set(n.id, n);

    if (!opts.tree) {
      const items: { u: string; i: string }[] = [...included.values()].map((n) => ({ u: n.updatedAt, i: n.id }));
      if (opts.includeSubSessions) {
        const subs = this.db
          .prepare('SELECT id, source_id, project_key, updated_at, parent_session_id FROM sessions WHERE parent_session_id IS NOT NULL')
          .all() as Row[];
        for (const r of subs) {
          const parent = g.nodes.get(String(r.parent_session_id));
          const id = String(r.id);
          if (pass(String(r.source_id), parent?.key ?? String(r.project_key), parent?.archived ?? false, id)) {
            items.push({ u: String(r.updated_at ?? ''), i: id });
          }
        }
      }
      const sorted = items.filter(isAfter).sort(desc);
      const page = sorted.slice(0, limit);
      const full = this.fullRows(page.map((p) => p.i), g);
      const out: Page<SessionNode> = {
        items: page.flatMap((p) => {
          const m = full.get(p.i);
          return m ? [{ ...m, children: [], ...(m.updatedAt ? { activityAt: m.updatedAt } : {}) }] : [];
        }),
      };
      const last = page[page.length - 1];
      if (sorted.length > limit && last) out.nextCursor = b64({ u: last.u, i: last.i });
      return out;
    }

    // tree: a session is a root unless its starter is included too
    const kids = new Map<string, GraphNode[]>();
    const roots: GraphNode[] = [];
    for (const n of included.values()) {
      if (n.parentId && included.has(n.parentId)) {
        const k = kids.get(n.parentId);
        if (k) k.push(n);
        else kids.set(n.parentId, [n]);
      } else roots.push(n);
    }
    const activity = new Map<string, string>();
    const activityOf = (root: GraphNode): string => {
      // iterative post-order (the graph is acyclic; `seen` is a belt-and-braces guard)
      const stack: [GraphNode, boolean][] = [[root, false]];
      const seen = new Set<string>();
      while (stack.length) {
        const [n, expanded] = stack.pop()!;
        if (expanded) {
          let a = n.updatedAt;
          for (const c of kids.get(n.id) ?? []) {
            const ca = activity.get(c.id) ?? c.updatedAt;
            if (ca > a) a = ca;
          }
          activity.set(n.id, a);
          continue;
        }
        if (seen.has(n.id)) continue;
        seen.add(n.id);
        stack.push([n, true]);
        for (const c of kids.get(n.id) ?? []) if (!seen.has(c.id)) stack.push([c, false]);
      }
      return activity.get(root.id) ?? root.updatedAt;
    };
    const ranked = roots.map((r) => ({ u: activityOf(r), i: r.id })).filter(isAfter).sort(desc);
    const page = ranked.slice(0, limit);

    // collect every node in the page's subtrees, then load their rows in one query
    const want: string[] = [];
    const seen = new Set<string>();
    const stack = page.map((p) => p.i);
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      want.push(id);
      for (const c of kids.get(id) ?? []) stack.push(c.id);
    }
    const full = this.fullRows(want, g);
    const built = new Set<string>();
    const build = (id: string): SessionNode | undefined => {
      const m = full.get(id);
      if (!m || built.has(id)) return undefined;
      built.add(id);
      const children = (kids.get(id) ?? [])
        .map((c) => ({ u: activity.get(c.id) ?? c.updatedAt, i: c.id }))
        .sort(desc)
        .flatMap((c) => {
          const b = build(c.i);
          return b ? [b] : [];
        });
      const a = activity.get(id) ?? m.updatedAt;
      return { ...m, children, ...(a ? { activityAt: a } : {}) };
    };
    const out: Page<SessionNode> = { items: page.flatMap((p) => { const b = build(p.i); return b ? [b] : []; }) };
    const last = page[page.length - 1];
    if (ranked.length > limit && last) out.nextCursor = b64({ u: last.u, i: last.i });
    return out;
  }

  getSession(id: string): SessionMeta | undefined {
    const r = this.db.prepare(`SELECT ${SESSION_COLS} FROM sessions WHERE id = ?`).get(id) as Row | undefined;
    return r ? this.overlay(rowToSession(r)) : undefined;
  }

  getSubSessions(parentId: string): SessionMeta[] {
    const rows = this.db
      .prepare(`SELECT ${SESSION_COLS} FROM sessions WHERE parent_session_id = ? ORDER BY started_at, id`)
      .all(parentId) as Row[];
    const g = this.graph();
    return rows.map((r) => this.overlay(rowToSession(r), g));
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
    const offset = Math.min(MAX_SEARCH_OFFSET, Math.max(0, Number(unb64<{ o: number }>(opts.cursor)?.o) || 0));
    const where = ['events_fts MATCH ?'];
    const params: (string | number)[] = [match];
    if (opts.sourceId) {
      where.push('s.source_id = ?');
      params.push(opts.sourceId);
    }
    const g = this.graph();
    if (opts.projectKey) {
      // effective project (started sessions follow their root; sub-agent runs their parent)
      const ids = [...g.nodes.values()].filter((n) => n.key === opts.projectKey).map((n) => n.id);
      where.push('COALESCE(s.parent_session_id, s.id) IN (SELECT value FROM json_each(?))');
      params.push(JSON.stringify(ids));
    }
    // Copies of the same record (forked / resumed sessions, sub-agent files copied
    // into each fork) share a dkey: keep one hit per dkey, preferring the on-branch
    // copy in the most recently updated session. The MATCH expression comes from
    // sanitizeFtsQuery (every term quoted), so it cannot be a syntax error.
    const ranked = this.db
      .prepare(
        `WITH m AS (
           SELECT e.id AS eid, e.session_id, e.seq, e.role, e.ts, e.preview, e.off_branch, e.dkey,
                  s.title, s.project_key, s.project_path, s.updated_at, s.parent_session_id,
                  bm25(events_fts) * ${RANK_BOOST} AS rank
           FROM events_fts JOIN events e ON e.id = events_fts.rowid JOIN sessions s ON s.id = e.session_id
           WHERE ${where.join(' AND ')}
         ), d AS (
           SELECT *, row_number() OVER (PARTITION BY COALESCE(dkey, -eid) ORDER BY off_branch, updated_at DESC, eid) AS copy
           FROM m
         )
         SELECT eid, session_id, seq, role, ts, preview, title, project_key, project_path, parent_session_id FROM d
         WHERE copy = 1
         ORDER BY rank, COALESCE(ts, updated_at) DESC, eid
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit + 1, offset) as Row[];
    const more = ranked.length > limit;
    const page = more ? ranked.slice(0, limit) : ranked;
    const items: SearchHit[] = page.map((r) => {
      const preview = optStr(r.preview);
      const node = g.nodes.get(String(r.session_id));
      const owner = node ?? g.nodes.get(String(r.parent_session_id ?? ''));
      const hit: SearchHit = {
        sessionId: String(r.session_id),
        seq: Number(r.seq),
        projectKey: owner?.key ?? String(r.project_key),
        role: String(r.role) as ChatEvent['role'],
        // provisional: the server rebuilds it from the source file (see /api/search)
        snippet: preview ? (makeSnippet(preview, opts.q) ?? escapeHtml(preview)) : '',
      };
      const t = node?.title ?? optStr(r.title);
      if (t) hit.sessionTitle = t;
      const pp = optStr(r.project_path);
      if (pp && r.project_key !== NO_FOLDER_KEY) hit.projectPath = pp;
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
