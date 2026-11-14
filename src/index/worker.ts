/**
 * Indexer worker thread. Owns its own DB connection. Messages out:
 *   {type:'progress', status}  {type:'session-updated', sessionId}  {type:'error', message}
 * Messages in: {type:'rescan'} | {type:'stop'}.
 *
 * Adapters are loaded here (functions can't cross threads): from
 * workerData.adaptersModule if given (tests), otherwise the registry
 * `../adapters/index.ts` — a literal dynamic import so esbuild bundles it
 * into dist/worker.js.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import type { SourceAdapter } from '../core/adapter.ts';
import { indexAll, type RootsMap } from './indexer.ts';
import { openDb } from './schema.ts';
import { watchRoots } from './watch.ts';

export interface WorkerData {
  dbPath: string;
  /** absolute path of a module exporting `adapters` (Map or array); default: the built-in registry */
  adaptersModule?: string;
  /** only run these adapter ids (default all) */
  adapterIds?: string[];
  roots?: Record<string, string[]>;
  watch?: boolean;
}

function toArray(x: unknown): SourceAdapter[] {
  if (x instanceof Map) return [...x.values()] as SourceAdapter[];
  if (Array.isArray(x)) return x as SourceAdapter[];
  if (x && typeof x === 'object') return Object.values(x) as SourceAdapter[];
  return [];
}

async function loadAdapters(wd: WorkerData): Promise<SourceAdapter[]> {
  let mod: Record<string, unknown>;
  if (wd.adaptersModule) mod = (await import(pathToFileURL(wd.adaptersModule).href)) as Record<string, unknown>;
  else {
    // @ts-ignore registry is created by the orchestrator
    mod = (await import('../adapters/index.ts')) as Record<string, unknown>;
  }
  const all = toArray(mod.adapters ?? mod.default);
  return wd.adapterIds ? all.filter((a) => wd.adapterIds!.includes(a.id)) : all;
}

const wd = workerData as WorkerData;
const port = parentPort!;

async function main(): Promise<void> {
  const adapters = await loadAdapters(wd);
  const db = openDb(wd.dbPath);
  const roots: RootsMap = wd.roots ?? {};
  let stopped = false;
  let lastError: string | undefined;
  let running = false;
  let queued: { all: boolean; only: Set<string> } | undefined;
  const signal = { aborted: false };

  const sessionCount = () =>
    Number((db.prepare('SELECT count(*) AS n FROM sessions WHERE parent_session_id IS NULL').get() as { n: number }).n);
  const status = (state: 'idle' | 'indexing', filesDone: number, filesTotal: number) => ({
    state,
    filesDone,
    filesTotal,
    sessionCount: sessionCount(),
    ...(lastError ? { lastError } : {}),
  });

  async function run(only?: Set<string>): Promise<void> {
    if (running) {
      queued = { all: !only || !!queued?.all, only: new Set([...(queued?.only ?? []), ...(only ?? [])]) };
      return;
    }
    running = true;
    try {
      let lastPost = 0;
      const res = await indexAll(
        db,
        adapters,
        roots,
        (p) => {
          const now = Date.now();
          if (now - lastPost < 100 && p.filesDone < p.filesTotal) return;
          lastPost = now;
          port.postMessage({ type: 'progress', status: status('indexing', p.filesDone, p.filesTotal) });
        },
        {
          ...(only ? { only } : {}),
          signal,
          onSessionUpdated: (sessionId) => port.postMessage({ type: 'session-updated', sessionId }),
        },
      );
      lastError = res.errors.length ? `${res.errors.length} file(s) failed: ${res.errors[0]!.path}: ${res.errors[0]!.message}` : undefined;
      port.postMessage({ type: 'progress', status: status('idle', res.filesTotal, res.filesTotal) });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      port.postMessage({ type: 'error', message: lastError });
      port.postMessage({ type: 'progress', status: status('idle', 0, 0) });
    } finally {
      running = false;
      const q = queued;
      queued = undefined;
      if (q && !stopped) void run(q.all ? undefined : q.only);
    }
  }

  const stopWatch: (() => void)[] = [];
  if (wd.watch) {
    for (const a of adapters) {
      const r = roots[a.id] ?? a.defaultRoots();
      stopWatch.push(watchRoots(r, (paths) => void run(new Set(paths))));
    }
  }

  port.on('message', (m: { type: string }) => {
    if (m.type === 'rescan') void run();
    else if (m.type === 'stop') {
      stopped = true;
      signal.aborted = true;
      for (const s of stopWatch) s();
      const finish = () => {
        db.close();
        port.postMessage({ type: 'stopped' });
        process.exit(0);
      };
      const wait = setInterval(() => {
        if (!running) {
          clearInterval(wait);
          finish();
        }
      }, 20);
    }
  });

  await run();
}

main().catch((err) => {
  port.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
});
