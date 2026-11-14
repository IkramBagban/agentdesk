import { appendFileSync, mkdirSync, mkdtempSync, rmSync, truncateSync, utimesSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { indexAll } from '../../src/index/indexer.ts';
import { cacheDir } from '../../src/index/paths.ts';
import { openDb, SCHEMA_VERSION } from '../../src/index/schema.ts';
import { sanitizeFtsQuery } from '../../src/index/snippet.ts';
import { SqliteIndexStore } from '../../src/index/sqlite-store.ts';
import { startIndexer } from '../../src/index/run.ts';
import { fakeAdapter } from './fake-adapter.ts';

let dir: string;
let root: string;
let db: DatabaseSync;
const dbs: DatabaseSync[] = [];

const L = (o: object) => JSON.stringify(o);
const run = (d: DatabaseSync = db, only?: Set<string>) =>
  indexAll(d, [fakeAdapter], { fake: [root] }, undefined, only ? { only } : {});
const open = (p = join(dir, 'x.db')) => {
  const d = openDb(p);
  dbs.push(d);
  return d;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ah-index-'));
  root = join(dir, 'root', 'projA');
  mkdirSync(root, { recursive: true });
  db = open();
});
afterEach(() => {
  for (const d of dbs.splice(0)) {
    try {
      d.close();
    } catch {}
  }
  rmSync(dir, { recursive: true, force: true });
});

const f = (name: string) => join(root, name + '.jsonl');
const events = (d = db) => d.prepare('SELECT session_id, seq, line, offset, length, line_first_seq, role, visibility, ts, off_branch, preview FROM events ORDER BY session_id, seq').all();
// events_fts is contentless: count its documents via the docsize shadow table
const ftsRows = (d = db) => Number((d.prepare('SELECT count(*) n FROM events_fts_docsize').get() as { n: number }).n);

describe('byte offsets', () => {
  it('are exact for multi-byte UTF-8 and CRLF, and match file bytes', async () => {
    const lines = [
      L({ k: 'user', text: 'héllo wörld 日本語 🎉', ts: '2025-01-01T00:00:00Z' }),
      '', // blank line still counts as a line
      L({ k: 'assistant', text: 'ok ✓', ts: '2025-01-01T00:00:01Z', n: 2 }),
      L({ k: 'user', text: 'last 🙂' }),
    ];
    writeFileSync(f('s1'), lines[0] + '\r\n' + lines[1] + '\n' + lines[2] + '\r\n' + lines[3] + '\n');
    await run();
    const buf = readFileSync(f('s1'));
    const rows = events() as any[];
    expect(rows.length).toBe(4);
    for (const r of rows) {
      const slice = buf.subarray(r.offset, r.offset + r.length).toString('utf8');
      expect(JSON.parse(slice).k).toBeTruthy();
    }
    expect(rows.map((r) => r.line)).toEqual([0, 2, 2, 3]);
    expect(rows[1].line_first_seq).toBe(1);
    expect(rows[2].line_first_seq).toBe(1);
    expect(rows[2].seq - rows[2].line_first_seq).toBe(1);
  });

  it('handles a final line without newline, then resumes correctly when completed', async () => {
    writeFileSync(f('s'), L({ k: 'user', text: 'a' }) + '\n' + L({ k: 'assistant', text: 'partial' }));
    await run();
    expect((events() as any[]).length).toBe(2);
    const fr = db.prepare('SELECT indexed_size, indexed_lines FROM files').get() as any;
    expect(fr.indexed_size).toBe(Buffer.byteLength(L({ k: 'user', text: 'a' })) + 1);
    expect(fr.indexed_lines).toBe(1);
    appendFileSync(f('s'), '\n' + L({ k: 'user', text: 'b' }) + '\n');
    await run();
    expect((events() as any[]).map((r) => r.seq)).toEqual([0, 1, 2]);
  });
});

