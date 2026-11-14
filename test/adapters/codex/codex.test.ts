import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codexAdapter } from '../../../src/adapters/codex/index.ts';
import type { ChatEvent, RawLine } from '../../../src/core/types.ts';

const FIXTURE = join(
  import.meta.dirname,
  '../../fixtures/codex/rollout-2030-01-01T10-00-00-11111111-2222-3333-4444-555555555555.jsonl',
);
const NATIVE = '11111111-2222-3333-4444-555555555555';
const file = { path: FIXTURE, nativeId: NATIVE, projectKey: 'codex:unknown' };

function rawLines(path: string): RawLine[] {
  const buf = readFileSync(path);
  const out: RawLine[] = [];
  let off = 0;
  let n = 0;
  while (off < buf.length) {
    let end = buf.indexOf(0x0a, off);
    if (end < 0) end = buf.length;
    out.push({ line: n++, offset: off, length: end - off, text: buf.subarray(off, end).toString('utf8') });
    off = end + 1;
  }
  return out;
}

function parseAll() {
  const p = codexAdapter.createParser(file);
  const events: ChatEvent[] = [];
  for (const l of rawLines(FIXTURE)) events.push(...p.push(l));
  return { events, ...p.finish(), parser: p };
}

const text = (e: ChatEvent) =>
  e.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');

