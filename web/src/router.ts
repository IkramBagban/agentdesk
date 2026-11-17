import { useSyncExternalStore } from 'react';

/**
 * Tiny URL-state router. All app navigation state lives in the URL so
 * back/forward and reload work:
 *   /                       → no session open
 *   /s/<encoded session id> → session open
 *   ?project=…&source=…&q=… → sidebar filters / search
 *   &seq=N                  → jump to an event
 *   &view=all               → show everything
 *   &side=<session id>      → side chat open in the right panel
 */
export interface Route {
  sessionId?: string;
  project?: string;
  source?: string;
  q?: string;
  seq?: number;
  view: 'conversation' | 'all';
  /** side chat shown in the right panel */
  side?: string;
}

function parse(): Route {
  const url = new URL(window.location.href);
  const m = url.pathname.match(/^\/s\/(.+)$/);
  const seq = url.searchParams.get('seq');
  return {
    sessionId: m?.[1] ? decodeURIComponent(m[1]) : undefined,
    project: url.searchParams.get('project') ?? undefined,
    source: url.searchParams.get('source') ?? undefined,
    q: url.searchParams.get('q') ?? undefined,
    seq: seq != null && /^\d+$/.test(seq) ? Number(seq) : undefined,
    view: url.searchParams.get('view') === 'all' ? 'all' : 'conversation',
    side: url.searchParams.get('side') ?? undefined,
  };
}

function build(r: Route): string {
  const path = r.sessionId ? `/s/${encodeURIComponent(r.sessionId)}` : '/';
  const qs = new URLSearchParams();
  if (r.project) qs.set('project', r.project);
  if (r.source) qs.set('source', r.source);
  if (r.q) qs.set('q', r.q);
  if (r.seq != null) qs.set('seq', String(r.seq));
  if (r.view === 'all') qs.set('view', 'all');
  if (r.side) qs.set('side', r.side);
  return qs.size ? `${path}?${qs}` : path;
}

let current = parse();
let currentKey = window.location.pathname + window.location.search;
const listeners = new Set<() => void>();

function emit() {
  const key = window.location.pathname + window.location.search;
  if (key === currentKey) return;
  currentKey = key;
  current = parse();
  listeners.forEach((l) => l());
}

window.addEventListener('popstate', emit);

export function navigate(patch: Partial<Route>, opts: { replace?: boolean } = {}) {
  const next = { ...current, ...patch };
  // A side chat belongs to the chat it was opened from.
  if (patch.sessionId !== undefined && patch.sessionId !== current.sessionId && !('side' in patch)) next.side = undefined;
  const url = build(next);
  if (opts.replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
  emit();
}

export function useRoute(): Route {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}
