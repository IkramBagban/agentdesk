import { useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Bot, ChevronDown, Images, Search, X } from 'lucide-react';
import { api, type SessionMeta, type Status } from '../api.ts';
import { navigate, useRoute } from '../router.ts';
import { projectName, relDate, sourceLabel, usd } from '../format.ts';

export function Sidebar({ status }: { status?: Status }) {
  const route = useRoute();
  const [text, setText] = useState(route.q ?? '');
  const inputRef = useRef<HTMLInputElement>(null);

  // Debounced search into the URL.
  useEffect(() => {
    const t = setTimeout(() => {
      if ((route.q ?? '') !== text.trim()) navigate({ q: text.trim() || undefined }, { replace: true });
    }, 250);
    return () => clearTimeout(t);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const sources = status?.sources.filter((s) => s.sessionCount > 0) ?? [];

  return (
    <aside className="flex h-full min-h-0 flex-col border-r border-rule bg-surface">
      <div className="space-y-2 border-b border-rule p-3">
        <label className="flex items-center gap-2 rounded-md border border-rule bg-paper px-2.5 py-1.5 focus-within:border-prompt">
          <Search size={15} className="text-faint" />
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Search all chats"
            aria-label="Search all chats"
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-faint"
            onKeyDown={(e) => e.key === 'Escape' && (setText(''), e.currentTarget.blur())}
          />
          {text && (
            <button type="button" aria-label="Clear search" onClick={() => setText('')} className="text-faint hover:text-ink">
              <X size={14} />
            </button>
          )}
        </label>
        <div className="flex gap-2">
          {sources.length > 1 && (
            <select
              aria-label="Agent"
              value={route.source ?? ''}
              onChange={(e) => navigate({ source: e.target.value || undefined, project: undefined }, { replace: true })}
              className="rounded-md border border-rule bg-paper px-2 py-1 text-[13px]"
            >
              <option value="">All agents</option>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.displayName}
                </option>
              ))}
            </select>
          )}
          <ProjectPicker />
        </div>
      </div>
      {route.q ? <SearchResults q={route.q} /> : <SessionList />}
      <IndexFooter status={status} />
    </aside>
  );
}

function ProjectPicker() {
  const route = useRoute();
  const q = useQuery({ queryKey: ['projects', route.source], queryFn: () => api.projects(route.source) });
  return (
    <div className="relative min-w-0 flex-1">
      <select
        aria-label="Project"
        value={route.project ?? ''}
        onChange={(e) => navigate({ project: e.target.value || undefined }, { replace: true })}
        className="w-full appearance-none truncate rounded-md border border-rule bg-paper py-1 pr-6 pl-2 text-[13px]"
      >
        <option value="">All projects</option>
        {q.data?.map((p) => (
          <option key={p.key} value={p.key}>
            {p.displayName || projectName(p.path, p.key)} ({p.sessionCount})
          </option>
        ))}
      </select>
      <ChevronDown size={14} className="pointer-events-none absolute top-1/2 right-1.5 -translate-y-1/2 text-faint" />
    </div>
  );
}

function useInfiniteList<T>(key: unknown[], fetchPage: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string }>) {
  return useInfiniteQuery({
    queryKey: key,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => fetchPage(pageParam),
    getNextPageParam: (last) => last.nextCursor,
  });
}

function VirtualList<T>({ items, render, onEnd, estimate, getKey }: { items: T[]; render: (item: T) => React.ReactNode; onEnd: () => void; estimate: number; getKey: (item: T) => string }) {
  const ref = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({ count: items.length, getScrollElement: () => ref.current, estimateSize: () => estimate, overscan: 8, getItemKey: (i) => getKey(items[i]!) });
  const vis = v.getVirtualItems();
  useEffect(() => {
    if ((vis.at(-1)?.index ?? 0) >= items.length - 5) onEnd();
  }, [vis, items.length, onEnd]);
  return (
    <div ref={ref} className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
      <div style={{ height: v.getTotalSize(), position: 'relative' }}>
        {vis.map((it) => (
          <div key={it.key} data-index={it.index} ref={v.measureElement} className="absolute top-0 left-0 w-full" style={{ transform: `translateY(${it.start}px)` }}>
            {render(items[it.index]!)}
          </div>
        ))}
      </div>
    </div>
  );
}

function SessionList() {
  const route = useRoute();
  const q = useInfiniteList(['sessions', route.source, route.project], (cursor) => api.sessions({ source: route.source, project: route.project, cursor }));
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  if (q.isLoading) return <p className="p-4 text-muted">Loading chats…</p>;
  if (q.isError) return <p className="p-4 text-error">{(q.error as Error).message}</p>;
  if (!items.length) return <p className="p-4 text-muted">No chats found yet. They appear here as indexing finishes.</p>;
  return (
    <VirtualList
      items={items}
      estimate={72}
      getKey={(s) => s.id}
      onEnd={() => q.hasNextPage && !q.isFetchingNextPage && void q.fetchNextPage()}
      render={(s) => <SessionItem s={s} active={s.id === route.sessionId} showProject={!route.project} />}
    />
  );
}

