import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DiscoveredFile } from '../../../src/core/adapter.ts';
import type { ChatEvent, RawLine } from '../../../src/core/types.ts';
import { claudeCodeAdapter as adapter } from '../../../src/adapters/claude-code/index.ts';

const S = '11111111-1111-1111-1111-111111111111';
const IMG = Buffer.from('fake-image-bytes-0123456789').toString('base64');

const rec = (o: Record<string, unknown>) => JSON.stringify(o);
const common = { sessionId: S, cwd: '/work/proj', gitBranch: 'main', userType: 'external' };

const lines: string[] = [
  rec({ type: 'custom-title', customTitle: 'New session', sessionId: S }),
  rec({ ...common, type: 'user', uuid: 'u1', parentUuid: null, timestamp: '2030-01-01T10:00:00.000Z', message: { role: 'user', content: 'Hello there' } }),
  rec({ ...common, type: 'user', uuid: 'u2', parentUuid: 'u1', isMeta: true, timestamp: '2030-01-01T10:00:01.000Z', message: { role: 'user', content: 'meta stuff' } }),
  rec({ ...common, type: 'user', uuid: 'u3', parentUuid: 'u2', timestamp: '2030-01-01T10:00:02.000Z', message: { role: 'user', content: '<system-reminder>x</system-reminder>\n<command-name>/foo</command-name>' } }),
  rec({ ...common, type: 'assistant', uuid: 'a1', parentUuid: 'u3', timestamp: '2030-01-01T10:00:03.000Z', message: { model: 'claude-x', role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm', signature: 's' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a' } }] } }),
  rec({ ...common, type: 'user', uuid: 'u4', parentUuid: 'a1', timestamp: '2030-01-01T10:00:04.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'Output too large. Full output saved to: /home/x/.claude/projects/p/s/tool-results/t1.txt' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: IMG } }, { type: 'tool_reference', tool_name: 'Foo' }] }] } }),
  rec({ ...common, type: 'assistant', uuid: 'a2', parentUuid: 'u4', timestamp: '2030-01-01T10:00:05.000Z', message: { model: 'claude-x', role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } }),
  // dead branch: sibling of a2
  rec({ ...common, type: 'assistant', uuid: 'a2b', parentUuid: 'u4', timestamp: '2030-01-01T10:00:05.500Z', message: { model: 'claude-y', role: 'assistant', content: [{ type: 'text', text: 'Alt.' }] } }),
  rec({ ...common, type: 'user', uuid: 'u5', parentUuid: 'a2', timestamp: '2030-01-01T10:00:06.000Z', message: { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: IMG } }] } }),
  rec({ ...common, type: 'attachment', uuid: 'at1', parentUuid: 'u5', timestamp: '2030-01-01T10:00:07.000Z', attachment: { type: 'edited_text_file', filename: '/a/b.ts', snippet: 'x' } }),
  rec({ ...common, type: 'attachment', uuid: 'at2', parentUuid: 'at1', timestamp: '2030-01-01T10:00:07.100Z', attachment: { type: 'hook_success', hookName: 'PostToolUse', hookEvent: 'PostToolUse', stdout: 'ok', exitCode: 0 } }),
  rec({ ...common, type: 'attachment', uuid: 'at3', parentUuid: 'at2', timestamp: '2030-01-01T10:00:07.200Z', attachment: { type: 'queued_command', prompt: '<task-notification>done</task-notification>' } }),
  rec({ ...common, type: 'attachment', uuid: 'at4', parentUuid: 'at3', timestamp: '2030-01-01T10:00:07.300Z', attachment: { type: 'brand_new_thing', foo: 1 } }),
  rec({ ...common, type: 'system', subtype: 'compact_boundary', uuid: 'c1', parentUuid: null, logicalParentUuid: 'at4', content: 'Conversation compacted', timestamp: '2030-01-01T10:00:08.000Z', compactMetadata: { trigger: 'auto', preTokens: 123 } }),
  rec({ ...common, type: 'assistant', uuid: 'a3', parentUuid: 'c1', timestamp: '2030-01-01T10:00:09.000Z', message: { model: 'claude-x', role: 'assistant', content: [{ type: 'text', text: 'after compact' }] } }),
  rec({ ...common, type: 'system', subtype: 'api_error', uuid: 'e1', parentUuid: 'a3', timestamp: '2030-01-01T10:00:10.000Z', error: { message: 'boom' } }),
  'this is not json {',
  rec({ type: 'totally-new', foo: 'bar' }),
  rec({ type: 'custom-title', customTitle: 'My Title', sessionId: S }),
  rec({ type: 'agent-name', agentName: 'agent-n', sessionId: S }),
  rec({ type: 'cost-state', totalCostUSD: 1.5, modelUsage: { m: { inputTokens: 10, outputTokens: 5 }, n: { inputTokens: 1, outputTokens: 2 } } }),
  rec({ type: 'pr-link', prNumber: 7, prUrl: 'https://example.test/pr/7', prRepository: 'o/r' }),
  rec({ type: 'frame-link', frameUrl: 'https://example.test/f', title: 'F' }),
  rec({ type: 'last-prompt', lastPrompt: 'x', leafUuid: 'e1' }),
  rec({ type: 'file-history-snapshot', messageId: 'm' }),
];

