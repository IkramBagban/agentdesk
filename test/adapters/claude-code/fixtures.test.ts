import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChatEvent } from '../../../src/core/types.ts';
import { claudeCodeAdapter as adapter } from '../../../src/adapters/claude-code/index.ts';

const ROOT = join(import.meta.dirname, '../../fixtures/claude-code/projects');

async function parseAll() {
  const files = await adapter.discover(ROOT);
  return files.map((file) => {
    const parser = adapter.createParser(file);
    const events: ChatEvent[] = [];
    let offset = 0;
    readFileSync(file.path, 'utf8')
      .split('\n')
      .forEach((text, line) => {
        const length = Buffer.byteLength(text);
        events.push(...parser.push({ line, offset, length, text }));
        offset += length + 1;
      });
    return { file, events, malformed: (parser as unknown as { malformedLines: number }).malformedLines, ...parser.finish() };
  });
}

describe('synthetic fixtures', () => {
  it('discovers 3 sessions and ignores memory/tool-results', async () => {
    const files = await adapter.discover(ROOT);
    expect(files.map((f) => f.nativeId).sort()).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '11111111-1111-4111-8111-111111111111/agent-abc123',
      '22222222-2222-4222-8222-222222222222',
    ]);
  });

  it('parses the main session', async () => {
    const main = (await parseAll()).find((r) => r.file.nativeId === '11111111-1111-4111-8111-111111111111')!;
    expect(main.malformed).toBe(1);
    expect(main.meta.title).toBe('Demo app test run');
    expect(main.meta.imageCount).toBe(2);
    expect(main.meta.links.some((l) => l.kind === 'artifact')).toBe(true);
    // only the dead-end edited prompt is off-branch
    expect(main.offBranchSeqs).toHaveLength(1);
    expect(main.events[main.offBranchSeqs[0]!]!.uuid).toBe('f1000000-0000-4000-8000-000000000021');
    // saved tool output reference
    const refs = main.events.flatMap((e) => e.blocks.flatMap((b) => (b.type === 'tool_result' ? b.content : []))).filter((b) => b.type === 'file_ref');
    expect(refs.length).toBeGreaterThan(0);
    // unknown record kept as raw
    expect(main.events.some((e) => e.blocks.some((b) => b.type === 'raw' && b.recordType === 'future-thing'))).toBe(true);
  });

  it('links the sub-agent to its parent', async () => {
    const sub = (await parseAll()).find((r) => r.file.parentNativeId)!;
    expect(sub.meta.parentSessionId).toBe('claude-code:11111111-1111-4111-8111-111111111111');
    expect(sub.meta.parentToolUseId).toBe('toolu_agent1');
  });
});
