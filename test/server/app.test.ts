import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ParseLine, SourceAdapter } from '../../src/core/adapter.ts';
import type { Block, ChatEvent, SessionMeta } from '../../src/core/types.ts';
import type { EventRef, IndexStore } from '../../src/index/store.ts';
import { createApp } from '../../src/server/app.ts';

const PORT = 4782;
const TOKEN = 'test-token-abc';
const HOST = `127.0.0.1:${PORT}`;
const BIG = 'x'.repeat(30_000);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);

let dir: string;
let sessionFile: string;
let app: ReturnType<typeof createApp>;
const refs: EventRef[] = [];

/** Each JSONL line is a JSON array of blocks; line i yields one event (seq i). */
const parseLine: ParseLine = (line, firstSeq) => {
  let blocks: Block[];
  try {
    blocks = JSON.parse(line.text) as Block[];
  } catch {
    return [];
  }
  const ev: ChatEvent = {
    seq: firstSeq,
    role: firstSeq % 2 === 0 ? 'user' : 'assistant',
    visibility: 'conversation',
    blocks,
    line: line.line,
    offset: line.offset,
    length: line.length,
  };
  return [ev];
};

const adapter: SourceAdapter & { parseLine: ParseLine } = {
  id: 'fake',
  displayName: 'Fake',
  defaultRoots: () => [],
  discover: async () => [],
  createParser: () => {
    throw new Error('unused');
  },
  parseLine,
};

function makeStore(meta: SessionMeta): IndexStore {
  return {
    status: () => ({ state: 'idle', filesDone: 1, filesTotal: 1, sessionCount: 1 }),
    listProjects: () => [{ key: 'p', sourceId: 'fake', displayName: 'p', sessionCount: 1 }],
    listSessions: () => ({ items: [meta] }),
    getSession: (id) => (id === meta.id ? meta : undefined),
    getSubSessions: () => [],
    listEventRefs: ({ from, limit }) => {
      const items = refs.filter((r) => r.seq >= from).slice(0, limit);
      return { items, total: refs.length };
    },
    getEventRef: (_id, seq) => refs.find((r) => r.seq === seq),
    toolLinks: () => new Map([['tu1', 'fake:sub1']]),
    outline: () => [{ seq: 0, preview: 'hello', offBranch: false }],
    search: () => ({
      items: [{ sessionId: meta.id, seq: 0, projectKey: 'p', role: 'user', snippet: 'a <mark>hit</mark> &amp; more' }],
    }),
    onChange: () => () => {},
  };
}

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'ah-server-')));
  const root = join(dir, 'root');
  mkdirSync(root);
  sessionFile = join(root, 's.jsonl');
  const lines: Block[][] = [
    [{ type: 'text', text: 'hello' }],
    [
      { type: 'text', text: BIG },
      { type: 'tool_use', id: 'tu1', name: 'Task', input: { a: 1 } },
      { type: 'tool_result', toolUseId: 'tu1', content: [{ type: 'image', mediaType: 'image/png', size: 9, data: PNG.toString('base64') }] },
      { type: 'image', mediaType: 'image/png', size: 9, data: PNG.toString('base64') },
      { type: 'file_ref', path: join(root, 'nope.txt'), role: 'mention' },
    ],
    [{ type: 'text', text: 'bye' }],
  ];
  let offset = 0;
  let text = '';
  lines.forEach((l, i) => {
    const s = JSON.stringify(l);
    const length = Buffer.byteLength(s);
    refs.push({
      sessionId: 'fake:s1', seq: i, lineEventIndex: 0, lineFirstSeq: i, line: i, offset, length,
      visibility: 'conversation', offBranch: i === 2,
    });
    text += s + '\n';
    offset += length + 1;
  });
  writeFileSync(sessionFile, text);

  writeFileSync(join(root, 'note.txt'), 'plain text');
  writeFileSync(join(root, 'bin.dat'), Buffer.from([65, 0, 66]));
  mkdirSync(join(dir, 'outside'));
  writeFileSync(join(dir, 'outside', 'secret.txt'), 'secret');
  symlinkSync(join(dir, 'outside', 'secret.txt'), join(root, 'link.txt'));
  symlinkSync(join(dir, 'outside'), join(root, 'linkdir'));

  const meta: SessionMeta = {
    id: 'fake:s1', sourceId: 'fake', nativeId: 's1', filePath: sessionFile, projectKey: 'p',
    title: 'My session', eventCount: 3, messageCount: 3, imageCount: 2, models: [], links: [],
  };
  app = createApp({
    store: makeStore(meta),
    adapters: new Map([['fake', adapter]]),
    token: TOKEN,
    port: PORT,
    allowedRoots: [root],
    webDir: join(dir, 'web'),
  });
});