describe('codex adapter', () => {
  it('maps records to events with contiguous seqs', () => {
    const { events } = parseAll();
    events.forEach((e, i) => expect(e.seq).toBe(i));
    const lines = rawLines(FIXTURE);
    for (const e of events) {
      const l = lines[e.line]!;
      expect(e.offset).toBe(l.offset);
      expect(e.length).toBe(l.length);
    }
  });

  it('does not double the conversation (response_item is canonical)', () => {
    const { events } = parseAll();
    const convo = events.filter((e) => e.visibility === 'conversation');
    const prompts = convo.filter((e) => e.role === 'user' && text(e).includes('hello function'));
    expect(prompts).toHaveLength(1);
    expect(convo.filter((e) => text(e).includes('Added hello()'))).toHaveLength(1);
  });

  it('classifies injected / developer context as meta', () => {
    const { events } = parseAll();
    const dev = events.find((e) => text(e).includes('coding agent'))!;
    expect(dev.role).toBe('system');
    expect(dev.visibility).toBe('meta');
    const env = events.find((e) => text(e).includes('<environment_context>'))!;
    expect(env.visibility).toBe('meta');
    expect(env.synthetic).toBe(true);
    const agents = events.find((e) => text(e).startsWith('# AGENTS.md'))!;
    expect(agents.visibility).toBe('meta');
  });

  it('maps reasoning: summary and redacted', () => {
    const { events } = parseAll();
    const th = events.filter((e) => e.blocks[0]?.type === 'thinking');
    expect(th).toHaveLength(2);
    expect(th[0]!.blocks[0]).toMatchObject({ type: 'thinking', text: 'Plan: write the function.' });
    expect(th[1]!.blocks[0]).toMatchObject({ type: 'thinking', text: '', redacted: true });
    expect(th.every((e) => e.visibility === 'detail')).toBe(true);
  });

  it('maps tool calls and results', () => {
    const { events } = parseAll();
    const uses = events.flatMap((e) => e.blocks).filter((b) => b.type === 'tool_use');
    const byId = Object.fromEntries(uses.map((u) => [u.id, u]));
    expect(byId.call_1).toMatchObject({ name: 'shell', input: { command: ['ls', '-la'] } });
    expect(byId.call_2).toMatchObject({ name: 'mcp__demo__js', input: 'not json {' });
    expect(byId.call_3).toMatchObject({ name: 'apply_patch' });
    expect(byId.call_4).toMatchObject({ name: 'local_shell' });
    expect(byId.ws_1).toMatchObject({ name: 'web_search' });
    expect(byId.ws_2).toMatchObject({ name: 'web_search' });
    const results = events.filter((e) => e.role === 'tool');
    expect(results.every((e) => e.visibility === 'detail')).toBe(true);
    const r3 = results.map((e) => e.blocks[0]).find((b) => b?.type === 'tool_result' && b.toolUseId === 'call_3');
    expect(r3).toMatchObject({ isError: true, content: [{ type: 'text', text: 'Done' }] });
    const r4 = results.map((e) => e.blocks[0]).find((b) => b?.type === 'tool_result' && b.toolUseId === 'call_4');
    expect(r4).toMatchObject({ content: [{ type: 'text', text: 'hi\n' }] });
  });

  it('maps images: data URLs and file paths', () => {
    const { events, meta } = parseAll();
    const res = events
      .map((e) => e.blocks[0])
      .find((b) => b?.type === 'tool_result' && b.toolUseId === 'call_2');
    if (res?.type !== 'tool_result') throw new Error('missing');
    expect(res.content[1]).toMatchObject({
      type: 'image',
      mediaType: 'image/png',
      blobPath: '0.content.1',
      size: 70,
    });
    expect((res.content[1] as { data?: string }).data).toMatch(/^iVBOR/);
    const userImg = events.find((e) => text(e).includes('see this'))!;
    expect(userImg.blocks[1]).toMatchObject({ type: 'image', blobPath: '1' });
    expect(userImg.blocks[2]).toMatchObject({ type: 'image', filePath: '/work/demo-app/shot.png' });
    expect(meta.imageCount).toBe(3);
  });

  it('adds file_ref blocks for pasted attachments', () => {
    const { events } = parseAll();
    const e = events.find((x) => text(x).includes('Files pasted'))!;
    expect(e.visibility).toBe('conversation');
    expect(e.blocks.find((b) => b.type === 'file_ref')).toMatchObject({
      path: '/home/demo/.codex/attachments/abc/pasted.txt',
      role: 'attachment',
    });
  });

  it('emits notices for errors, aborts and compaction; skips clean task_complete', () => {
    const { events } = parseAll();
    const err = events.find((e) => e.blocks[0]?.type === 'notice' && e.blocks[0].level === 'error')!;
    expect(err.visibility).toBe('conversation');
    expect(err.blocks[0]).toMatchObject({ kind: 'usage_limit_exceeded', text: 'Usage limit reached' });
    expect(events.some((e) => e.blocks[0]?.type === 'notice' && e.blocks[0].kind === 'interrupted')).toBe(true);
    expect(events.some((e) => e.blocks[0]?.type === 'notice' && e.blocks[0].kind === 'compact')).toBe(true);
    expect(events.filter((e) => e.blocks[0]?.type === 'notice' && e.blocks[0].level === 'error')).toHaveLength(1);
  });

  it('maps unknown records to meta RawBlocks and skips malformed lines', () => {
    const { events } = parseAll();
    const raws = events.flatMap((e) => (e.blocks[0]?.type === 'raw' ? [e.blocks[0].recordType] : []));
    expect(raws).toEqual(
      expect.arrayContaining(['totally_new_record', 'response_item:brand_new_item', 'event_msg:brand_new_event']),
    );
    for (const e of events.filter((x) => x.blocks[0]?.type === 'raw')) expect(e.visibility).toBe('meta');
    const p = codexAdapter.createParser(file);
    expect(p.push({ line: 0, offset: 0, length: 5, text: '{nope' })).toEqual([]);
    expect(p.push({ line: 1, offset: 6, length: 0, text: '' })).toEqual([]);
    expect(p.push({ line: 2, offset: 7, length: 2, text: '[]' })).toEqual([]);
  });

  it('truncates huge raw blocks', () => {
    const big = JSON.stringify({ timestamp: 't', type: 'huge_thing', payload: { s: 'x'.repeat(50_000) } });
    const ev = codexAdapter.parseLine({ line: 0, offset: 0, length: big.length, text: big }, 0, file);
    const b = ev[0]!.blocks[0]!;
    expect(b.type).toBe('raw');
    expect(JSON.stringify(b).length).toBeLessThan(25_000);
  });

  it('builds session metadata', () => {
    const { meta, offBranchSeqs } = parseAll();
    expect(offBranchSeqs).toEqual([]);
    expect(meta).toMatchObject({
      id: `codex:${NATIVE}`,
      sourceId: 'codex',
      nativeId: NATIVE,
      projectKey: 'codex:/work/demo-app',
      projectPath: '/work/demo-app',
      firstPrompt: 'Please add a hello function.',
      title: 'Please add a hello function.',
      gitBranch: 'feature/x',
      inputTokens: 250,
      outputTokens: 40,
      startedAt: '2030-01-01T09:59:59Z',
    });
    expect(meta.models).toEqual(['gpt-test-1', 'gpt-test-2']);
    expect(meta.messageCount).toBe(
      parseAll().events.filter((e) => e.visibility === 'conversation').length,
    );
  });

  it('parseLine matches the stateful parser', () => {
    const { events } = parseAll();
    const lines = rawLines(FIXTURE);
    const viaLine: ChatEvent[] = [];
    for (const l of lines) viaLine.push(...codexAdapter.parseLine(l, viaLine.length, file));
    expect(viaLine).toEqual(events);
  });

  it('snapshot/resume continues identically and is JSON-serialisable', () => {
    const lines = rawLines(FIXTURE);
    const full = parseAll();
    const mid = Math.floor(lines.length / 2);
    const a = codexAdapter.createParser(file);
    const first: ChatEvent[] = [];
    for (const l of lines.slice(0, mid)) first.push(...a.push(l));
    const state = JSON.parse(JSON.stringify(a.snapshot()));
    const b = codexAdapter.createParser(file);
    b.resume(state);
    const rest: ChatEvent[] = [];
    for (const l of lines.slice(mid)) rest.push(...b.push(l));
    expect([...first, ...rest]).toEqual(full.events);
    expect(b.finish().meta).toEqual(full.meta);
  });

  it('defaultRoots honours CODEX_HOME', () => {
    const old = process.env.CODEX_HOME;
    process.env.CODEX_HOME = '/x/codexhome';
    try {
      expect(codexAdapter.defaultRoots()).toEqual(['/x/codexhome/sessions', '/x/codexhome/archived_sessions']);
    } finally {
      if (old === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = old;
    }
  });

  it('discover finds rollout files recursively and tolerates missing roots', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-disc-'));
    try {
      await mkdir(join(dir, '2030/01/01'), { recursive: true });
      const name = `rollout-2030-01-01T10-00-00-${NATIVE}.jsonl`;
      await writeFile(join(dir, '2030/01/01', name), '');
      await writeFile(join(dir, '2030/01/01', 'other.jsonl'), '');
      const found = await codexAdapter.discover(dir);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ nativeId: NATIVE, path: join(dir, '2030/01/01', name) });
      expect(await codexAdapter.discover(join(dir, 'nope'))).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
