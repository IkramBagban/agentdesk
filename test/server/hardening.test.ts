import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ParseLine, SourceAdapter } from '../../src/core/adapter.ts';
import type { Block, ChatEvent, SessionMeta } from '../../src/core/types.ts';
import type { EventRef, IndexStore, SearchHit } from '../../src/index/store.ts';
import { createApp } from '../../src/server/app.ts';
import { loadOrCreateToken } from '../../src/server/token.ts';

const PORT = 4790;
const TOKEN = 'tok-hardening';
const HOST = `127.0.0.1:${PORT}`;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9]);

let dir: string;
let app: ReturnType<typeof createApp>;
const refs: EventRef[] = [];

const parseLine: ParseLine = (line, firstSeq) => [
  { seq: firstSeq, role: 'user', visibility: 'conversation', blocks: JSON.parse(line.text) as Block[], line: line.line, offset: line.offset, length: line.length },
];
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

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'ah-hard-')));
  const root = join(dir, 'root');
  const elsewhere = join(dir, 'elsewhere');
  mkdirSync(root);
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, 'shot.png'), PNG);
  writeFileSync(join(elsewhere, 'notes.txt'), 'secret notes');
  symlinkSync(join(elsewhere, 'notes.txt'), join(elsewhere, 'sneaky.png'));
  const lines: Block[][] = [
    [
      { type: 'image', mediaType: 'text/html', size: 20, data: Buffer.from('<script>alert(1)</script>').toString('base64') },
      { type: 'image', mediaType: 'image/png', size: 0, filePath: join(elsewhere, 'shot.png') },
      { type: 'image', mediaType: 'image/png', size: 0, filePath: join(elsewhere, 'notes.txt') },
      { type: 'image', mediaType: 'image/png', size: 0, filePath: join(elsewhere, 'sneaky.png') },
      { type: 'image', mediaType: 'image/svg+xml', size: 10, data: Buffer.from('<svg/>').toString('base64') },
    ],
    [{ type: 'text', text: 'some words before the <b>needle</b> and after' }],
  ];
  let offset = 0;
  let text = '';
  lines.forEach((l, i) => {
    const s = JSON.stringify(l);
    const length = Buffer.byteLength(s);
    refs.push({ sessionId: 'fake:a/b', seq: i, lineEventIndex: 0, lineFirstSeq: i, line: i, offset, length, visibility: 'conversation', offBranch: false });
    text += s + '\n';
    offset += length + 1;
  });
  const file = join(root, 's.jsonl');
  writeFileSync(file, text);
  const meta: SessionMeta = {
    id: 'fake:a/b', sourceId: 'fake', nativeId: 'a/b', filePath: file, projectKey: 'path:/p', projectPath: '/p',
    eventCount: 2, messageCount: 2, imageCount: 0, models: [], links: [],
  };
  const hit: SearchHit = { sessionId: meta.id, seq: 1, projectKey: 'path:/p', projectPath: '/p', role: 'user', snippet: 'stale' };
  const store: IndexStore = {
    status: () => ({ state: 'idle', filesDone: 1, filesTotal: 1, sessionCount: 1 }),
    listProjects: () => [],
    listSessions: () => ({ items: [meta] }),
    getSession: (id) => (id === meta.id ? meta : undefined),
    getSubSessions: () => [],
    listEventRefs: () => ({ items: refs, total: refs.length }),
    getEventRef: (_id, seq) => refs.find((r) => r.seq === seq),
    toolLinks: () => new Map(),
    outline: () => [],
    search: () => ({ items: [hit] }),
    onChange: () => () => {},
  };
  app = createApp({ store, adapters: new Map([['fake', adapter]]), token: TOKEN, port: PORT, allowedRoots: [root], webDir: join(dir, 'web') });
});

const get = (path: string, headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}` }) =>
  app.request(`http://${HOST}${path}`, { headers: { Host: HOST, ...headers } });
const blob = (path: string) => get(`/api/sessions/${encodeURIComponent('fake:a/b')}/blob?seq=0&path=${path}`);

describe('auth', () => {
  it('401s /api with a JSON body the UI can recognise', async () => {
    const res = await get('/api/status', {});
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('sets a long-lived, port-scoped cookie', async () => {
    const c = (await get(`/?t=${TOKEN}`, {})).headers.get('set-cookie') ?? '';
    expect(c).toContain(`agentdesk_token_${PORT}=${TOKEN}`);
    expect(c).toMatch(/Max-Age=\d{6,}/);
  });

  it('persists the token per cache dir with 0600 perms; reset rotates it', () => {
    const cache = mkdtempSync(join(tmpdir(), 'ah-tok-'));
    const t1 = loadOrCreateToken(cache);
    expect(t1).toMatch(/^[\w-]{43}$/);
    expect(statSync(join(cache, 'token')).mode & 0o777).toBe(0o600);
    expect(loadOrCreateToken(cache)).toBe(t1);
    const t2 = loadOrCreateToken(cache, true);
    expect(t2).not.toBe(t1);
    expect(readFileSync(join(cache, 'token'), 'utf8').trim()).toBe(t2);
    writeFileSync(join(cache, 'token'), 'short');
    expect(loadOrCreateToken(cache)).not.toBe('short');
  });
});

describe('session ids with "/" (sub-agents)', () => {
  it('route to the session when URL-encoded', async () => {
    const res = await get(`/api/sessions/${encodeURIComponent('fake:a/b')}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as SessionMeta).id).toBe('fake:a/b');
  });
});

describe('blob hardening', () => {
  it('never serves active content types inline', async () => {
    const res = await blob('0');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toBe('attachment');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    const svg = await blob('4');
    expect(svg.headers.get('content-type')).toBe('image/svg+xml');
    expect(svg.headers.get('content-security-policy')).toContain('sandbox');
  });

  it('serves a referenced image file outside the roots, but not other files or symlinks to them', async () => {
    const ok = await blob('1');
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await ok.arrayBuffer()).equals(PNG)).toBe(true);
    expect((await blob('2')).status).toBe(403);
    expect((await blob('3')).status).toBe(403);
  });
});

describe('search', () => {
  it('rebuilds snippets from the source event and passes projectPath', async () => {
    const res = await get('/api/search?q=needle');
    const body = (await res.json()) as { items: (SearchHit & { snippet: string })[] };
    expect(body.items[0]!.snippet).toBe('some words before the &lt;b&gt;<mark>needle</mark>&lt;/b&gt; and after');
    expect(body.items[0]!.projectPath).toBe('/p');
  });
});
