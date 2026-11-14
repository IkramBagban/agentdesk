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
import type { IndexStatus, IndexStore } from './store.ts';
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

const MAX_RESTARTS = 3;
const RESTART_DELAY_MS = 1000;

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
  let idleWaiters: (() => void)[] = [];
  let stopping = false;
  let exited = false;
  let alive = false;
  let crashes = 0;
  const flushIdle = () => {
    const w = idleWaiters;
    idleWaiters = [];
    for (const f of w) f();
  };
  const reportError = (message: string) =>
    store.publish({
      type: 'progress',
      status: { state: 'idle', filesDone: 0, filesTotal: 0, sessionCount: 0, lastError: message },
    });

  let worker: Worker;
  /**
   * The worker is restarted if it dies unexpectedly (uncaught error, OOM on a
   * pathological file...): the index on disk is transactional per file, so a
   * new worker resumes where the old one stopped. Bounded so a deterministic
   * crash does not spin forever; a clean full pass resets the budget.
   */
  const spawn = () => {
    worker = new Worker(workerUrl(), { workerData });
    alive = true;
    worker.on('message', (m: { type: string; status?: IndexStatus; sessionId?: string; message?: string }) => {
      if (m.type === 'progress' && m.status) {
        store.publish({ type: 'progress', status: m.status });
        if (m.status.state === 'idle') {
          if (!m.status.lastError) crashes = 0;
          flushIdle();
        }
      } else if (m.type === 'session-updated' && m.sessionId) {
        store.publish({ type: 'session-updated', sessionId: m.sessionId });
      } else if (m.type === 'error') {
        reportError(m.message ?? 'indexer error');
      }
    });
    worker.on('error', (err: Error) => reportError(err.message));
    worker.on('exit', (code) => {
      alive = false;
      if (!stopping && code !== 0 && ++crashes <= MAX_RESTARTS) {
        setTimeout(() => {
          if (!stopping) spawn();
        }, RESTART_DELAY_MS * crashes).unref();
        return;
      }
      exited = true;
      flushIdle();
    });
  };
  spawn();

  return {
    store,
    rescan: () => worker.postMessage({ type: 'rescan' }),
    whenIdle: () => (exited ? Promise.resolve() : new Promise<void>((r) => idleWaiters.push(r))),
    async stop() {
      stopping = true;
      if (alive) {
        const done = new Promise<void>((r) => worker.once('exit', () => r()));
        worker.postMessage({ type: 'stop' });
        const t = setTimeout(() => void worker.terminate(), 3000);
        await done;
        clearTimeout(t);
      }
      exited = true;
      flushIdle();
      reader.close();
    },
  };
}