describe('incremental', () => {
  const mk = (i: number) => L({ k: i % 2 ? 'assistant' : 'user', text: `msg ${i} ünï ${'x'.repeat(i)}`, ts: `2025-01-01T00:00:${String(i).padStart(2, '0')}Z`, ...(i === 3 ? { off: true } : {}), ...(i === 4 ? { tool: { id: 'tu1', name: 'Task', input: { q: 'find me' }, sub: 'fake:agent-s-1' } } : {}) });

  it('append resumes and equals a full re-index', async () => {
    const first = Array.from({ length: 6 }, (_, i) => mk(i)).join('\n') + '\n';
    const more = Array.from({ length: 5 }, (_, i) => mk(i + 6)).join('\n') + '\n';
    writeFileSync(f('s'), first);
    const r1 = await run();
    expect(r1.indexed).toBe(1);
    appendFileSync(f('s'), more);
    const r2 = await run();
    expect(r2.resumed).toBe(1);

    const db2 = open(join(dir, 'y.db'));
    await run(db2);
    expect(events(db)).toEqual(events(db2));
    expect(ftsRows(db)).toBe(ftsRows(db2));
    const sess = (d: DatabaseSync) => d.prepare('SELECT * FROM sessions').all();
    expect(sess(db)).toEqual(sess(db2));
    expect(db.prepare('SELECT * FROM tool_links').all()).toEqual(db2.prepare('SELECT * FROM tool_links').all());
  });

  it('unchanged files are skipped', async () => {
    writeFileSync(f('s'), mk(0) + '\n');
    await run();
    const r = await run();
    expect(r.skipped).toBe(1);
    expect(r.indexed + r.resumed).toBe(0);
  });

  it('changed-but-not-grown (same size) triggers full reindex', async () => {
    writeFileSync(f('s'), L({ k: 'user', text: 'aaaa' }) + '\n');
    await run();
    writeFileSync(f('s'), L({ k: 'user', text: 'bbbb' }) + '\n');
    utimesSync(f('s'), new Date(), new Date(Date.now() + 5000));
    const r = await run();
    expect(r.indexed).toBe(1);
    expect(r.resumed).toBe(0);
    expect((events() as any[])[0].preview).toBe('bbbb');
    expect(ftsRows()).toBe(1);
  });

  it('rewritten-and-larger file (prefix changed) is fully re-indexed, not resumed', async () => {
    writeFileSync(f('s'), L({ k: 'user', text: 'aaaa' }) + '\n');
    await run();
    writeFileSync(f('s'), L({ k: 'user', text: 'zzzz' }) + '\n' + L({ k: 'user', text: 'more' }) + '\n');
    const r = await run();
    expect(r.indexed).toBe(1);
    expect((events() as any[]).map((e) => e.preview)).toEqual(['zzzz', 'more']);
  });

  it('truncated file is re-indexed', async () => {
    writeFileSync(f('s'), mk(0) + '\n' + mk(1) + '\n');
    await run();
    truncateSync(f('s'), Buffer.byteLength(mk(0)) + 1);
    await run();
    expect((events() as any[]).length).toBe(1);
  });

  it('deleted files are cleaned up (events, fts, links, sessions, files)', async () => {
    writeFileSync(f('s'), mk(4) + '\n' + mk(5) + '\n');
    writeFileSync(f('keep'), mk(0) + '\n');
    await run();
    expect(ftsRows()).toBeGreaterThan(0);
    rmSync(f('s'));
    const r = await run();
    expect(r.removed).toBe(1);
    expect((db.prepare('SELECT id FROM sessions').all() as any[]).map((x) => x.id)).toEqual(['fake:keep']);
    expect((events() as any[]).every((e) => e.session_id === 'fake:keep')).toBe(true);
    expect(ftsRows()).toBe(1);
    expect(db.prepare('SELECT count(*) n FROM tool_links').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) n FROM files').get()).toEqual({ n: 1 });
  });

  it('single-file mode only touches requested paths', async () => {
    writeFileSync(f('a'), mk(0) + '\n');
    writeFileSync(f('b'), mk(1) + '\n');
    await run();
    appendFileSync(f('a'), mk(2) + '\n');
    appendFileSync(f('b'), mk(3) + '\n');
    const r = await run(db, new Set([f('a')]));
    expect(r.filesTotal).toBe(1);
    expect(r.resumed).toBe(1);
    expect((db.prepare("SELECT event_count n FROM sessions WHERE id='fake:b'").get() as any).n).toBe(1);
  });

  it('a throwing line and a bad file do not stop the run; errors recorded', async () => {
    writeFileSync(f('s'), L({ k: 'user', text: 'a' }) + '\n' + L({ k: 'boom' }) + '\n' + 'not json\n' + L({ k: 'user', text: 'b' }) + '\n');
    writeFileSync(f('ok'), mk(0) + '\n');
    await run();
    expect((db.prepare("SELECT error_count n FROM files WHERE path = ?").get(f('s')) as any).n).toBe(1);
    expect((events() as any[]).length).toBe(3);
  });
});

