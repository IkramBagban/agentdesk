/**
 * Forked Claude Code sessions: the file starts with records copied from the
 * parent (carrying the parent's sessionId). SessionMeta.forkedAtSeq marks
 * where the session's own events begin. Synthetic data only.
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeCodeAdapter } from '../../src/adapters/claude-code/index.ts';
import type { DiscoveredFile } from '../../src/core/adapter.ts';
import type { ChatEvent, RawLine } from '../../src/core/types.ts';
import { indexAll } from '../../src/index/indexer.ts';
import { openDb } from '../../src/index/schema.ts';
import { SqliteIndexStore } from '../../src/index/sqlite-store.ts';

const PARENT = 'aaaaaaaa-0000-4000-8000-000000000001';
const FORK = 'bbbbbbbb-0000-4000-8000-000000000002';
const PROJECT = '-Users-alice-code-fork-demo';

const L = (o: object) => JSON.stringify(o);
let n = 0;
const ts = () => `2030-01-01T10:00:${String(n).padStart(2, '0')}.000Z`;
function user(sessionId: string, text: string, parentUuid: string | null = null) {
  const uuid = `u-${++n}`;
  return { uuid, line: L({ type: 'user', uuid, parentUuid, sessionId, timestamp: ts(), message: { role: 'user', content: text } }) };
}
function assistant(sessionId: string, text: string, parentUuid: string) {
  const uuid = `a-${++n}`;
  return {
    uuid,
    line: L({
      type: 'assistant',
      uuid,
      parentUuid,
      sessionId,
      timestamp: ts(),
      message: { role: 'assistant', model: 'claude-test', content: [{ type: 'text', text }] },
    }),
  };
}
/** a parent-session exchange: user prompt + assistant reply */
function inheritedPrefix(): string[] {
  const u1 = user(PARENT, 'parent question one');
  const a1 = assistant(PARENT, 'parent answer one', u1.uuid);
  const u2 = user(PARENT, 'parent question two', a1.uuid);
  const a2 = assistant(PARENT, 'parent answer two', u2.uuid);
  return [
    L({ type: 'queue-operation', operation: 'enqueue', sessionId: PARENT }),
    u1.line,
    L({ type: 'file-history-snapshot', messageId: u1.uuid, snapshot: {} }), // no sessionId: neutral
    a1.line,
    u2.line,
    a2.line,
    L({ type: 'custom-title', customTitle: 'Parent title', sessionId: PARENT }),
    L({ type: 'custom-title', customTitle: 'Fork title', sessionId: FORK }), // own, but no event
  ];
}
function ownTurn(): string[] {
  const u = user(FORK, 'fork question');
  const a = assistant(FORK, 'fork answer', u.uuid);
  return [u.line, L({ type: 'file-history-snapshot', messageId: u.uuid, snapshot: {} }), a.line];
}

let dir: string;
let root: string;
let db: DatabaseSync;
let store: SqliteIndexStore;

const pathOf = (id: string) => join(root, PROJECT, `${id}.jsonl`);
const write = (id: string, lines: string[]) => writeFileSync(pathOf(id), lines.map((l) => `${l}\n`).join(''));
const append = (id: string, lines: string[]) => appendFileSync(pathOf(id), lines.map((l) => `${l}\n`).join(''));
const run = () => indexAll(db, [claudeCodeAdapter], { 'claude-code': [root] });
const session = (id: string) => store.getSession(`claude-code:${id}`)!;

