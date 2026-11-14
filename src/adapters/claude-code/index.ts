import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DiscoveredFile, ParseLine, SourceAdapter } from '../../core/adapter.ts';
import type { ChatEvent, RawLine } from '../../core/types.ts';
import { convertRecord, materialize, parseJson } from './convert.ts';
import { discover } from './discover.ts';
import { ClaudeCodeParser } from './parser.ts';

const parseLine: ParseLine = (line: RawLine, firstSeq: number, _file: DiscoveredFile): ChatEvent[] => {
  const { rec } = parseJson(line.text);
  if (!rec) return [];
  return materialize(convertRecord(rec), firstSeq, line);
};

export const claudeCodeAdapter: SourceAdapter & { parseLine: ParseLine } = {
  id: 'claude-code',
  displayName: 'Claude Code',
  parserVersion: '3',
  defaultRoots() {
    const dir = process.env.CLAUDE_CONFIG_DIR;
    return [dir ? join(dir, 'projects') : join(homedir(), '.claude', 'projects')];
  },
  discover,
  createParser(file: DiscoveredFile) {
    return new ClaudeCodeParser(file);
  },
  parseLine,
};

export { ClaudeCodeParser };
