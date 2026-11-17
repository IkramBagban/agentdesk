/**
 * Agent-agnostic data model. Every source adapter (Claude Code, Codex, ...)
 * converts its own on-disk format into these shapes. The indexer, server and
 * UI only ever see these types — never a source's raw records.
 *
 * THIS FILE IS THE CONTRACT between parallel workstreams. Change it only
 * deliberately and update docs/SPEC.md alongside.
 */

export type SourceId = 'claude-code' | 'codex' | (string & {});

/** One raw line of a session file, located by byte range. */
export interface RawLine {
  /** 0-based line number in the file */
  line: number;
  /** byte offset of the first byte of the line */
  offset: number;
  /** byte length of the line, excluding the trailing newline */
  length: number;
  /** the line text (UTF-8 decoded) */
  text: string;
}

// ---------------------------------------------------------------------------
// Content blocks
// ---------------------------------------------------------------------------

export type Block =
  | TextBlock
  | ThinkingBlock
  | ToolUseBlock
  | ToolResultBlock
  | ImageBlock
  | DocumentBlock
  | FileRefBlock
  | NoticeBlock
  | RawBlock;

export interface TextBlock {
  type: 'text';
  text: string;
  /** set by the server when text was cut for transport; fetch the single event for full text */
  truncated?: { fullLength: number };
}

export interface ThinkingBlock {
  type: 'thinking';
  text: string;
  /** e.g. Codex encrypted reasoning: content exists but is not readable */
  redacted?: boolean;
  truncated?: { fullLength: number };
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
  /** if this tool call spawned a sub-agent session, its session id */
  subSessionId?: string;
}

export interface ToolResultBlock {
  type: 'tool_result';
  toolUseId: string;
  isError?: boolean;
  /** nested content (text / image / document / file_ref) */
  content: Block[];
}

/**
 * Binary payloads are NEVER sent inline over the API. The adapter keeps
 * `data` (base64) while parsing; the server strips it and replaces it with a
 * `blobPath` the UI fetches lazily from /api/sessions/:id/blob.
 */
export interface ImageBlock {
  type: 'image';
  mediaType: string;
  /** approximate decoded byte size */
  size: number;
  /** base64 — present only inside the adapter/indexer, stripped before transport */
  data?: string;
  /** dotted path of this block inside the event, e.g. "2" or "1.content.0" */
  blobPath?: string;
  /** image stored as a separate file instead of inline */
  filePath?: string;
}

export interface DocumentBlock {
  type: 'document';
  mediaType: string;
  title?: string;
  size: number;
  data?: string;
  blobPath?: string;
}

/** Reference to a file on disk: @-mentions, saved tool outputs, edited files, ... */
export interface FileRefBlock {
  type: 'file_ref';
  path: string;
  label?: string;
  /** 'mention' | 'tool_output' | 'edited' | 'directory' | ... */
  role: string;
  /** inline snippet if the record carried one */
  snippet?: string;
  /** filled in by the server: whether the file still exists */
  exists?: boolean;
}

/** Things like "Conversation compacted", API errors, model fallback, hook output. */
export interface NoticeBlock {
  type: 'notice';
  level: 'info' | 'warning' | 'error';
  /** stable machine kind: 'compact' | 'api_error' | 'hook' | 'interrupted' | ... */
  kind: string;
  text: string;
}

/** Anything the adapter did not understand. Shown as collapsible JSON, never dropped. */
export interface RawBlock {
  type: 'raw';
  recordType: string;
  json: unknown;
}

// ---------------------------------------------------------------------------
// Events (one renderable item in a conversation)
// ---------------------------------------------------------------------------

export type Role = 'user' | 'assistant' | 'system' | 'tool';

/**
 * Visibility:
 * - 'conversation': real user prompts and assistant output — the default view
 * - 'detail': tool calls/results, thinking — shown, but collapsed by default
 * - 'meta': injected context, hooks, bookkeeping — hidden unless "Everything"
 */
export type Visibility = 'conversation' | 'detail' | 'meta';

export interface ChatEvent {
  /** 0-based index within the session, in file order. Stable across re-index. */
  seq: number;
  /** source-native id, if any */
  uuid?: string;
  parentUuid?: string;
  role: Role;
  visibility: Visibility;
  timestamp?: string;
  model?: string;
  /** true if this event is not on the final (active) branch of the conversation */
  offBranch?: boolean;
  /** user message produced by the harness, not typed by a human */
  synthetic?: boolean;
  /**
   * true if the source record was copied from another session (the history a
   * fork / side chat starts with). Adapters set it only when the record names
   * its session and that is not this one; unset otherwise. The indexer derives
   * `SessionMeta.forkedAtSeq` from it.
   */
  inherited?: boolean;
  blocks: Block[];
  /** location in the source file (used by the server for random access) */
  line: number;
  offset: number;
  length: number;
}

// ---------------------------------------------------------------------------
// Sessions & projects
// ---------------------------------------------------------------------------

export interface SessionMeta {
  /** globally unique: `${sourceId}:${nativeId}` */
  id: string;
  sourceId: SourceId;
  nativeId: string;
  /** absolute path of the session file */
  filePath: string;
  /** absolute project/working directory the session ran in, if known */
  projectPath?: string;
  /** stable project key for grouping */
  projectKey: string;
  title?: string;
  firstPrompt?: string;
  startedAt?: string;
  updatedAt?: string;
  eventCount: number;
  /** events with visibility === 'conversation' */
  messageCount: number;
  imageCount: number;
  models: string[];
  costUSD?: number;
  inputTokens?: number;
  outputTokens?: number;
  gitBranch?: string;
  /** set when this session is a sub-agent run */
  parentSessionId?: string;
  /**
   * Set when the agent's own app records that another session started this
   * one (e.g. Claude desktop "start session" / side chats). Not a sub-agent:
   * these are full sessions, shown nested under their starter in the sidebar.
   */
  spawnedFromSessionId?: string;
  /** 'spawned' = started as its own task; 'side' = a side chat / fork */
  spawnKind?: 'spawned' | 'side';
  /** archived in the agent's own app */
  archived?: boolean;
  /**
   * Set when the file starts with records copied from another session (a
   * fork / side chat): seq of the first event that belongs to this session.
   * Events before it are the inherited history.
   */
  forkedAtSeq?: number;
  parentToolUseId?: string;
  agentDescription?: string;
  /** e.g. links to PRs / artifacts produced in the session */
  links: { kind: string; url: string; title?: string }[];
}

export interface ProjectMeta {
  key: string;
  sourceId: SourceId;
  path?: string;
  displayName: string;
  sessionCount: number;
  updatedAt?: string;
}

/** A session plus the sessions it started, for the nested sidebar. */
export interface SessionNode extends SessionMeta {
  children: SessionNode[];
  /** latest updatedAt across this session and all its descendants */
  activityAt?: string;
}
