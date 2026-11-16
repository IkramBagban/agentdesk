/**
 * The "who started whom" graph over top-level sessions, built from the
 * sessions table plus the app overlays (session_overlays). Pure: the store
 * loads the rows and caches the result until the database changes.
 */
import { projectKeyFor } from './project.ts';

export interface GraphSessionRow {
  id: string;
  sourceId: string;
  nativeId: string;
  projectKey: string;
  projectPath?: string;
  updatedAt: string;
}

export interface GraphOverlayRow {
  sourceId: string;
  nativeId: string;
  title?: string;
  parentNativeId?: string;
  spawnKind?: 'spawned' | 'side';
  archived?: boolean;
  projectPath?: string;
}

export interface GraphNode {
  id: string;
  sourceId: string;
  updatedAt: string;
  /** stored project path (the chat's own working directory) */
  ownPath?: string;
  /** this session's own grouping key (after overlay / worktree remapping) */
  ownKey: string;
  /** effective project key: the ROOT starter's ownKey */
  key: string;
  /** effective project folder (for display), when known */
  path?: string;
  title?: string;
  archived: boolean;
  /** indexed session that started this one (acyclic) */
  parentId?: string;
  spawnKind?: 'spawned' | 'side';
  rootId: string;
}

export interface SessionGraph {
  nodes: Map<string, GraphNode>;
}

/** `<repo>/.claude/worktrees/<name>[/…]` → `<repo>` */
const WORKTREE_RE = /^(.+?)[\\/]\.claude[\\/]worktrees[\\/][^\\/]+(?:[\\/].*)?$/;

export function worktreeRepo(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const m = WORKTREE_RE.exec(path);
  return m ? m[1] : undefined;
}

const pathOfKey = (key: string): string | undefined => (key.startsWith('path:') ? key.slice(5) : undefined);

export function buildGraph(rows: readonly GraphSessionRow[], overlays: readonly GraphOverlayRow[]): SessionGraph {
  const byNative = new Map<string, string>();
  for (const r of rows) {
    const k = `${r.sourceId}\0${r.nativeId}`;
    // prefer the canonical id over a `~hash` duplicate
    if (!byNative.has(k) || r.id === `${r.sourceId}:${r.nativeId}`) byNative.set(k, r.id);
  }
  const ovByNative = new Map<string, GraphOverlayRow>();
  for (const o of overlays) ovByNative.set(`${o.sourceId}\0${o.nativeId}`, o);

  const nodes = new Map<string, GraphNode>();
  for (const r of rows) {
    const o = ovByNative.get(`${r.sourceId}\0${r.nativeId}`);
    let ownKey = r.projectKey;
    let path = r.projectPath;
    const groupPath = o?.projectPath ?? worktreeRepo(r.projectPath);
    if (groupPath) {
      ownKey = projectKeyFor(groupPath, r.projectKey);
      path = groupPath;
    }
    const n: GraphNode = { id: r.id, sourceId: r.sourceId, updatedAt: r.updatedAt, ownKey, key: ownKey, archived: o?.archived === true, rootId: r.id };
    if (r.projectPath) n.ownPath = r.projectPath;
    if (path) n.path = path;
    if (o?.title) n.title = o.title;
    if (o?.parentNativeId) {
      const pid = byNative.get(`${r.sourceId}\0${o.parentNativeId}`);
      if (pid && pid !== r.id) {
        n.parentId = pid;
        if (o.spawnKind) n.spawnKind = o.spawnKind;
      }
    }
    nodes.set(r.id, n);
  }

  // Break cycles deterministically: in each cycle, the member with the smallest id becomes a root.
  const state = new Map<string, 1 | 2>(); // 1 = on the current walk, 2 = done
  for (const id of [...nodes.keys()].sort()) {
    const walk: string[] = [];
    let cur: string | undefined = id;
    while (cur && !state.has(cur)) {
      state.set(cur, 1);
      walk.push(cur);
      cur = nodes.get(cur)?.parentId;
    }
    if (cur && state.get(cur) === 1) {
      const cycle = walk.slice(walk.indexOf(cur));
      const cut = nodes.get(cycle.reduce((a, b) => (b < a ? b : a)))!;
      delete cut.parentId;
      delete cut.spawnKind;
    }
    for (const w of walk) state.set(w, 2);
  }

  // roots (memoized walk; the graph is acyclic now) and effective project: children follow their root
  const resolved = new Map<string, string>();
  for (const id of nodes.keys()) {
    const chain: string[] = [];
    let cur = id;
    let root: string;
    for (;;) {
      const r = resolved.get(cur);
      if (r) {
        root = r;
        break;
      }
      chain.push(cur);
      const parent = nodes.get(cur)?.parentId;
      if (!parent || !nodes.has(parent)) {
        root = cur;
        break;
      }
      cur = parent;
    }
    for (const c of chain) resolved.set(c, root);
  }
  for (const n of nodes.values()) n.rootId = resolved.get(n.id) ?? n.id;
  for (const n of nodes.values()) {
    const root = nodes.get(n.rootId) ?? n;
    n.key = root.ownKey;
    const p = pathOfKey(n.key) ?? root.path;
    if (p) n.path = p;
    else delete n.path;
  }
  return { nodes };
}
