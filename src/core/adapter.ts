import type { ChatEvent, RawLine, SessionMeta, SourceId } from './types.ts';

/**
 * A SourceAdapter knows how to find and parse one coding agent's local
 * history. Adapters are pure parsers: no database, no HTTP. They must be
 * tolerant — unknown records become RawBlocks / are skipped, malformed
 * lines are skipped, and nothing ever throws for bad input data.
 */
export interface SourceAdapter {
  id: SourceId;
  displayName: string;
  /** Bump whenever parse output changes; the indexer re-parses files indexed by an older version. */
  parserVersion?: string;

  /** Default root directories to scan (e.g. ~/.claude/projects). May not exist. */
  defaultRoots(): string[];

  /**
   * List every session file under a root. Returns absolute paths.
   * Should be fast (readdir only, no file reads).
   */
  discover(root: string): Promise<DiscoveredFile[]>;

  /**
   * Create a stateful parser for one file. The indexer feeds it lines in
   * order (possibly starting mid-file when appending to a grown file, after
   * restoring state via `resume`). After the last line, call `finish()`.
   */
  createParser(file: DiscoveredFile): SessionParser;
}

export interface DiscoveredFile {
  path: string;
  /** native session id derived from the path, if possible */
  nativeId: string;
  /** grouping key for the project this file belongs to */
  projectKey: string;
  /** for sub-agent files: the parent session's native id */
  parentNativeId?: string;
  /** extra adapter-specific info (e.g. sidecar .meta.json path) */
  extra?: Record<string, unknown>;
}

export interface SessionParser {
  /**
   * Parse one line. Returns zero or more events (a single record can map to
   * several events, or to none — e.g. bookkeeping records that only update
   * session metadata). `seq` values are assigned by the parser, contiguous
   * from 0 across the whole file.
   */
  push(line: RawLine): ChatEvent[];

  /**
   * Called after the last line. Returns final session metadata and the list
   * of seqs that are off the active branch (if the source has branching).
   */
  finish(): { meta: SessionMeta; offBranchSeqs: number[] };

  /** Serialisable parser state, so the indexer can resume after appends. */
  snapshot(): unknown;
  resume(state: unknown): void;
}

/**
 * Parse a single line in isolation for random access by the server
 * (open a chat at seq N without re-parsing the whole file). Returns the
 * events that line produces; seq numbering starts at `firstSeq`.
 * Branch info (offBranch) comes from the index, not from here.
 */
export type ParseLine = (line: RawLine, firstSeq: number, file: DiscoveredFile) => ChatEvent[];
