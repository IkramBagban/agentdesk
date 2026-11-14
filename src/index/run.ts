/**
 * Main-thread side of the indexer.
 *
 * Worker entry resolution (dev vs bundle): the worker file is resolved relative
 * to this module's URL.
 *  - esbuild bundle: this code lives in dist/cli.js, and `worker.js` is emitted
 *    next to it (build:server lists src/index/worker.ts as a second entry).
 *  - dev (tsx / vitest): this is src/index/run.ts, so `worker.ts` sits next to it.
 *    Node ≥ 22.18 strips types natively; with tsx the loader flags are inherited
 *    through process.execArgv.
 * `.js` is preferred when present, else `.ts`.
 */
import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import type { SourceAdapter } from '../core/adapter.ts';
import type { IndexChange, IndexStore } from './store.ts';
import type { SourceId } from '../core/types.ts';
import { openDb, prepareDb } from './schema.ts';
import { SqliteIndexStore } from './sqlite-store.ts';
import type { WorkerData } from './worker.ts';

export interface StartIndexerOptions {
  dbPath: string;
  /** Used for ids (worker filter) and default roots; the worker loads its own adapter instances. */
  adapters: SourceAdapter[];
  roots: Map<SourceId, string[]>;
  /** Override where the worker loads adapters from (tests). Default: the src/adapters/index.ts registry. */
  adaptersModule?: string;
  /** Watch roots for changes (default true). */
  watch?: boolean;
}

export interface RunningIndexer {
  store: IndexStore;
  /** ask the worker for a full incremental rescan */
  rescan(): void;
  /** resolves after the next time the worker reports idle (initial index done when first awaited) */
  whenIdle(): Promise<void>;
  stop(): Promise<void>;
}

function workerUrl(): URL {
  const js = new URL('./worker.js', import.meta.url);
  if (existsSync(js)) return js;
  return new URL('./worker.ts', import.meta.url);
}

export async function startIndexer(opts: StartIndexerOptions): Promise<RunningIndexer> {
  prepareDb(opts.dbPath); // create / rebuild before anyone else opens the file
  const reader = openDb(opts.dbPath, { reader: true });
  const store = new SqliteIndexStore(reader);

  const roots: Record<string, string[]> = {};
  for (const [id, r] of opts.roots) roots[id] = r;
  const workerData: WorkerData = {
    dbPath: opts.dbPath,
    roots,
    watch: opts.watch ?? true,
    ...(opts.adapters.length ? { adapterIds: opts.adapters.map((a) => a.id) } : {}),
    ...(opts.adaptersModule ? { adaptersModule: opts.adaptersModule } : {}),
  };
  const worker = new Worker(workerUrl(), { workerData });

  let idleWaiters: (() => void)[] = [];
  let exited = false;
  const flushIdle = () => {
    const w = idleWaiters;
    idleWaiters = [];
    for (const f of w) f();
  };
  worker.on('message', (m: { type: string; status?: IndexChange & object; sessionId?: string; message?: string }) => {
    if (m.type === 'progress' && m.status) {
      const status = m.status as unknown as import('./store.ts').IndexStatus;
      store.publish({ type: 'progress', status });
      if (status.state === 'idle') flushIdle();
    } else if (m.type === 'session-updated' && m.sessionId) {
      store.publish({ type: 'session-updated', sessionId: m.sessionId });
    } else if (m.type === 'error') {
      store.publish({
        type: 'progress',
        status: { state: 'idle', filesDone: 0, filesTotal: 0, sessionCount: 0, lastError: m.message ?? 'indexer error' },
      });
    }
  });
  worker.on('error', (err: Error) => {
    store.publish({
      type: 'progress',
      status: { state: 'idle', filesDone: 0, filesTotal: 0, sessionCount: 0, lastError: err.message },
    });
    flushIdle();
  });
  worker.on('exit', () => {
    exited = true;
    flushIdle();
  });

  return {
    store,
    rescan: () => worker.postMessage({ type: 'rescan' }),
    whenIdle: () => (exited ? Promise.resolve() : new Promise<void>((r) => idleWaiters.push(r))),
    async stop() {
      if (!exited) {
        const done = new Promise<void>((r) => worker.once('exit', () => r()));
        worker.postMessage({ type: 'stop' });
        const t = setTimeout(() => void worker.terminate(), 3000);
        await done;
        clearTimeout(t);
      }
      reader.close();
    },
  };
}