describe('sessions / links / branch', () => {
  it('applies offBranch, tool links (event + sub-agent), never indexes base64', async () => {
    writeFileSync(
      f('main'),
      [
        L({ k: 'user', text: 'start', ts: '2025-01-01T00:00:00Z' }),
        L({ k: 'assistant', text: 'abandoned', off: true, ts: '2025-01-01T00:00:01Z' }),
        L({ k: 'assistant', text: 'spawn agent', tool: { id: 'tu9', name: 'Task', input: { prompt: 'zebra' }, sub: 'fake:agent-main-1' }, img: true, ts: '2025-01-01T00:00:02Z' }),
      ].join('\n') + '\n',
    );
    writeFileSync(f('agent-main-1'), L({ k: 'hdr', parentToolUseId: 'tu-other' }) + '\n' + L({ k: 'assistant', text: 'sub work' }) + '\n');
    await run();
    const store = new SqliteIndexStore(db);
    const refs = store.listEventRefs({ sessionId: 'fake:main', view: 'all', from: 0, limit: 10, direction: 'forward' });
    expect(refs.items.map((r) => r.offBranch)).toEqual([false, true, false]);
    expect(db.prepare("SELECT count(*) n FROM events_fts WHERE events_fts MATCH 'AAAAAAAA*'").get()).toEqual({ n: 0 });
    const links = store.toolLinks('fake:main');
    expect(links.get('tu9')).toBe('fake:agent-main-1');
    expect(links.get('tu-other')).toBe('fake:agent-main-1');
    expect(store.getSubSessions('fake:main').map((s) => s.id)).toEqual(['fake:agent-main-1']);
    // reindexing the parent keeps the sub-agent's declared link
    appendFileSync(f('main'), L({ k: 'user', text: 'more' }) + '\n');
    await run();
    expect(store.toolLinks('fake:main').get('tu-other')).toBe('fake:agent-main-1');
  });
});

describe('store: pagination', () => {
  it('sessions: stable keyset paging with ties on updated_at, sub-sessions excluded', async () => {
    for (let i = 0; i < 7; i++) {
      writeFileSync(f('s' + i), L({ k: 'user', text: 't' + i, ts: i < 4 ? '2025-01-01T00:00:00Z' : `2025-01-0${i}T00:00:00Z` }) + '\n');
    }
    writeFileSync(f('agent-s0-1'), L({ k: 'assistant', text: 'sub', ts: '2030-01-01T00:00:00Z' }) + '\n');
    await run();
    const store = new SqliteIndexStore(db);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const p = store.listSessions({ limit: 3, ...(cursor ? { cursor } : {}) });
      seen.push(...p.items.map((s) => s.id));
      cursor = p.nextCursor;
      if (!cursor) break;
    }
    expect(seen.length).toBe(7);
    expect(new Set(seen).size).toBe(7);
    expect(seen.includes('fake:agent-s0-1')).toBe(false);
    expect(store.listSessions({ limit: 50, includeSubSessions: true }).items.length).toBe(8);
    expect(store.listSessions({ limit: 50, q: 't3' }).items.map((s) => s.id)).toEqual(['fake:s3']);
    expect(store.listSessions({ limit: 50, q: '%' }).items.length).toBe(0);
    const pr = store.listProjects({});
    expect(pr).toHaveLength(1);
    expect(pr[0]!.sessionCount).toBe(7);
  });

  it('event refs: forward / backward / views / MAX_SAFE_INTEGER = last page', async () => {
    const lines = [];
    for (let i = 0; i < 10; i++) lines.push(L({ k: i % 5 === 4 ? 'meta' : 'user', text: 'e' + i }));
    writeFileSync(f('s'), lines.join('\n') + '\n');
    await run();
    const store = new SqliteIndexStore(db);
    const fw = store.listEventRefs({ sessionId: 'fake:s', view: 'all', from: 0, limit: 4, direction: 'forward' });
    expect(fw.items.map((r) => r.seq)).toEqual([0, 1, 2, 3]);
    expect(fw.nextFrom).toBe(4);
    expect(fw.prevFrom).toBeUndefined();
    expect(fw.total).toBe(10);
    const fw2 = store.listEventRefs({ sessionId: 'fake:s', view: 'all', from: 8, limit: 4, direction: 'forward' });
    expect(fw2.items.map((r) => r.seq)).toEqual([8, 9]);
    expect(fw2.nextFrom).toBeUndefined();
    expect(fw2.prevFrom).toBe(8);
    const bw = store.listEventRefs({ sessionId: 'fake:s', view: 'all', from: 6, limit: 4, direction: 'backward' });
    expect(bw.items.map((r) => r.seq)).toEqual([2, 3, 4, 5]);
    expect(bw.prevFrom).toBe(2);
    expect(bw.nextFrom).toBe(6);
    const last = store.listEventRefs({ sessionId: 'fake:s', view: 'all', from: Number.MAX_SAFE_INTEGER, limit: 3, direction: 'backward' });
    expect(last.items.map((r) => r.seq)).toEqual([7, 8, 9]);
    expect(last.nextFrom).toBeUndefined();
    const conv = store.listEventRefs({ sessionId: 'fake:s', view: 'conversation', from: 0, limit: 100, direction: 'forward' });
    expect(conv.items.map((r) => r.seq)).toEqual([0, 1, 2, 3, 5, 6, 7, 8]);
    expect(conv.total).toBe(8);
    expect(store.getEventRef('fake:s', 5)?.line).toBe(5);
    expect(store.getEventRef('fake:s', 99)).toBeUndefined();
  });
});

