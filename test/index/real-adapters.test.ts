/**
 * Indexer + store behaviour with the real adapters over the synthetic fixtures
 * (copied into a temp dir so tests can mutate them).
 */
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeCodeAdapter } from '../../src/adapters/claude-code/index.ts';
import { codexAdapter } from '../../src/adapters/codex/index.ts';
import type { DiscoveredFile } from '../../src/core/adapter.ts';
import type { ChatEvent } from '../../src/core/types.ts';
import { indexAll } from '../../src/index/indexer.ts';
import { startIndexer } from '../../src/index/run.ts';
import { openDb } from '../../src/index/schema.ts';
import { SqliteIndexStore } from '../../src/index/sqlite-store.ts';
import { fakeAdapter } from './fake-adapter.ts';

const FIX = resolve('test/fixtures');
const MAIN = '11111111-1111-4111-8111-111111111111';
const CODEX_FILE = 'rollout-2030-01-01T10-00-00-11111111-2222-3333-4444-555555555555.jsonl';

let dir: string;
let claudeRoot: string;
let codexRoot: string;
let db: DatabaseSync;
const dbs: DatabaseSync[] = [];
const adapters = [claudeCodeAdapter, codexAdapter];

const openTmp = (name = 'x.db') => {
  const d = openDb(join(dir, name));
  dbs.push(d);
  return d;
};
const run = (d = db, extraCodexRoots: string[] = []) =>
  indexAll(d, adapters, { 'claude-code': [claudeRoot], codex: [codexRoot, ...extraCodexRoots] });
const projectDir = () => join(claudeRoot, '-Users-alice-code-demo-app');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ah-real-'));
  claudeRoot = join(dir, 'claude');
  codexRoot = join(dir, 'codex');
  cpSync(join(FIX, 'claude-code/projects'), claudeRoot, { recursive: true });
  mkdirSync(join(codexRoot, '2030/01/01'), { recursive: true });
  cpSync(join(FIX, 'codex', CODEX_FILE), join(codexRoot, '2030/01/01', CODEX_FILE));
  db = openTmp();
});
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
  rmSync(dir, { recursive: true, force: true });
});

type EvRow = { session_id: string; seq: number; line: number; offset: number; length: number; line_first_seq: number; visibility: string; role: string };
const eventRows = (d: DatabaseSync) =>
  d.prepare('SELECT session_id, seq, line, offset, length, line_first_seq, visibility, role FROM events ORDER BY session_id, seq').all() as unknown as EvRow[];

/** Re-parse every indexed event the way the server does and check it is the same event. */
function checkRandomAccess(d: DatabaseSync): number {
  let n = 0;
  const sessions = d.prepare('SELECT id, source_id, native_id, file_path, project_key FROM sessions').all() as Record<string, string>[];
  for (const s of sessions) {
    const adapter = s.source_id === 'codex' ? codexAdapter : claudeCodeAdapter;
    const buf = readFileSync(s.file_path!);
    const file: DiscoveredFile = { path: s.file_path!, nativeId: s.native_id!, projectKey: s.project_key! };
    for (const r of eventRows(d).filter((e) => e.session_id === s.id)) {
      const text = buf.toString('utf8', r.offset, r.offset + r.length);
      const evs: ChatEvent[] = adapter.parseLine({ line: r.line, offset: r.offset, length: r.length, text }, r.line_first_seq, file);
      const ev = evs[r.seq - r.line_first_seq];
      expect(ev?.seq).toBe(r.seq);
      expect(ev?.visibility).toBe(r.visibility);
      expect(ev?.role).toBe(r.role);
      n++;
    }
  }
  return n;
}

describe('seq consistency between stateful parsers and parseLine', () => {
  it('holds for a full index and for an index built by appending byte chunks (partial lines, CRLF)', async () => {
    await run();
    const full = eventRows(db);
    expect(full.length).toBeGreaterThan(20);
    expect(checkRandomAccess(db)).toBe(full.length);

    // Rebuild every session file by appending odd-sized chunks, indexing after each.
    const files = [
      join(projectDir(), `${MAIN}.jsonl`),
      join(projectDir(), MAIN, 'subagents', 'agent-abc123.jsonl'),
      join(codexRoot, '2030/01/01', CODEX_FILE),
    ];
    const contents = files.map((f) => readFileSync(f));
    const db2 = openTmp('chunks.db');
    for (const f of files) writeFileSync(f, '');
    const longest = Math.max(...contents.map((c) => c.length));
    for (let pos = 0; pos < longest; pos += 997) {
      contents.forEach((c, i) => appendFileSync(files[i]!, c.subarray(pos, pos + 997)));
      await run(db2);
    }
    expect(eventRows(db2)).toEqual(full);
    expect(checkRandomAccess(db2)).toBe(full.length);
    const sess = (d: DatabaseSync) => d.prepare('SELECT * FROM sessions ORDER BY id').all();
    expect(sess(db2)).toEqual(sess(db));
  });
});