function SessionItem({ s, active, showProject }: { s: SessionMeta; active: boolean; showProject: boolean }) {
  return (
    <button
      type="button"
      onClick={() => navigate({ sessionId: s.id, seq: undefined })}
      aria-current={active ? 'page' : undefined}
      className={`block w-full border-b border-rule/60 px-3 py-2.5 text-left hover:bg-sunken ${active ? 'bg-mark-soft shadow-[inset_3px_0_0_var(--mark)]' : ''}`}
    >
      <div className="flex items-baseline gap-2">
        <span className="line-clamp-2 min-w-0 flex-1 font-medium">{s.title || s.firstPrompt || 'Untitled chat'}</span>
        <span className="shrink-0 text-[12px] text-faint">{relDate(s.updatedAt)}</span>
      </div>
      <div className="mt-0.5 flex items-center gap-2 text-[12px] text-faint">
        {showProject && <span className="truncate">{projectName(s.projectPath, s.projectKey)}</span>}
        <span className="shrink-0">{s.messageCount} msgs</span>
        {s.imageCount > 0 && (
          <span className="inline-flex shrink-0 items-center gap-0.5">
            <Images size={11} /> {s.imageCount}
          </span>
        )}
        {s.costUSD != null && s.costUSD > 0 && <span className="shrink-0">{usd(s.costUSD)}</span>}
        {s.sourceId !== 'claude-code' && <span className="shrink-0 rounded bg-sunken px-1">{sourceLabel(s.sourceId)}</span>}
      </div>
    </button>
  );
}

function SearchResults({ q: text }: { q: string }) {
  const route = useRoute();
  const q = useInfiniteList(['search', text, route.source, route.project], (cursor) => api.search({ q: text, source: route.source, project: route.project, cursor }));
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  if (q.isLoading) return <p className="p-4 text-muted">Searching…</p>;
  if (q.isError) return <p className="p-4 text-error">{(q.error as Error).message}</p>;
  if (!items.length) return <p className="p-4 text-muted">No matches for “{text}”. Try fewer or different words.</p>;
  return (
    <VirtualList
      items={items}
      estimate={96}
      getKey={(h) => `${h.sessionId}:${h.seq}`}
      onEnd={() => q.hasNextPage && !q.isFetchingNextPage && void q.fetchNextPage()}
      render={(h) => (
        <button
          type="button"
          onClick={() => navigate({ sessionId: h.sessionId, seq: h.seq })}
          className={`block w-full border-b border-rule/60 px-3 py-2.5 text-left hover:bg-sunken ${route.sessionId === h.sessionId && route.seq === h.seq ? 'bg-mark-soft' : ''}`}
        >
          <div className="flex items-baseline gap-2 text-[12px] text-faint">
            <span className="min-w-0 flex-1 truncate font-medium text-muted">{h.sessionTitle || 'Untitled chat'}</span>
            <span className="shrink-0">{relDate(h.timestamp)}</span>
          </div>
          {/* Server escapes everything except <mark>. */}
          <p className="mt-1 line-clamp-3 font-serif text-[13.5px] leading-snug" dangerouslySetInnerHTML={{ __html: h.snippet }} />
          <div className="mt-1 flex items-center gap-1 text-[11.5px] text-faint">
            {h.role === 'user' ? 'You' : h.role === 'assistant' ? <><Bot size={11} /> Assistant</> : h.role}
            <span>· {projectName(undefined, h.projectKey)}</span>
          </div>
        </button>
      )}
    />
  );
}

function IndexFooter({ status }: { status?: Status }) {
  if (!status) return null;
  const { index } = status;
  const indexing = index.state === 'indexing' && index.filesTotal > 0;
  return (
    <div className="border-t border-rule px-3 py-2 text-[12px] text-faint" aria-live="polite">
      {indexing ? (
        <div>
          <div className="mb-1">
            Indexing {index.filesDone} of {index.filesTotal} files
          </div>
          <div className="h-1 overflow-hidden rounded bg-sunken">
            <div className="h-full bg-mark transition-[width]" style={{ width: `${(100 * index.filesDone) / Math.max(1, index.filesTotal)}%` }} />
          </div>
        </div>
      ) : (
        <span>
          {index.sessionCount.toLocaleString()} chats · stored only on this computer
        </span>
      )}
      {index.lastError && <div className="mt-1 truncate text-error" title={index.lastError}>{index.lastError}</div>}
    </div>
  );
}
