/**
 * App metadata overlays (Claude desktop app session files) and the nested
 * session tree. All ids / titles here are invented.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeCodeAdapter } from '../../src/adapters/claude-code/index.ts';
import { claudeAppSessionDirs, readClaudeAppOverlays } from '../../src/adapters/claude-code/overlays.ts';
import type { SessionOverlay, SourceAdapter } from '../../src/core/adapter.ts';
import type { SessionNode } from '../../src/core/types.ts';
import { indexAll } from '../../src/index/indexer.ts';
import { refreshOverlays } from '../../src/index/overlays.ts';
import { startIndexer } from '../../src/index/run.ts';
import { openDb } from '../../src/index/schema.ts';
import { SqliteIndexStore } from '../../src/index/sqlite-store.ts';
import { buildGraph } from '../../src/index/tree.ts';
import { fakeAdapter } from './fake-adapter.ts';

const L = (o: object) => JSON.stringify(o);
/** project key the indexer derives for a folder (backslashes on Windows, see projectKeyFor) */
const pathKey = (p: string) => `path:${normalize(p)}`;

let dir: string;
let root: string;
let db: DatabaseSync;
let store: SqliteIndexStore;
let overlays: Map<string, SessionOverlay>;
let overlayCalls = 0;
let parsed: string[] = [];

/** fake adapter + programmable overlays; records which files get parsed */
const adapter: SourceAdapter = {
  ...fakeAdapter,
  createParser(file) {
    parsed.push(file.nativeId);
    return fakeAdapter.createParser(file);
  },
  async overlays() {
    overlayCalls++;
    return { entries: new Map(overlays), watchPaths: [join(dir, 'app')] };
  },
};

const run = () => indexAll(db, [adapter], { fake: [join(dir, 'root')] });

/** write a fake session: folder = project key, cwd optional */
function session(id: string, updated: string, opts: { proj?: string; cwd?: string; title?: string } = {}) {
  const d = join(root, '..', opts.proj ?? 'projA');
  mkdirSync(d, { recursive: true });
  const lines = [
    L({ k: 'hdr', ...(opts.cwd ? { cwd: opts.cwd } : {}), ...(opts.title ? { title: opts.title } : {}) }),
    L({ k: 'user', text: `prompt of ${id}`, ts: updated }),
  ];
  writeFileSync(join(d, `${id}.jsonl`), lines.join('\n') + '\n');
}

const tree = (o: Partial<Parameters<SqliteIndexStore['listSessions']>[0]> = {}) =>
  store.listSessions({ tree: true, limit: 50, ...o });