describe('sub-agent sidecar', () => {
  it('a .meta.json that appears after the sub-agent file was indexed is picked up', async () => {
    const sub = join(projectDir(), MAIN, 'subagents');
    const metaPath = join(sub, 'agent-abc123.meta.json');
    const meta = readFileSync(metaPath);
    rmSync(metaPath);
    await run();
    const id = `claude-code:${MAIN}/agent-abc123`;
    const store = new SqliteIndexStore(db);
    expect(store.getSession(id)?.agentDescription).toBeUndefined();
    writeFileSync(metaPath, meta);
    const r = await run();
    expect(r.indexed).toBe(1);
    expect(store.getSession(id)?.agentDescription).toBe('Find the config');
    expect(store.getSession(id)?.parentToolUseId).toBe('toolu_agent1');
    expect((await run()).indexed).toBe(0);
  });
});

describe('same session id in two files', () => {
  it('both files are indexed without mixing rows; removing one keeps the other', async () => {
    const archived = join(dir, 'archived');
    mkdirSync(archived);
    cpSync(join(codexRoot, '2030/01/01', CODEX_FILE), join(archived, CODEX_FILE));
    const r = await run(db, [archived]);
    expect(r.errors).toEqual([]);
    const rows = db.prepare("SELECT id, file_path, event_count FROM sessions WHERE source_id = 'codex' ORDER BY id").all() as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.event_count).toBe(rows[1]!.event_count);
    expect(checkRandomAccess(db)).toBe(eventRows(db).length);

    rmSync(join(codexRoot, '2030/01/01', CODEX_FILE));
    await run(db, [archived]);
    const left = db.prepare("SELECT id, file_path, event_count FROM sessions WHERE source_id = 'codex'").all() as Record<string, unknown>[];
    expect(left).toHaveLength(1);
    expect(left[0]!.file_path).toBe(join(archived, CODEX_FILE));
    expect(Number((db.prepare('SELECT count(*) n FROM events WHERE session_id = ?').get(left[0]!.id as string) as { n: number }).n)).toBe(
      left[0]!.event_count,
    );
  });
});

describe('search', () => {
  it('collapses copies of the same record (forked sessions, copied sub-agent files)', async () => {
    // a fork copies the parent's history (same record uuids) into a new session file,
    // and the sub-agent dir is copied along with it
    const fork = '33333333-3333-4333-8333-333333333333';
    cpSync(join(projectDir(), `${MAIN}.jsonl`), join(projectDir(), `${fork}.jsonl`));
    cpSync(join(projectDir(), MAIN), join(projectDir(), fork), { recursive: true });
    await run();
    const store = new SqliteIndexStore(db);
    const q = (s: string) => store.search({ q: s, limit: 50 }).items;
    const hits = q('config');
    expect(hits.length).toBeGreaterThan(0);
    const keys = hits.map((h) => `${h.sessionId.replace(fork, MAIN)}#${h.seq}`);
    expect(new Set(keys).size).toBe(keys.length);
    // every original hit is still found exactly once
    const before = openTmp('nofork.db');
    rmSync(join(projectDir(), `${fork}.jsonl`));
    rmSync(join(projectDir(), fork), { recursive: true });
    await run(before);
    expect(hits.length).toBe(new SqliteIndexStore(before).search({ q: 'config', limit: 50 }).items.length);
  });

  it('ranks human prompts and assistant prose above tool output', async () => {
    const root = join(dir, 'fake', 'p');
    mkdirSync(root, { recursive: true });
    const L = (o: object) => JSON.stringify(o) + '\n';
    // many tool outputs that mention the term a lot, one prompt that mentions it once
    let text = '';
    for (let i = 0; i < 5; i++) text += L({ k: 'detail', text: 'zebra zebra zebra stripes and zebra facts' });
    text += L({ k: 'assistant', text: 'here is a long answer that mentions a zebra once among many other words' });
    text += L({ k: 'user', text: 'tell me about the zebra please, with a fairly long prompt text here' });
    writeFileSync(join(root, 's.jsonl'), text);
    await indexAll(db, [fakeAdapter], { fake: [join(dir, 'fake')] });
    const hits = new SqliteIndexStore(db).search({ q: 'zebra', limit: 10 }).items;
    expect(hits.map((h) => h.seq).slice(0, 2)).toEqual([6, 5]);
  });

  it('reports projectPath and FTS rows are cleaned up on re-index', async () => {
    await run();
    const store = new SqliteIndexStore(db);
    const hit = store.search({ q: 'config', limit: 5 }).items[0]!;
    expect(hit.projectPath).toBe('/Users/alice/code/demo-app');
    const ftsDocs = () => Number((db.prepare('SELECT count(*) n FROM events_fts_docsize').get() as { n: number }).n);
    const ftsEvents = () => Number((db.prepare("SELECT count(*) n FROM events WHERE visibility != 'meta'").get() as { n: number }).n);
    const n = ftsDocs();
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(ftsEvents());
    // rewrite (not append) a file: full re-index must not leave orphan FTS rows
    const f = join(projectDir(), `${MAIN}.jsonl`);
    const lines = readFileSync(f, 'utf8').split('\n');
    writeFileSync(f, lines.slice(0, 10).join('\n') + '\n');
    await run();
    expect(ftsDocs()).toBeLessThan(n);
    const orphans = db.prepare('SELECT count(*) n FROM events_fts_docsize WHERE id NOT IN (SELECT id FROM events)').get() as { n: number };
    expect(Number(orphans.n)).toBe(0);
  });
});