const dir = mkdtempSync(join(tmpdir(), 'ah-cc-'));
const file: DiscoveredFile = { path: join(dir, '-work-proj', `${S}.jsonl`), nativeId: S, projectKey: 'claude-code:-work-proj' };

function feed(parser: ReturnType<typeof adapter.createParser>, ls: string[], startLine = 0): ChatEvent[] {
  let offset = 0;
  const out: ChatEvent[] = [];
  ls.forEach((text, i) => {
    const raw: RawLine = { line: startLine + i, offset, length: Buffer.byteLength(text), text };
    offset += raw.length + 1;
    out.push(...parser.push(raw));
  });
  return out;
}

beforeAll(() => {
  mkdirSync(join(dir, '-work-proj', S, 'subagents'), { recursive: true });
  mkdirSync(join(dir, '-work-proj', S, 'tool-results'), { recursive: true });
  mkdirSync(join(dir, '-work-proj', 'memory'), { recursive: true });
  mkdirSync(join(dir, '-other'), { recursive: true });
  writeFileSync(join(dir, '-work-proj', `${S}.jsonl`), lines.join('\n') + '\n');
  writeFileSync(join(dir, '-work-proj', 'memory', 'x.jsonl'), '{}\n');
  writeFileSync(join(dir, '-work-proj', S, 'tool-results', 'r.jsonl'), '{}\n');
  writeFileSync(join(dir, '-work-proj', S, 'subagents', 'agent-abc.jsonl'), rec({ ...common, type: 'user', uuid: 's1', parentUuid: null, message: { role: 'user', content: 'sub task' } }) + '\n');
  writeFileSync(join(dir, '-work-proj', S, 'subagents', 'agent-abc.meta.json'), JSON.stringify({ toolUseId: 'toolu_1', description: 'Sub desc' }));
  writeFileSync(join(dir, '-other', '22222222-2222-2222-2222-222222222222.jsonl'), '');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('discover', () => {
  it('finds main and sub-agent sessions, skipping memory and tool-results', async () => {
    const files = await adapter.discover(dir);
    const ids = files.map((f) => f.nativeId).sort();
    expect(ids).toEqual([S, `${S}/agent-abc`, '22222222-2222-2222-2222-222222222222'].sort());
    const sub = files.find((f) => f.nativeId.endsWith('agent-abc'))!;
    expect(sub.parentNativeId).toBe(S);
    expect(sub.projectKey).toBe('claude-code:-work-proj');
    expect(sub.extra?.metaPath).toBe(join(dir, '-work-proj', S, 'subagents', 'agent-abc.meta.json'));
  });
  it('tolerates a missing root', async () => {
    expect(await adapter.discover(join(dir, 'nope'))).toEqual([]);
  });
  it('honours CLAUDE_CONFIG_DIR', () => {
    const old = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = '/x/y';
    expect(adapter.defaultRoots()).toEqual([join('/x/y', 'projects')]);
    if (old === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = old;
  });
});

describe('parser', () => {
  const parser = adapter.createParser(file);
  const events = feed(parser, lines);
  const { meta, offBranchSeqs } = parser.finish();

  it('maps user records by visibility', () => {
    expect(events[0]).toMatchObject({ role: 'user', visibility: 'conversation' });
    expect(events[1]).toMatchObject({ role: 'user', visibility: 'meta', synthetic: true });
    expect(events[2]).toMatchObject({ role: 'user', visibility: 'meta', synthetic: true });
  });

  it('maps assistant thinking/tool_use as detail and text as conversation', () => {
    expect(events[3]).toMatchObject({ role: 'assistant', visibility: 'detail', model: 'claude-x' });
    expect(events[3]!.blocks.map((b) => b.type)).toEqual(['thinking', 'tool_use']);
    expect(events[5]).toMatchObject({ role: 'assistant', visibility: 'conversation' });
  });

  it('maps tool results with nested image, file ref and blobPath', () => {
    const ev = events[4]!;
    expect(ev).toMatchObject({ role: 'tool', visibility: 'detail' });
    const tr = ev.blocks[0]!;
    if (tr.type !== 'tool_result') throw new Error('expected tool_result');
    const img = tr.content.find((b) => b.type === 'image');
    expect(img).toMatchObject({ mediaType: 'image/png', blobPath: '0.content.1', data: IMG });
    expect(img && img.type === 'image' && img.size).toBe(Buffer.from(IMG, 'base64').length);
    expect(tr.content.find((b) => b.type === 'file_ref')).toMatchObject({ role: 'tool_output', path: '/home/x/.claude/projects/p/s/tool-results/t1.txt' });
  });

  it('keeps top-level images with blobPath', () => {
    const ev = events.find((e) => e.role === 'user' && e.blocks.some((b) => b.type === 'image'))!;
    expect(ev.visibility).toBe('conversation');
    expect(ev.blocks[1]).toMatchObject({ type: 'image', blobPath: '1' });
  });

  it('maps attachments, system records and unknown types', () => {
    const find = (f: (e: ChatEvent) => boolean) => events.find(f)!;
    expect(find((e) => e.blocks[0]?.type === 'file_ref' && e.role === 'system')).toMatchObject({ visibility: 'meta' });
    expect(find((e) => e.blocks[0]?.type === 'notice' && (e.blocks[0] as { kind: string }).kind === 'hook').visibility).toBe('meta');
    const queued = events.find((e) => e.role === 'user' && e.synthetic && e.blocks[0]?.type === 'text' && (e.blocks[0] as { text: string }).text.includes('task-notification'));
    expect(queued?.visibility).toBe('meta');
    expect(find((e) => e.blocks[0]?.type === 'raw' && (e.blocks[0] as { recordType: string }).recordType === 'attachment:brand_new_thing').visibility).toBe('meta');
    expect(find((e) => (e.blocks[0] as { kind?: string }).kind === 'compact')).toMatchObject({ visibility: 'conversation', role: 'system' });
    expect(find((e) => (e.blocks[0] as { kind?: string }).kind === 'api_error')).toMatchObject({ visibility: 'detail' });
    expect(find((e) => (e.blocks[0] as { recordType?: string }).recordType === 'totally-new').visibility).toBe('meta');
  });

  it('produces no events for bookkeeping records and numbers seqs contiguously', () => {
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    expect(events.some((e) => e.blocks.some((b) => b.type === 'raw' && ['custom-title', 'cost-state', 'file-history-snapshot'].includes(b.recordType)))).toBe(false);
  });

  it('computes session meta', () => {
    expect(meta).toMatchObject({
      id: `claude-code:${S}`,
      nativeId: S,
      projectKey: 'claude-code:-work-proj',
      projectPath: '/work/proj',
      title: 'My Title',
      firstPrompt: 'Hello there',
      startedAt: '2030-01-01T10:00:00.000Z',
      updatedAt: '2030-01-01T10:00:10.000Z',
      eventCount: events.length,
      imageCount: 2,
      models: ['claude-x', 'claude-y'],
      costUSD: 1.5,
      inputTokens: 11,
      outputTokens: 7,
      gitBranch: 'main',
    });
    expect(meta.messageCount).toBe(events.filter((e) => e.visibility === 'conversation').length);
    expect(meta.links).toEqual([
      { kind: 'pr', url: 'https://example.test/pr/7', title: 'o/r#7' },
      { kind: 'artifact', url: 'https://example.test/f', title: 'F' },
    ]);
  });

  it('counts malformed lines without throwing', () => {
    expect((parser as unknown as { malformedLines: number }).malformedLines).toBe(1);
  });

  it('marks only the sibling branch off-branch, following logicalParentUuid', () => {
    const alt = events.find((e) => e.uuid === 'a2b')!;
    expect(offBranchSeqs).toEqual([alt.seq]);
  });

  it('falls back to the first prompt for the title', () => {
    const p = adapter.createParser(file);
    feed(p, [lines[1]!]);
    expect(p.finish().meta.title).toBe('Hello there');
  });
});

describe('sub-agent', () => {
  it('fills parent info from the sidecar', async () => {
    const f = (await adapter.discover(dir)).find((x) => x.nativeId.endsWith('agent-abc'))!;
    const p = adapter.createParser(f);
    feed(p, [rec({ ...common, type: 'user', uuid: 's1', message: { role: 'user', content: 'sub task' } })]);
    expect(p.finish().meta).toMatchObject({
      id: `claude-code:${S}/agent-abc`,
      parentSessionId: `claude-code:${S}`,
      parentToolUseId: 'toolu_1',
      agentDescription: 'Sub desc',
    });
  });
});

describe('parseLine / snapshot / resume', () => {
  it('parseLine matches the stateful parser line by line', () => {
    const p = adapter.createParser(file);
    let offset = 0;
    lines.forEach((text, i) => {
      const raw: RawLine = { line: i, offset, length: Buffer.byteLength(text), text };
      offset += raw.length + 1;
      const first = p.snapshot() as { seq: number };
      const evs = p.push(raw);
      expect(adapter.parseLine(raw, first.seq, file)).toEqual(evs);
    });
  });

  it('resume continues exactly where a full parse would', () => {
    const full = adapter.createParser(file);
    const fullEvents = feed(full, lines);
    const cut = 10;
    const a = adapter.createParser(file);
    const first = feed(a, lines.slice(0, cut));
    const state = JSON.parse(JSON.stringify(a.snapshot()));
    const b = adapter.createParser(file);
    b.resume(state);
    const rest = feed(b, lines.slice(cut), cut);
    expect([...first, ...rest].map((e) => e.seq)).toEqual(fullEvents.map((e) => e.seq));
    expect(b.finish().meta).toEqual(full.finish().meta);
    expect(b.finish().offBranchSeqs).toEqual(full.finish().offBranchSeqs);
  });

  it('ignores unusable state', () => {
    const p = adapter.createParser(file);
    p.resume({ garbage: true });
    expect(feed(p, [lines[1]!])[0]?.seq).toBe(0);
  });

  it('marks nothing off-branch when the parent chain is unreliable', () => {
    const p = adapter.createParser(file);
    const broken = ['a', 'b', 'c', 'd'].map((id) =>
      rec({ type: 'user', uuid: id, parentUuid: `missing-${id}`, message: { role: 'user', content: id } }),
    );
    feed(p, broken);
    expect(p.finish().offBranchSeqs).toEqual([]);
  });
});