describe('store: search', () => {
  beforeEach(async () => {
    writeFileSync(
      f('s'),
      [
        L({ k: 'user', text: 'please explain <script>alert(1)</script> & "quotes"', ts: '2025-01-01T00:00:00Z' }),
        L({ k: 'assistant', text: 'The quick brown fox jumps; café déjà vu', ts: '2025-01-01T00:00:01Z' }),
        L({ k: 'detail', text: 'tool output about foxes', ts: '2025-01-01T00:00:02Z' }),
        L({ k: 'meta', text: 'secretmeta hidden' }),
      ].join('\n') + '\n',
    );
    await run();
  });

  it('escapes HTML except <mark>', () => {
    const store = new SqliteIndexStore(db);
    const r = store.search({ q: 'script', limit: 10 });
    expect(r.items).toHaveLength(1);
    const s = r.items[0]!.snippet;
    expect(s).toContain('<mark>script</mark>');
    expect(s).toContain('&lt;');
    expect(s).not.toMatch(/<(?!\/?mark>)/);
    expect(s).toContain('&amp;');
  });

  it('does not throw on syntax characters and operators', () => {
    const store = new SqliteIndexStore(db);
    for (const q of ['"foo', 'a OR', '*', 'NEAR(', 'foo AND', '(', ')', '-', 'col:val', '^x', '""', '   ', "it's", 'a"b"c', '\u0000']) {
      expect(() => store.search({ q, limit: 5 })).not.toThrow();
    }
    expect(store.search({ q: '*', limit: 5 }).items).toEqual([]);
    expect(sanitizeFtsQuery('a OR')).toBe('"a" "OR"*');
  });

  it('multi-word AND, prefix on last word, diacritics, ranking/paging, filters', () => {
    const store = new SqliteIndexStore(db);
    expect(store.search({ q: 'quick fox', limit: 5 }).items.map((h) => h.seq)).toEqual([1]);
    expect(store.search({ q: 'quick cat', limit: 5 }).items).toEqual([]);
    expect(store.search({ q: 'fo', limit: 5 }).items.map((h) => h.seq).sort()).toEqual([1, 2]);
    expect(store.search({ q: 'cafe deja', limit: 5 }).items.map((h) => h.seq)).toEqual([1]);
    expect(store.search({ q: 'secretmeta', limit: 5 }).items).toEqual([]); // meta not indexed
    const p1 = store.search({ q: 'fo', limit: 1 });
    expect(p1.items).toHaveLength(1);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = store.search({ q: 'fo', limit: 1, cursor: p1.nextCursor! });
    expect(p2.items).toHaveLength(1);
    expect(p2.items[0]!.seq).not.toBe(p1.items[0]!.seq);
    expect(store.search({ q: 'fox', limit: 5, sourceId: 'nope' }).items).toEqual([]);
    expect(store.search({ q: 'fox', limit: 5, projectKey: 'projA' }).items.length).toBeGreaterThan(0);
  });

  it('content containing <mark> cannot inject markup', async () => {
    writeFileSync(f('t'), L({ k: 'user', text: 'zzz <mark>injected</mark> zzz' }) + '\n');
    await run();
    const store = new SqliteIndexStore(db);
    const r = store.search({ q: 'injected', limit: 5 });
    expect(r.items[0]!.snippet).toBe('zzz &lt;mark&gt;<mark>injected</mark>&lt;/mark&gt; zzz');
  });
});