beforeEach(() => {
  n = 0;
  dir = mkdtempSync(join(tmpdir(), 'ah-fork-'));
  process.env.AGENTDESK_CLAUDE_APP_DIR = join(dir, 'no-claude-app');
  root = join(dir, 'projects');
  mkdirSync(join(root, PROJECT), { recursive: true });
  db = openDb(join(dir, 'x.db'));
  store = new SqliteIndexStore(db);
});
afterEach(() => {
  delete process.env.AGENTDESK_CLAUDE_APP_DIR;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('claude-code inherited events', () => {
  const file: DiscoveredFile = { path: '/x', nativeId: FORK, projectKey: 'k' };
  const lines = [...inheritedPrefix(), ...ownTurn()];

  it('marks records with another sessionId, and parseLine agrees with the parser', () => {
    const p = claudeCodeAdapter.createParser(file);
    const all: ChatEvent[] = [];
    let offset = 0;
    lines.forEach((text, i) => {
      const raw: RawLine = { line: i, offset, length: Buffer.byteLength(text), text };
      offset += raw.length + 1;
      const first = (p.snapshot() as { seq: number }).seq;
      const evs = p.push(raw);
      expect(claudeCodeAdapter.parseLine(raw, first, file)).toEqual(evs);
      all.push(...evs);
    });
    expect(all.map((e) => [e.role, !!e.inherited])).toEqual([
      ['user', true],
      ['assistant', true],
      ['user', true],
      ['assistant', true],
      ['user', false],
      ['assistant', false],
    ]);
    expect(all.every((e) => e.inherited === true || !('inherited' in e))).toBe(true);
  });

  it('sub-agent records carry the parent session id and are not inherited', () => {
    const sub: DiscoveredFile = { path: '/y', nativeId: `${PARENT}/agent-x`, projectKey: 'k', parentNativeId: PARENT };
    const u = user(PARENT, 'sub-agent task');
    const evs = claudeCodeAdapter.parseLine({ line: 0, offset: 0, length: u.line.length, text: u.line }, 0, sub);
    expect(evs[0]?.inherited).toBeUndefined();
  });
});

describe('forkedAtSeq', () => {
  it('is set on a forked file and unset on a normal one', async () => {
    const u = user(PARENT, 'parent question');
    write(PARENT, [u.line, assistant(PARENT, 'parent answer', u.uuid).line]);
    write(FORK, [...inheritedPrefix(), ...ownTurn()]);
    await run();
    expect(session(FORK).forkedAtSeq).toBe(4);
    expect(session(PARENT).forkedAtSeq).toBeUndefined();
    // listings carry it too
    const listed = store.listSessions({ limit: 50 }).items.find((s) => s.nativeId === FORK);
    expect(listed?.forkedAtSeq).toBe(4);
  });

  it('is not set for sub-agent files (they carry the parent session id)', async () => {
    const u = user(PARENT, 'parent question');
    write(PARENT, [u.line, assistant(PARENT, 'parent answer', u.uuid).line]);
    const subDir = join(root, PROJECT, PARENT, 'subagents');
    mkdirSync(subDir, { recursive: true });
    const su = user(PARENT, 'sub task');
    writeFileSync(join(subDir, 'agent-s1.jsonl'), `${su.line}\n${assistant(PARENT, 'sub done', su.uuid).line}\n`);
    await run();
    const sub = store.getSession(`claude-code:${PARENT}/agent-s1`)!;
    expect(sub.parentSessionId).toBe(`claude-code:${PARENT}`);
    expect(sub.forkedAtSeq).toBeUndefined();
  });

  it('stays unset while only inherited events exist, and is set once own events are appended (resume)', async () => {
    write(FORK, inheritedPrefix());
    const r1 = await run();
    expect(r1.indexed).toBe(1);
    expect(session(FORK).eventCount).toBe(4);
    expect(session(FORK).forkedAtSeq).toBeUndefined();

    append(FORK, ownTurn());
    const r2 = await run();
    expect(r2.resumed).toBe(1);
    expect(session(FORK).forkedAtSeq).toBe(4);

    // later appends keep it
    const u = user(FORK, 'another fork question');
    append(FORK, [u.line]);
    const r3 = await run();
    expect(r3.resumed).toBe(1);
    expect(session(FORK).forkedAtSeq).toBe(4);
  });
});
