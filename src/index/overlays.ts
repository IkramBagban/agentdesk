import type { DatabaseSync } from 'node:sqlite';
import type { SessionOverlay, SourceAdapter } from '../core/adapter.ts';

type Row = Record<string, unknown>;

export interface OverlayRefresh {
  /** files/folders to watch for overlay changes, per adapter id */
  watchPaths: Map<string, string[]>;
  /** session ids (`<source>:<native>`) whose overlay row was added, changed or removed */
  changed: string[];
}

const COLS = ['title', 'parent_native_id', 'spawn_kind', 'archived', 'project_path', 'created_at'] as const;

function toRow(o: SessionOverlay): Record<(typeof COLS)[number], string | number | null> {
  const s = (v: unknown, max = 2000) => (typeof v === 'string' && v ? v.slice(0, max) : null);
  return {
    title: s(o.title, 500),
    parent_native_id: s(o.parentNativeId),
    spawn_kind: o.spawnKind === 'side' || o.spawnKind === 'spawned' ? o.spawnKind : null,
    archived: typeof o.archived === 'boolean' ? (o.archived ? 1 : 0) : null,
    project_path: s(o.projectPath, 4096),
    created_at: s(o.createdAt, 64),
  };
}

/**
 * Re-read every adapter's app overlays and replace the `session_overlays` rows
 * of that adapter. Never touches chat files or session/event rows. An adapter
 * whose overlays() throws keeps its previous rows.
 */
export async function refreshOverlays(db: DatabaseSync, adapters: readonly SourceAdapter[]): Promise<OverlayRefresh> {
  const out: OverlayRefresh = { watchPaths: new Map(), changed: [] };
  for (const adapter of adapters) {
    if (typeof adapter.overlays !== 'function') continue;
    let res;
    try {
      res = await adapter.overlays();
    } catch {
      continue;
    }
    if (!res || !(res.entries instanceof Map)) continue;
    out.watchPaths.set(adapter.id, Array.isArray(res.watchPaths) ? res.watchPaths.filter((p) => typeof p === 'string') : []);

    const old = new Map<string, string>();
    for (const r of db.prepare(`SELECT session_id, ${COLS.join(', ')} FROM session_overlays WHERE source_id = ?`).all(adapter.id) as Row[]) {
      old.set(String(r.session_id), JSON.stringify(COLS.map((c) => r[c] ?? null)));
    }
    const fresh = new Map<string, { nativeId: string; row: ReturnType<typeof toRow> }>();
    for (const [nativeId, o] of res.entries) {
      if (typeof nativeId !== 'string' || !nativeId || !o || typeof o !== 'object') continue;
      fresh.set(`${adapter.id}:${nativeId}`, { nativeId, row: toRow(o) });
    }
    const changed: string[] = [];
    for (const [id, f] of fresh) if (old.get(id) !== JSON.stringify(COLS.map((c) => f.row[c]))) changed.push(id);
    for (const id of old.keys()) if (!fresh.has(id)) changed.push(id);
    if (!changed.length) continue;

    const del = db.prepare('DELETE FROM session_overlays WHERE session_id = ?');
    const ins = db.prepare(
      `INSERT OR REPLACE INTO session_overlays(session_id, source_id, native_id, ${COLS.join(', ')})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    db.exec('BEGIN');
    try {
      for (const id of changed) {
        const f = fresh.get(id);
        if (!f) del.run(id);
        else ins.run(id, adapter.id, f.nativeId, ...COLS.map((c) => f.row[c]));
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    out.changed.push(...changed);
  }
  return out;
}