const shape = (nodes: SessionNode[]): unknown => nodes.map((n) => (n.children.length ? { [n.nativeId]: shape(n.children) } : n.nativeId));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ah-overlay-'));
  root = join(dir, 'root', 'projA');
  mkdirSync(root, { recursive: true });
  db = openDb(join(dir, 'x.db'));
  store = new SqliteIndexStore(db);
  overlays = new Map();
  overlayCalls = 0;
  parsed = [];
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('tree listing', () => {
  it('nests spawned sessions two levels deep, sorted by activity, with app titles', async () => {
    session('root1', '2030-01-01T10:00:00Z', { title: 'own title' });
    session('kid1', '2030-01-01T11:00:00Z');
    session('kid2', '2030-01-01T12:00:00Z');
    session('grand', '2030-01-01T15:00:00Z');
    session('other', '2030-01-01T13:00:00Z');
    overlays.set('root1', { title: 'App Title' });
    overlays.set('kid1', { parentNativeId: 'root1', spawnKind: 'spawned' });
    overlays.set('kid2', { parentNativeId: 'root1', spawnKind: 'side' });
    overlays.set('grand', { parentNativeId: 'kid1', spawnKind: 'spawned' });
    await run();

    const page = tree();
    // the grandchild's activity (15:00) lifts root1 above "other" (13:00), and kid1 above kid2
    expect(shape(page.items)).toEqual([{ root1: [{ kid1: ['grand'] }, 'kid2'] }, 'other']);
    const r = page.items[0]!;
    expect(r.title).toBe('App Title');
    expect(r.activityAt).toBe('2030-01-01T15:00:00Z');
    expect(r.updatedAt).toBe('2030-01-01T10:00:00Z');
    const [k1, k2] = r.children;
    expect(k1!.spawnedFromSessionId).toBe('fake:root1');
    expect(k1!.spawnKind).toBe('spawned');
    expect(k2!.spawnKind).toBe('side');
    expect(k1!.children[0]!.spawnedFromSessionId).toBe('fake:kid1');

    // getSession is overlaid too
    expect(store.getSession('fake:root1')!.title).toBe('App Title');
    expect(store.getSession('fake:grand')!.spawnedFromSessionId).toBe('fake:kid1');
    // non-tree mode still lists everything flat
    const flat = store.listSessions({ limit: 50 });
    expect(flat.items.map((s) => s.nativeId)).toEqual(['grand', 'other', 'kid2', 'kid1', 'root1']);
    expect(flat.items.every((s) => s.children.length === 0)).toBe(true);
    // q matches the app title
    expect(store.listSessions({ limit: 50, q: 'app tit' }).items.map((s) => s.nativeId)).toEqual(['root1']);
  });

  it('pages roots with a stable keyset cursor', async () => {
    for (let i = 0; i < 5; i++) session(`r${i}`, `2030-01-0${i + 1}T00:00:00Z`);
    session('c', '2030-02-01T00:00:00Z');
    overlays.set('c', { parentNativeId: 'r0' });
    await run();
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const p = tree({ limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...p.items.map((n) => n.nativeId));
      cursor = p.nextCursor;
    } while (cursor);
    expect(seen).toEqual(['r0', 'r4', 'r3', 'r2', 'r1']);
  });

  it('archived: hide (default) / only / all; children of a hidden starter become roots', async () => {
    session('a', '2030-01-01T10:00:00Z');
    session('b', '2030-01-01T11:00:00Z');
    session('c', '2030-01-01T12:00:00Z');
    overlays.set('a', { archived: true });
    overlays.set('b', { parentNativeId: 'a' });
    overlays.set('c', { archived: false });
    await run();
    expect(shape(tree().items)).toEqual(['c', 'b']);
    expect(shape(tree({ archived: 'only' }).items)).toEqual(['a']);
    // b (11:00) lifts a, but c (12:00) is newer
    expect(shape(tree({ archived: 'all' }).items)).toEqual(['c', { a: ['b'] }]);
    expect(tree({ archived: 'all' }).items[1]!.archived).toBe(true);
    expect(store.listSessions({ limit: 50 }).items.map((s) => s.nativeId)).toEqual(['c', 'b']);
    // archived sessions are not counted
    expect(store.listProjects({}).map((p) => [p.key, p.sessionCount])).toEqual([['projA', 2]]);
  });

  it('a session whose starter is not indexed is a root', async () => {
    session('orphan', '2030-01-01T10:00:00Z');
    overlays.set('orphan', { parentNativeId: 'gone', spawnKind: 'spawned' });
    await run();
    const items = tree().items;
    expect(shape(items)).toEqual(['orphan']);
    expect(items[0]!.spawnedFromSessionId).toBeUndefined();
  });

  it('guards against cycles in the spawn graph', async () => {
    session('x', '2030-01-01T10:00:00Z');
    session('y', '2030-01-01T11:00:00Z');
    session('z', '2030-01-01T12:00:00Z');
    session('self', '2030-01-01T09:00:00Z');
    overlays.set('x', { parentNativeId: 'z' });
    overlays.set('y', { parentNativeId: 'x' });
    overlays.set('z', { parentNativeId: 'y' });
    overlays.set('self', { parentNativeId: 'self' });
    await run();
    const items = tree().items;
    // smallest id of the cycle (fake:x) loses its starter and becomes the root; nothing is lost
    expect(shape(items)).toEqual([{ x: [{ y: ['z'] }] }, 'self']);
    expect(items[0]!.spawnedFromSessionId).toBeUndefined();
  });

  it('groups worktree sessions and children under the root project', async () => {
    session('main', '2030-01-01T10:00:00Z', { proj: 'repo', cwd: '/w/repo' });
    session('wt', '2030-01-01T11:00:00Z', { proj: 'wt', cwd: '/w/repo/.claude/worktrees/feature-x' });
    session('lone', '2030-01-01T12:00:00Z', { proj: 'wt2', cwd: '/w/repo/.claude/worktrees/other/sub' });
    session('elsewhere', '2030-01-01T13:00:00Z', { proj: 'e', cwd: '/w/elsewhere' });
    session('appwt', '2030-01-01T14:00:00Z', { proj: 'aw', cwd: '/tmp/somewhere/wt' });
    overlays.set('wt', { parentNativeId: 'main' });
    overlays.set('elsewhere', { parentNativeId: 'main' });
    overlays.set('appwt', { projectPath: '/w/repo' });
    await run();
    const projects = store.listProjects({});
    expect(projects.map((p) => [p.key, p.sessionCount])).toEqual([[pathKey('/w/repo'), 5]]);
    const items = tree({ projectKey: pathKey('/w/repo') }).items;
    expect(shape(items)).toEqual(['appwt', { main: ['elsewhere', 'wt'] }, 'lone']);
    expect(items.every((n) => n.projectKey === pathKey('/w/repo'))).toBe(true);
    // the child keeps its own folder as projectPath
    expect(store.getSession('fake:elsewhere')!.projectPath).toBe('/w/elsewhere');
    expect(store.getSession('fake:elsewhere')!.projectKey).toBe(pathKey('/w/repo'));
    expect(tree({ projectKey: pathKey('/w/elsewhere') }).items).toEqual([]);
  });

  it('re-reads overlays without re-parsing chat files', async () => {
    session('s1', '2030-01-01T10:00:00Z');
    session('s2', '2030-01-01T11:00:00Z');
    await run();
    expect(parsed.sort()).toEqual(['s1', 's2']);
    expect(shape(tree().items)).toEqual(['s2', 's1']);

    parsed = [];
    overlays.set('s1', { parentNativeId: 's2', title: 'Renamed' });
    const res = await refreshOverlays(db, [adapter]);
    expect(res.changed).toEqual(['fake:s1']);
    expect(res.watchPaths.get('fake')).toEqual([join(dir, 'app')]);
    expect(parsed).toEqual([]);
    expect(shape(tree().items)).toEqual([{ s2: ['s1'] }]);
    expect(tree().items[0]!.children[0]!.title).toBe('Renamed');

    // unchanged → nothing to report; a full scan skips unchanged chat files
    expect((await refreshOverlays(db, [adapter])).changed).toEqual([]);
    const before = overlayCalls;
    const r = await run();
    expect(overlayCalls).toBe(before + 1);
    expect(r.skipped).toBe(2);
    expect(parsed).toEqual([]);

    overlays.clear();
    expect((await refreshOverlays(db, [adapter])).changed).toEqual(['fake:s1']);
    expect(shape(tree().items)).toEqual(['s2', 's1']);
  });

  it('builds a graph without overlays (no-op) and handles a throwing overlays()', async () => {
    session('s1', '2030-01-01T10:00:00Z');
    const broken: SourceAdapter = { ...adapter, overlays: () => Promise.reject(new Error('nope')) };
    const r = await indexAll(db, [broken], { fake: [join(dir, 'root')] });
    expect(r.errors).toEqual([]);
    expect(shape(tree().items)).toEqual(['s1']);
    expect(buildGraph([], []).nodes.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Claude desktop app files
// ---------------------------------------------------------------------------

describe('Claude app session files', () => {
  let app: string;
  const write = (acct: string, org: string, name: string, body: object | string) => {
    const d = join(app, 'claude-code-sessions', acct, org);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, name), typeof body === 'string' ? body : JSON.stringify(body));
  };
  const rec = (local: string, cli: string, extra: object = {}) => ({
    sessionId: `local_${local}`,
    cliSessionId: cli,
    title: `Title ${local}`,
    titleSource: 'auto',
    isArchived: false,
    createdAt: Date.UTC(2030, 0, 1),
    cwd: '/w/repo',
    originCwd: '/w/repo',
    ...extra,
  });

  beforeEach(() => {
    app = join(dir, 'ClaudeApp');
    process.env.AGENTDESK_CLAUDE_APP_DIR = app;
  });
  afterEach(() => {
    delete process.env.AGENTDESK_CLAUDE_APP_DIR;
  });

  it('absent folder → no entries, nothing to watch', async () => {
    expect(claudeAppSessionDirs()).toEqual([]);
    const r = await readClaudeAppOverlays();
    expect(r.entries.size).toBe(0);
    expect(r.watchPaths).toEqual([]);
  });

  it('groups a chat where the app shows it: moved chats use the app folder, scratch folders are left alone', async () => {
    write('acct1', 'org1', 'local_m.json', rec('m', 'cli-moved', { cwd: '/w/project', originCwd: '/w/project' }));
    write('acct1', 'org1', 'local_s.json', rec('s', 'cli-scratch', { cwd: '/Users/a/Library/Application Support/Claude/scratch-workspaces/x/y', originCwd: '/Users/a/Library/Application Support/Claude/scratch-workspaces/x/y' }));
    const r = await readClaudeAppOverlays();
    expect(r.entries.get('cli-moved')!.projectPath).toBe('/w/project');
    expect(r.entries.get('cli-scratch')!.projectPath).toBeUndefined();
  });

  it('maps titles, parents (across accounts), kinds, archived and worktrees; skips malformed files', async () => {
    write('acct1', 'org1', 'local_p.json', rec('p', 'cli-parent'));
    write('acct2', 'org9', 'local_c.json', rec('c', 'cli-child', {
      spawnedFrom: { sessionId: 'local_p', sideSession: true, taskId: 't', name: 'n' },
      worktreePath: '/w/repo/.claude/worktrees/x', cwd: '/w/repo/.claude/worktrees/x', isArchived: true,
    }));
    write('acct2', 'org9', 'local_f.json', rec('f', 'cli-fork', {
      title: 'New session',
      spawnedFrom: { sessionId: 'local_p', sideSession: true, userFork: true, btw: true },
    }));
    write('acct2', 'org9', 'local_o.json', rec('o', 'cli-forkonly', { forkedFromSessionId: 'local_c' }));
    write('acct2', 'org9', 'local_u.json', rec('u', 'cli-unknownparent', { spawnedFrom: { sessionId: 'local_missing', sideSession: true } }));
    write('acct2', 'org9', 'local_bad.json', '{not json');
    write('acct2', 'org9', 'local_arr.json', '[1,2]');
    write('acct2', 'org9', 'local_noid.json', { title: 'x' });
    write('acct2', 'org9', 'scheduled-tasks.json', { scheduledTasks: [] });

    expect(claudeAppSessionDirs()).toEqual([join(app, 'claude-code-sessions')]);
    const r = await readClaudeAppOverlays();
    expect(r.watchPaths).toEqual([join(app, 'claude-code-sessions')]);
    expect([...r.entries.keys()].sort()).toEqual(['cli-child', 'cli-fork', 'cli-forkonly', 'cli-parent', 'cli-unknownparent']);
    expect(r.entries.get('cli-parent')).toEqual({ title: 'Title p', archived: false, createdAt: '2030-01-01T00:00:00.000Z', projectPath: '/w/repo' });
    expect(r.entries.get('cli-child')).toMatchObject({
      title: 'Title c', parentNativeId: 'cli-parent', spawnKind: 'spawned', archived: true, projectPath: '/w/repo',
    });
    const fork = r.entries.get('cli-fork')!;
    expect(fork.title).toBeUndefined(); // generic placeholder
    expect(fork).toMatchObject({ parentNativeId: 'cli-parent', spawnKind: 'side' });
    expect(r.entries.get('cli-forkonly')).toMatchObject({ parentNativeId: 'cli-child', spawnKind: 'side' });
    const u = r.entries.get('cli-unknownparent')!;
    expect(u.parentNativeId).toBeUndefined();
    expect(u.spawnKind).toBeUndefined();
  });

  it('sideSession alone does not make a side chat (the app sets it on every spawned session)', async () => {
    write('a', 'o', 'local_p.json', rec('p', 'P'));
    write('a', 'o', 'local_s.json', rec('s', 'S', { spawnedFrom: { sessionId: 'local_p', sideSession: true } }));
    write('a', 'o', 'local_t.json', rec('t', 'T', { spawnedFrom: { sessionId: 'local_p', sideSession: false } }));
    const r = await readClaudeAppOverlays();
    expect(r.entries.get('S')!.spawnKind).toBe('spawned');
    expect(r.entries.get('T')!.spawnKind).toBe('spawned');
  });

  it('end to end with the Claude Code adapter (no app folder → plain listing)', async () => {
    const claudeRoot = join(dir, 'claude');
    const proj = join(claudeRoot, '-w-repo');
    mkdirSync(proj, { recursive: true });
    const cc = (uuid: string, cwd: string, ts: string) =>
      L({ type: 'user', uuid, parentUuid: null, sessionId: 'x', cwd, timestamp: ts, message: { role: 'user', content: 'hi' } }) + '\n';
    const A = 'aaaaaaaa-0000-4000-8000-000000000001';
    const B = 'bbbbbbbb-0000-4000-8000-000000000002';
    writeFileSync(join(proj, `${A}.jsonl`), cc('u-1', '/w/repo', '2030-01-01T10:00:00Z'));
    const wtProj = join(claudeRoot, '-w-repo--claude-worktrees-x');
    mkdirSync(wtProj, { recursive: true });
    writeFileSync(join(wtProj, `${B}.jsonl`), cc('u-2', '/w/repo/.claude/worktrees/x', '2030-01-01T11:00:00Z'));
    const index = () => indexAll(db, [claudeCodeAdapter], { 'claude-code': [claudeRoot] });

    await index();
    // no app folder: B is grouped under the repo by its worktree path alone, as a root
    expect(store.listProjects({}).map((p) => [p.key, p.sessionCount])).toEqual([[pathKey('/w/repo'), 2]]);
    expect(tree().items.map((n) => n.nativeId)).toEqual([B, A]);

    write('acct', 'org', 'local_a.json', rec('a', A, { title: 'Main task' }));
    write('acct', 'org', 'local_b.json', rec('b', B, { title: 'Worker', spawnedFrom: { sessionId: 'local_a', sideSession: true } }));
    const r = await index();
    expect(r.overlays?.watchPaths.get('claude-code')).toEqual([join(app, 'claude-code-sessions')]);
    const items = tree().items;
    expect(items.map((n) => n.title)).toEqual(['Main task']);
    expect(items[0]!.children.map((n) => [n.title, n.spawnedFromSessionId, n.spawnKind])).toEqual([
      ['Worker', `claude-code:${A}`, 'spawned'],
    ]);
  });

  it('the worker re-reads overlays when the app folder changes (chat files untouched)', async () => {
    const claudeRoot = join(dir, 'claude');
    const A = 'aaaaaaaa-0000-4000-8000-000000000009';
    mkdirSync(join(claudeRoot, '-w-repo'), { recursive: true });
    writeFileSync(
      join(claudeRoot, '-w-repo', `${A}.jsonl`),
      L({ type: 'user', uuid: 'u-9', parentUuid: null, cwd: '/w/repo', timestamp: '2030-01-01T10:00:00Z', message: { role: 'user', content: 'hi' } }) + '\n',
    );
    write('acct', 'org', 'local_a.json', rec('a', A, { title: 'Before' }));
    const ix = await startIndexer({
      dbPath: join(dir, 'w.db'),
      adapters: [claudeCodeAdapter],
      roots: new Map([['claude-code', [claudeRoot]]]),
      adaptersModule: resolve('src/adapters/index.ts'),
      watch: true,
    });
    try {
      await ix.whenIdle();
      expect(ix.store.getSession(`claude-code:${A}`)?.title).toBe('Before');
      const updates: string[] = [];
      ix.store.onChange((e) => {
        if (e.type === 'session-updated') updates.push(e.sessionId);
      });
      // let the watchers settle: on Windows, reading the chat files during the first scan can itself
      // raise (access-time) events, and the chat watcher fires a no-op pass after its 500ms debounce
      await new Promise((r) => setTimeout(r, 1500));
      const passes: unknown[] = [];
      ix.store.onChange((e) => {
        if (e.type === 'progress') passes.push(e.status);
      });
      write('acct', 'org', 'local_a.json', rec('a', A, { title: 'After', isArchived: true }));
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline && !updates.length) await new Promise((r) => setTimeout(r, 50));
      expect(updates).toEqual([`claude-code:${A}`]);
      const s = ix.store.getSession(`claude-code:${A}`)!;
      expect(s.title).toBe('After');
      expect(s.archived).toBe(true);
      expect(passes).toEqual([]); // no chat indexing pass was triggered by the app-folder change
    } finally {
      await ix.stop();
    }
  }, 20000);
});