describe('projects', () => {
  it('merges sessions from different agents in the same folder; groups Claude scratch dirs as "No folder"', async () => {
    // a Codex session in the same folder as the Claude Code demo-app project
    const codexFile = join(codexRoot, '2030/01/01', CODEX_FILE);
    writeFileSync(codexFile, readFileSync(codexFile, 'utf8').replaceAll('/work/demo-app', '/Users/alice/code/demo-app/'));
    // two Claude desktop "no folder" chats
    for (const id of ['a', 'b']) {
      const pdir = join(claudeRoot, `-Users-alice-Library-Application-Support-Claude-scratch-workspaces-${id}`);
      mkdirSync(pdir);
      const cwd = `/Users/alice/Library/Application Support/Claude/scratch-workspaces/${id}/scratch`;
      writeFileSync(
        join(pdir, `4444444${id === 'a' ? 4 : 5}-4444-4444-8444-444444444444.jsonl`),
        JSON.stringify({ type: 'user', uuid: `u-${id}`, cwd, timestamp: '2030-02-01T00:00:00Z', message: { role: 'user', content: `hello ${id}` } }) + '\n',
      );
    }
    await run();
    const store = new SqliteIndexStore(db);
    const projects = store.listProjects({});
    const demo = projects.filter((p) => p.path === '/Users/alice/code/demo-app');
    expect(demo).toHaveLength(1);
    expect(demo[0]!.sessionCount).toBe(2);
    expect(demo[0]!.displayName).toBe('demo-app');
    const nofolder = projects.find((p) => p.displayName === 'No folder')!;
    expect(nofolder.sessionCount).toBe(2);
    expect(nofolder.path).toBeUndefined();
    // filtering by the merged key returns sessions of both agents
    const sessions = store.listSessions({ projectKey: demo[0]!.key, limit: 10 }).items;
    expect(new Set(sessions.map((s) => s.sourceId))).toEqual(new Set(['claude-code', 'codex']));
    expect(store.listProjects({ sourceId: 'codex' }).map((p) => [p.key, p.sessionCount])).toEqual([[demo[0]!.key, 1]]);
    expect(store.search({ q: 'hello', projectKey: nofolder.key, limit: 10 }).items).toHaveLength(2);
  });
});

describe('worker supervisor', () => {
  it('restarts a crashed worker and finishes indexing', async () => {
    const root = join(dir, 'fake', 'p');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'a.jsonl'), JSON.stringify({ k: 'user', text: 'hello' }) + '\n');
    writeFileSync(join(root, 'b.jsonl'), JSON.stringify({ k: 'user', text: 'world' }) + '\n');
    const marker = join(dir, 'crashed-once');
    process.env.AH_TEST_CRASH_MARKER = marker;
    const ix = await startIndexer({
      dbPath: join(dir, 'w.db'),
      adapters: [fakeAdapter],
      roots: new Map([['fake', [join(dir, 'fake')]]]),
      adaptersModule: resolve('test/index/crashing-adapter.ts'),
      watch: false,
    });
    try {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline && ix.store.listSessions({ limit: 10 }).items.length < 2) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(readFileSync(marker, 'utf8')).toBe('1');
      expect(ix.store.listSessions({ limit: 10 }).items.map((s) => s.id).sort()).toEqual(['fake:a', 'fake:b']);
    } finally {
      delete process.env.AH_TEST_CRASH_MARKER;
      await ix.stop();
    }
  }, 30000);
});
