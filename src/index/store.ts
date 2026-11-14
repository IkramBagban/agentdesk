import type { ChatEvent, ProjectMeta, SessionMeta, SourceId } from '../core/types.ts';

/**
 * Read API over the SQLite index, consumed by the HTTP server.
 * Implemented in src/index (workstream "index"); the server codes against
 * this interface only. All methods are synchronous (node:sqlite is sync)
 * except where file IO is needed.
 */
export interface IndexStore {
  status(): IndexStatus;

  listProjects(opts: { sourceId?: SourceId }): ProjectMeta[];

  listSessions(opts: {
    sourceId?: SourceId;
    projectKey?: string;
    /** substring match on title / first prompt */
    q?: string;
    includeSubSessions?: boolean;
    cursor?: string;
    limit: number;
  }): Page<SessionMeta>;

  getSession(id: string): SessionMeta | undefined;
  getSubSessions(parentId: string): SessionMeta[];

  /**
   * Locations of events to read, in seq order. The server reads the byte
   * ranges itself and calls the adapter's parseLine (see readEvents).
   * `view: 'conversation'` excludes visibility 'meta'.
   */
  listEventRefs(opts: {
    sessionId: string;
    view: 'conversation' | 'all';
    from: number;
    limit: number;
    direction: 'forward' | 'backward';
  }): { items: EventRef[]; total: number; nextFrom?: number; prevFrom?: number };

  getEventRef(sessionId: string, seq: number): EventRef | undefined;

  /**
   * Human prompts of a session (role 'user', visibility 'conversation',
   * not synthetic), in seq order, with their stored preview text. Feeds
   * the outline spine in the UI. Cap at 2000 items.
   */
  outline(sessionId: string): { seq: number; preview: string; timestamp?: string; offBranch: boolean }[];

  /** tool_use id → sub-session id, for the whole session */
  toolLinks(sessionId: string): Map<string, string>;

  search(opts: {
    q: string;
    sourceId?: SourceId;
    projectKey?: string;
    cursor?: string;
    limit: number;
  }): Page<SearchHit>;

  /** Subscribe to index changes. Returns an unsubscribe fn. */
  onChange(cb: (e: IndexChange) => void): () => void;
}

export interface EventRef {
  sessionId: string;
  seq: number;
  /** index of this event among events produced by the same line (0-based) */
  lineEventIndex: number;
  /** seq of the first event produced by this line */
  lineFirstSeq: number;
  line: number;
  offset: number;
  length: number;
  visibility: ChatEvent['visibility'];
  offBranch: boolean;
}

export interface SearchHit {
  sessionId: string;
  seq: number;
  sessionTitle?: string;
  projectKey: string;
  /** absolute project directory of the hit's session, if known */
  projectPath?: string;
  timestamp?: string;
  role: ChatEvent['role'];
  /**
   * HTML-escaped text with <mark>…</mark> around matches. The store builds it
   * from the stored preview only (may be ''); the server rebuilds it from the
   * source file's event text.
   */
  snippet: string;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

export interface IndexStatus {
  state: 'idle' | 'indexing';
  filesDone: number;
  filesTotal: number;
  sessionCount: number;
  lastError?: string;
}

export type IndexChange =
  | { type: 'progress'; status: IndexStatus }
  | { type: 'session-updated'; sessionId: string };
