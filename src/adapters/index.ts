import type { ParseLine, SourceAdapter } from '../core/adapter.ts';
import type { SourceId } from '../core/types.ts';
import { claudeCodeAdapter } from './claude-code/index.ts';
import { codexAdapter } from './codex/index.ts';

export type FullAdapter = SourceAdapter & { parseLine: ParseLine };

/** Every supported agent. Add new adapters here. */
export const adapters: Map<SourceId, FullAdapter> = new Map<SourceId, FullAdapter>([
  [claudeCodeAdapter.id, claudeCodeAdapter],
  [codexAdapter.id, codexAdapter],
]);
