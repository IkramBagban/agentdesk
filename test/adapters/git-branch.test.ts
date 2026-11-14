import { describe, expect, it } from 'vitest';
import { claudeCodeAdapter } from '../../src/adapters/claude-code/index.ts';
import { codexAdapter } from '../../src/adapters/codex/index.ts';
import type { SourceAdapter } from '../../src/core/adapter.ts';

function metaOf(adapter: SourceAdapter, records: object[]) {
  const p = adapter.createParser({ path: '/x.jsonl', nativeId: 'n', projectKey: 'k' });
  let offset = 0;
  records.forEach((r, line) => {
    const text = JSON.stringify(r);
    p.push({ line, offset, length: Buffer.byteLength(text), text });
    offset += Buffer.byteLength(text) + 1;
  });
  return p.finish().meta;
}

const ccUser = (gitBranch: string) => ({ type: 'user', uuid: `u${gitBranch}`, gitBranch, message: { role: 'user', content: 'hi' } });
const codexMeta = (branch: string) => ({ type: 'session_meta', payload: { id: 'abc', cwd: '/w', git: { branch } } });

describe('gitBranch "HEAD" (detached / no branch) is not reported', () => {
  it('claude-code', () => {
    expect(metaOf(claudeCodeAdapter, [ccUser('HEAD')]).gitBranch).toBeUndefined();
    expect(metaOf(claudeCodeAdapter, [ccUser('main'), ccUser('HEAD')]).gitBranch).toBe('main');
  });
  it('codex', () => {
    expect(metaOf(codexAdapter, [codexMeta('HEAD')]).gitBranch).toBeUndefined();
    expect(metaOf(codexAdapter, [codexMeta('dev')]).gitBranch).toBe('dev');
  });
});