describe('store: outline', () => {
  it('returns human prompts only, with offBranch', async () => {
    writeFileSync(f('s'), [
      L({ k: 'user', text: 'first ask', ts: '2025-01-01T00:00:00Z' }),
      L({ k: 'assistant', text: 'answer' }),
      L({ k: 'user', text: 'injected', syn: true }),
      L({ k: 'user', text: 'abandoned ask', off: true }),
      L({ k: 'meta', text: 'm' }),
      L({ k: 'user', text: 'final ask' }),
    ].join('\n') + '\n');
    await run();
    const o = new SqliteIndexStore(db).outline('fake:s');
    expect(o.map((x) => [x.seq, x.preview, x.offBranch])).toEqual([[0, 'first ask', false], [3, 'abandoned ask', true], [5, 'final ask', false]]);
    expect(o[0]!.timestamp).toBe('2025-01-01T00:00:00Z');
  });
});

describe('misc', () => {
  it('schema version mismatch rebuilds the DB', () => {
    const p = join(dir, 'v.db');
    const d = open(p);
    d.prepare('INSERT INTO files(path, source_id, size, mtime_ms, indexed_size, indexed_lines, parser_version) VALUES (?,?,?,?,?,?,?)').run('/x', 'fake', 1, 1, 1, 1, '1');
    d.prepare('UPDATE schema_version SET version = ?').run(SCHEMA_VERSION + 99);
    d.close();
    const d2 = open(p);
    expect(d2.prepare('SELECT count(*) n FROM files').get()).toEqual({ n: 0 });
    expect(d2.prepare('SELECT version FROM schema_version').get()).toEqual({ version: SCHEMA_VERSION });
  });

  it('cacheDir honours AGENTDESK_CACHE and platform defaults', () => {
    expect(cacheDir({ AGENTDESK_CACHE: '/c' }, 'linux')).toBe('/c');
    expect(cacheDir({ XDG_CACHE_HOME: '/xdg' }, 'linux')).toBe(join('/xdg', 'agentdesk'));
    expect(cacheDir({ LOCALAPPDATA: 'C:\\L' }, 'win32')).toContain('agentdesk');
    expect(cacheDir({}, 'darwin')).toContain('Library');
  });

  it('large line (3 MB) streams across chunk boundaries with right offsets', async () => {
    const big = 'é'.repeat(1_500_000);
    writeFileSync(f('big'), L({ k: 'user', text: 'small' }) + '\n' + L({ k: 'assistant', text: big }) + '\n' + L({ k: 'user', text: 'tail' }) + '\n');
    await run();
    const rows = events() as any[];
    const buf = readFileSync(f('big'));
    expect(rows).toHaveLength(3);
    expect(JSON.parse(buf.subarray(rows[2].offset, rows[2].offset + rows[2].length).toString()).text).toBe('tail');
    expect(rows[1].length).toBeGreaterThan(3_000_000);
    // FTS text is capped per event (16K chars); the docsize row holds its token count
    expect(ftsRows()).toBe(3);
    expect(statSync(f('big')).size).toBeGreaterThan(3_000_000);
  });
});

describe('worker (startIndexer)', () => {
  it('indexes in a worker thread, publishes changes, picks up appended files via watcher', async () => {
    writeFileSync(f('w'), L({ k: 'user', text: 'hello worker', ts: '2025-01-01T00:00:00Z' }) + '\n');
    const dbPath = join(dir, 'w.db');
    const ix = await startIndexer({
      dbPath,
      adapters: [fakeAdapter],
      roots: new Map([['fake', [root]]]),
      adaptersModule: resolve('test/index/fake-adapter.ts'),
      watch: true,
    });
    try {
      const updated: string[] = [];
      ix.store.onChange((e) => e.type === 'session-updated' && updated.push(e.sessionId));
      await ix.whenIdle();
      expect(ix.store.listSessions({ limit: 10 }).items.map((s) => s.id)).toEqual(['fake:w']);
      expect(ix.store.status().state).toBe('idle');
      writeFileSync(f('w2'), L({ k: 'user', text: 'second', ts: '2025-01-02T00:00:00Z' }) + '\n');
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && !ix.store.getSession('fake:w2')) await new Promise((r) => setTimeout(r, 100));
      expect(ix.store.getSession('fake:w2')).toBeTruthy();
      expect(updated).toContain('fake:w2');
    } finally {
      await ix.stop();
    }
  }, 20000);
});
