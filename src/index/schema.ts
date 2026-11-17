import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Bump when ANY table layout or the way rows are derived changes. A mismatch
 * deletes the database file and rebuilds from scratch.
 */
export const SCHEMA_VERSION = 5;

const DDL = `
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS files (
  path           TEXT PRIMARY KEY,
  source_id      TEXT NOT NULL,
  size           INTEGER NOT NULL,   -- file size observed when indexing started
  mtime_ms       REAL NOT NULL,
  sidecar_mtime  REAL,               -- mtime of DiscoveredFile.extra.metaPath (null: absent); a change forces re-index
  indexed_size   INTEGER NOT NULL,   -- byte offset just after the last COMPLETE line
  indexed_lines  INTEGER NOT NULL,   -- number of complete lines consumed (== next line number)
  tail_hash      TEXT,               -- sha1 of the <=256 bytes before indexed_size (append sanity check)
  parser_state   TEXT,               -- JSON snapshot taken at indexed_size
  parser_version TEXT NOT NULL,
  error_count    INTEGER NOT NULL DEFAULT 0,  -- lines the parser threw on
  error          TEXT                -- last file-level error, if any
);

CREATE TABLE IF NOT EXISTS sessions (
  id                 TEXT PRIMARY KEY,
  source_id          TEXT NOT NULL,
  native_id          TEXT NOT NULL,
  file_path          TEXT NOT NULL,
  project_key        TEXT NOT NULL,      -- agent-agnostic, see projectKeyFor() in indexer.ts
  project_path       TEXT,
  title              TEXT,
  first_prompt       TEXT,
  started_at         TEXT,
  updated_at         TEXT NOT NULL DEFAULT '',  -- '' when unknown (sorts last)
  event_count        INTEGER NOT NULL DEFAULT 0,
  message_count      INTEGER NOT NULL DEFAULT 0,
  image_count        INTEGER NOT NULL DEFAULT 0,
  models             TEXT NOT NULL DEFAULT '[]',
  cost_usd           REAL,
  input_tokens       INTEGER,
  output_tokens      INTEGER,
  git_branch         TEXT,
  parent_session_id  TEXT,
  parent_tool_use_id TEXT,
  agent_description  TEXT,
  links              TEXT NOT NULL DEFAULT '[]',
  forked_at_seq      INTEGER             -- SessionMeta.forkedAtSeq, derived from events.inherited
);
CREATE INDEX IF NOT EXISTS sessions_updated ON sessions(updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS sessions_project ON sessions(project_key, updated_at DESC);
CREATE INDEX IF NOT EXISTS sessions_parent ON sessions(parent_session_id);
CREATE INDEX IF NOT EXISTS sessions_file ON sessions(file_path);
CREATE INDEX IF NOT EXISTS sessions_source ON sessions(source_id, updated_at DESC);

-- id is the rowid and doubles as the events_fts rowid.
CREATE TABLE IF NOT EXISTS events (
  id             INTEGER PRIMARY KEY,
  session_id     TEXT NOT NULL,
  seq            INTEGER NOT NULL,
  line           INTEGER NOT NULL,
  offset         INTEGER NOT NULL,
  length         INTEGER NOT NULL,
  line_first_seq INTEGER NOT NULL,
  role           TEXT NOT NULL,
  visibility     TEXT NOT NULL,
  ts             TEXT,
  off_branch     INTEGER NOT NULL DEFAULT 0,
  synthetic      INTEGER NOT NULL DEFAULT 0,
  inherited      INTEGER NOT NULL DEFAULT 0,  -- ChatEvent.inherited (copied from another session)
  preview        TEXT,               -- 'conversation' events only (outline, snippet fallback)
  dkey           INTEGER             -- copy-detection key (hash of source + record uuid + index in line); see search()
);
CREATE UNIQUE INDEX IF NOT EXISTS events_session_seq ON events(session_id, seq);
-- serves view=conversation (visibility != 'meta') in seq order; the query must use the same predicate
CREATE INDEX IF NOT EXISTS events_session_nonmeta ON events(session_id, seq) WHERE visibility != 'meta';

CREATE TABLE IF NOT EXISTS tool_links (
  session_id     TEXT NOT NULL,
  tool_use_id    TEXT NOT NULL,
  sub_session_id TEXT NOT NULL,
  origin         TEXT NOT NULL,  -- 'event' (ToolUseBlock.subSessionId in session_id) | 'sub' (declared by the sub-agent session)
  PRIMARY KEY (session_id, tool_use_id, origin)
);
CREATE INDEX IF NOT EXISTS tool_links_sub ON tool_links(sub_session_id);

-- Per-session metadata from the agent's own app (SourceAdapter.overlays()),
-- refreshed on every scan and when its files change, independently of chat
-- files. Keyed by '<source>:<native id>' (the session id it applies to);
-- rows may exist for sessions that are not indexed (yet).
CREATE TABLE IF NOT EXISTS session_overlays (
  session_id        TEXT PRIMARY KEY,
  source_id         TEXT NOT NULL,
  native_id         TEXT NOT NULL,
  title             TEXT,
  parent_native_id  TEXT,              -- native id of the session that started this one
  spawn_kind        TEXT,              -- 'spawned' | 'side'
  archived          INTEGER,           -- 1 / 0 / NULL (unknown)
  project_path      TEXT,              -- folder to group under (e.g. the repo of a worktree)
  created_at        TEXT
);
CREATE INDEX IF NOT EXISTS session_overlays_native ON session_overlays(source_id, native_id);

-- rowid == events.id. Contentless: stores only the inverted index; snippets are
-- rebuilt from the source file (see src/index/snippet.ts).
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
  text,
  content = '',
  contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2'
);
`;

function applyPragmas(db: DatabaseSync): void {
  db.exec('PRAGMA busy_timeout = 10000');
  db.exec('PRAGMA auto_vacuum = INCREMENTAL'); // only takes effect on a new, empty DB
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
}

function readVersion(db: DatabaseSync): number | undefined {
  try {
    const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get();
    return row ? Number(row.version) : undefined;
  } catch {
    return undefined;
  }
}

function removeDbFiles(path: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(path + suffix, { force: true });
}

export interface OpenOptions {
  /** Reader connections never create/rebuild the schema and are `query_only`. */
  reader?: boolean;
}

/**
 * Open the index DB.
 * - writer (default): creates the directory, rebuilds the DB on schema_version
 *   mismatch, creates tables. Call this once (in the main thread via
 *   `prepareDb`, before the worker starts) so that rebuilds never race a reader.
 * - reader: plain connection with `PRAGMA query_only`.
 */
export function openDb(path: string, opts: OpenOptions = {}): DatabaseSync {
  if (opts.reader) {
    const db = new DatabaseSync(path);
    db.exec('PRAGMA busy_timeout = 10000');
    db.exec('PRAGMA query_only = ON');
    return db;
  }
  mkdirSync(dirname(path), { recursive: true });
  let db = new DatabaseSync(path);
  const v = readVersion(db);
  if (v !== undefined && v !== SCHEMA_VERSION) {
    db.close();
    removeDbFiles(path);
    db = new DatabaseSync(path);
  }
  applyPragmas(db);
  db.exec(DDL);
  if (readVersion(db) === undefined) {
    db.prepare('INSERT INTO schema_version(version) VALUES (?)').run(SCHEMA_VERSION);
  }
  return db;
}

/** Create/upgrade the DB file, then close. Safe to call repeatedly. */
export function prepareDb(path: string): void {
  openDb(path).close();
}