const auth = { Authorization: `Bearer ${TOKEN}` };
const req = (path: string, headers: Record<string, string> = {}) =>
  app.request(`http://${HOST}${path}`, { headers: { Host: HOST, ...headers } });
const authed = (path: string) => req(path, auth);

describe('security', () => {
  it('rejects a foreign Host header', async () => {
    const res = await app.request('http://evil.com/api/status', { headers: { Host: 'evil.com', ...auth } });
    expect(res.status).toBe(403);
    const res2 = await app.request(`http://${HOST}/api/status`, { headers: { Host: `evil.com:${PORT}`, ...auth } });
    expect(res2.status).toBe(403);
  });

  it('requires a token for /api', async () => {
    expect((await req('/api/status')).status).toBe(401);
    expect((await req('/api/status', { Authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await authed('/api/status')).status).toBe(200);
  });

  it('sets the cookie via /?t= and redirects, then cookie authenticates', async () => {
    const res = await req(`/?t=${TOKEN}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`ah_token=${TOKEN}`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\//);
    expect((await req('/api/status', { Cookie: `ah_token=${TOKEN}` })).status).toBe(200);
  });

  it('does not set a cookie for a wrong token', async () => {
    const res = await req('/?t=nope');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('gives static HTML the CSP headers', async () => {
    const webDir = join(dir, 'web');
    mkdirSync(webDir, { recursive: true });
    writeFileSync(join(webDir, 'index.html'), '<html></html>');
    const res = await req('/some/spa/route');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });
});

describe('events', () => {
  it('strips base64, sets blobPath, truncates, fills subSessionId and exists', async () => {
    const res = await authed('/api/sessions/fake%3As1/events');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: ChatEvent[]; total: number };
    expect(body.total).toBe(3);
    const ev = body.items[1]!;
    const text = ev.blocks[0] as Extract<Block, { type: 'text' }>;
    expect(text.text.length).toBe(20 * 1024);
    expect(text.truncated).toEqual({ fullLength: 30_000 });
    const tu = ev.blocks[1] as Extract<Block, { type: 'tool_use' }>;
    expect(tu.subSessionId).toBe('fake:sub1');
    const tr = ev.blocks[2] as Extract<Block, { type: 'tool_result' }>;
    const nested = tr.content[0] as Extract<Block, { type: 'image' }>;
    expect(nested.data).toBeUndefined();
    expect(nested.blobPath).toBe('2.content.0');
    const img = ev.blocks[3] as Extract<Block, { type: 'image' }>;
    expect(img.data).toBeUndefined();
    expect(img.blobPath).toBe('3');
    expect((ev.blocks[4] as Extract<Block, { type: 'file_ref' }>).exists).toBe(false);
    expect(JSON.stringify(body)).not.toContain(PNG.toString('base64'));
    expect(body.items[2]!.offBranch).toBe(true);
  });

  it('returns the single event untruncated', async () => {
    const res = await authed('/api/sessions/fake%3As1/events/1');
    const ev = (await res.json()) as ChatEvent;
    const text = ev.blocks[0] as Extract<Block, { type: 'text' }>;
    expect(text.text.length).toBe(30_000);
    expect(text.truncated).toBeUndefined();
    expect(JSON.stringify(ev)).not.toContain(PNG.toString('base64'));
  });

  it('turns an unparseable/changed line into an error notice, not a 500', async () => {
    const saved = refs[0]!.offset;
    refs[0]!.offset = 3; // misaligned range
    try {
      const res = await authed('/api/sessions/fake%3As1/events?limit=1');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: ChatEvent[] };
      expect(body.items[0]!.blocks[0]).toMatchObject({ type: 'notice', level: 'error' });
    } finally {
      refs[0]!.offset = saved;
    }
  });

  it('404s for unknown sessions', async () => {
    expect((await authed('/api/sessions/nope/events')).status).toBe(404);
    expect((await authed('/api/sessions/nope')).status).toBe(404);
  });
});

describe('blob', () => {
  it('returns correct bytes and content-type for top-level and nested images', async () => {
    for (const path of ['3', '2.content.0']) {
      const res = await authed(`/api/sessions/fake%3As1/blob?seq=1&path=${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
      expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
    }
  });

  it('404s for non-binary or bad paths', async () => {
    expect((await authed('/api/sessions/fake%3As1/blob?seq=1&path=0')).status).toBe(404);
    expect((await authed('/api/sessions/fake%3As1/blob?seq=1&path=9')).status).toBe(404);
    expect((await authed('/api/sessions/fake%3As1/blob?seq=1&path=constructor')).status).toBe(404);
  });
});

describe('/api/file', () => {
  const root = () => join(dir, 'root');
  const get = (p: string) => authed(`/api/file?path=${encodeURIComponent(p)}`);

  it('serves text inside roots', async () => {
    const res = await get(join(root(), 'note.txt'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('plain text');
  });

  it('refuses outside roots, .., symlink escapes, relative and binary', async () => {
    expect((await get(join(dir, 'outside', 'secret.txt'))).status).toBe(403);
    expect((await get(join(root(), '..', 'outside', 'secret.txt'))).status).toBe(403);
    expect((await get(`${root()}/../outside/secret.txt`)).status).toBe(403);
    expect((await get(join(root(), 'link.txt'))).status).toBe(403);
    expect((await get(join(root(), 'linkdir', 'secret.txt'))).status).toBe(403);
    expect((await get('note.txt')).status).toBe(403);
    expect((await get('/etc/passwd')).status).toBe(403);
    expect((await get(join(root(), 'bin.dat'))).status).toBe(415);
    expect((await get(join(root(), 'missing.txt'))).status).toBe(403);
  });
});

describe('search / lists / export', () => {
  it('passes snippets through', async () => {
    const res = await authed('/api/search?q=hit');
    const body = (await res.json()) as { items: { snippet: string }[] };
    expect(body.items[0]!.snippet).toBe('a <mark>hit</mark> &amp; more');
    expect((await authed('/api/search')).status).toBe(400);
  });

  it('serves session detail and status', async () => {
    const s = (await (await authed('/api/sessions/fake%3As1')).json()) as SessionMeta & { subSessions: unknown[] };
    expect(s.subSessions).toEqual([]);
    const st = (await (await authed('/api/status')).json()) as { sources: { sessionCount: number }[]; index: { state: string } };
    expect(st.sources[0]!.sessionCount).toBe(1);
    expect(st.index.state).toBe('idle');
  });

  it('exports markdown', async () => {
    const res = await authed('/api/sessions/fake%3As1/export.md');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    expect(res.headers.get('content-disposition')).toContain('attachment');
    const md = await res.text();
    expect(md).toContain('# My session');
    expect(md).toContain('hello');
    expect(md).toContain('[image: image/png, 9 B]');
    expect(md).toContain('**Tool call: Task**');
    expect(md).not.toContain('bye'); // off-branch event skipped
    expect(md).not.toContain(PNG.toString('base64'));
  });

  it('returns JSON 404 for unknown api routes', async () => {
    const res = await authed('/api/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });
});
