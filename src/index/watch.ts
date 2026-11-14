import { watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';

/**
 * Recursive fs.watch over `roots`; batches changed absolute paths and calls
 * `onPaths` after `debounceMs` of quiet. Missing roots are ignored.
 * Returns a stop function.
 */
export function watchRoots(roots: readonly string[], onPaths: (paths: string[]) => void, debounceMs = 500): () => void {
  const watchers: FSWatcher[] = [];
  const pending = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  const flush = () => {
    timer = undefined;
    const paths = [...pending];
    pending.clear();
    if (paths.length) onPaths(paths);
  };
  for (const root of roots) {
    try {
      const w = watch(root, { recursive: true }, (_ev, filename) => {
        if (!filename) return;
        const p = join(root, filename.toString());
        pending.add(p);
        // sidecar (e.g. agent-x.meta.json) changed → also re-check the session file next to it
        if (p.endsWith('.meta.json')) pending.add(p.replace(/\.meta\.json$/, '.jsonl'));
        if (timer) clearTimeout(timer);
        timer = setTimeout(flush, debounceMs);
      });
      w.on('error', () => {});
      watchers.push(w);
    } catch {
      /* root missing or unwatchable */
    }
  }
  return () => {
    if (timer) clearTimeout(timer);
    for (const w of watchers) w.close();
  };
}
