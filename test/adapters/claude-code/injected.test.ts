import { describe, expect, it } from 'vitest';
import type { DiscoveredFile } from '../../../src/core/adapter.ts';
import { claudeCodeAdapter as adapter } from '../../../src/adapters/claude-code/index.ts';

const file: DiscoveredFile = { path: '/x.jsonl', nativeId: 's', projectKey: 'claude-code:p' };
const parse = (content: unknown) => {
  const text = JSON.stringify({ type: 'user', uuid: 'u', sessionId: 's', message: { role: 'user', content } });
  return adapter.parseLine({ line: 0, offset: 0, length: Buffer.byteLength(text), text }, 0, file);
};

describe('injected system reminders', () => {
  it('splits a reminder block away from what the human typed', () => {
    const [e] = parse([
      { type: 'text', text: '<system-reminder>\nharness says hi\n</system-reminder>\n\n' },
      { type: 'text', text: 'see it' },
    ]);
    expect(e?.visibility).toBe('conversation');
    expect(e?.blocks).toEqual([
      { type: 'notice', level: 'info', kind: 'injected', text: 'harness says hi' },
      { type: 'text', text: 'see it' },
    ]);
  });

  it('splits a reminder embedded in the same string', () => {
    const [e] = parse('<system-reminder>ctx</system-reminder>\nreal question?');
    expect(e?.visibility).toBe('conversation');
    expect(e?.blocks.at(-1)).toEqual({ type: 'text', text: 'real question?' });
  });

  it('keeps reminder-only records as meta', () => {
    const [e] = parse([{ type: 'text', text: '<system-reminder>only</system-reminder>' }]);
    expect(e?.visibility).toBe('meta');
    expect(e?.synthetic).toBe(true);
  });
});
