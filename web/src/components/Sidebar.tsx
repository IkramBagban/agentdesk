import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useInfiniteQuery, useQueries, useQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronRight, Folder, FolderOpen, History, Monitor, Moon, PanelLeftClose, Search, Sun, X } from 'lucide-react';
import { api, type ProjectMeta, type SearchHit, type SessionMeta, type Status } from '../api.ts';
import { navigate, useRoute } from '../router.ts';
import { isScratch, projectName, relDate, sourceLabel } from '../format.ts';
import { IconButton, Segmented } from './ui.tsx';
import type { ThemePref } from '../App.tsx';

type Mode = 'projects' | 'recent';

function useMode(): [Mode, (m: Mode) => void] {
  const [mode, setMode] = useState<Mode>(() => {
    try {
      return localStorage.getItem('ah-sidebar-mode') === 'recent' ? 'recent' : 'projects';
    } catch {
      return 'projects';
    }
  });
  const set = useCallback((m: Mode) => {
    setMode(m);
    try {
      localStorage.setItem('ah-sidebar-mode', m);
    } catch {
      /* ignore */
    }
  }, []);
  return [mode, set];
}

export function Sidebar({ status, theme, onTheme, onClose }: { status?: Status; theme: ThemePref; onTheme: (t: ThemePref) => void; onClose: () => void }) {
  const route = useRoute();
  const [text, setText] = useState(route.q ?? '');
  const [mode, setMode] = useMode();
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep the box in sync when the URL changes (back/forward).
  useEffect(() => setText(route.q ?? ''), [route.q]);

  // Debounced search into the URL.
  useEffect(() => {
    const t = setTimeout(() => {
      if ((route.q ?? '') !== text.trim()) navigate({ q: text.trim() || undefined }, { replace: true });
    }, 250);
    return () => clearTimeout(t);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if ((e.key === '/' && !typing) || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k')) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const sources = status?.sources.filter((s) => s.sessionCount > 0) ?? [];
  const projects = useQuery({ queryKey: ['projects', route.source], queryFn: () => api.projects(route.source) });
  const projectMap = useMemo(() => new Map(projects.data?.map((p) => [p.key, p]) ?? []), [projects.data]);
  const filtered = route.project ? projectMap.get(route.project) : undefined;

  return (
    <aside className="flex h-full min-h-0 flex-col bg-side lg:border-r lg:border-line">
      <div className="flex h-[52px] shrink-0 items-center gap-2 pr-2 pl-4">
        <button type="button" onClick={() => navigate({ sessionId: undefined, seq: undefined, q: undefined })} className="flex min-w-0 items-center gap-2 rounded-md text-[14px] font-semibold tracking-[-0.01em]">
          <Logo />
          Agent History
        </button>
        <span className="flex-1" />
        <IconButton label="Hide sidebar (⌘\)" onClick={onClose}>
          <PanelLeftClose size={17} />
        </IconButton>
      </div>

      <div className="space-y-2.5 px-3 pb-2">
        <label className="flex h-9 items-center gap-2 rounded-lg border border-line bg-canvas px-2.5 transition-colors focus-within:border-accent/60 dark:bg-raised/60">
          <Search size={15} className="shrink-0 text-faint" />
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Search every message"
            aria-label="Search every message"
            className="min-w-0 flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-faint"
            onKeyDown={(e) => e.key === 'Escape' && (setText(''), e.currentTarget.blur())}
          />
          {text ? (
            <button type="button" aria-label="Clear search" onClick={() => (setText(''), inputRef.current?.focus())} className="rounded p-0.5 text-faint hover:text-ink">
              <X size={14} />
            </button>
          ) : (
            <kbd className="!border-line !bg-transparent">/</kbd>
          )}
        </label>
        {sources.length > 1 && (
          <Segmented
            label="Agent"
            className="w-full"
            value={route.source ?? ''}
            onChange={(v) => navigate({ source: v || undefined, project: undefined }, { replace: true })}
            options={[{ value: '', label: 'All' }, ...sources.map((s) => ({ value: s.id, label: s.displayName, title: `${s.sessionCount} chats` }))]}
          />
        )}
      </div>

      {!route.q && (
        <div className="flex items-center gap-1 px-3 pt-1 pb-1" role="tablist" aria-label="Group chats">
          {(['projects', 'recent'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={`rounded-md px-2 py-1 text-[12.5px] font-medium transition-colors ${mode === m ? 'bg-hover text-ink' : 'text-faint hover:text-muted'}`}
            >
              {m === 'projects' ? 'Projects' : 'Recent'}
            </button>
          ))}
        </div>
      )}

      {filtered && !route.q && (
        <div className="mx-3 mb-1 flex items-center gap-2 rounded-lg bg-accent-soft px-2.5 py-1.5 text-[12.5px] text-accent">
          <FolderOpen size={14} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">{labelFor(filtered.key, projectMap)}</span>
          <button type="button" aria-label="Show all projects" onClick={() => navigate({ project: undefined }, { replace: true })} className="rounded p-0.5 hover:bg-accent-soft">
            <X size={13} />
          </button>
        </div>
      )}

      {route.q ? <SearchResults q={route.q} projectMap={projectMap} /> : mode === 'projects' && !route.project ? <ProjectTree projectMap={projectMap} /> : <RecentList projectMap={projectMap} />}

      <Footer status={status} theme={theme} onTheme={onTheme} />
    </aside>
  );
}

function Logo() {
  return (
    <span className="flex size-6 items-center justify-center rounded-[7px] bg-ink text-canvas">
      <History size={14} strokeWidth={2.25} />
    </span>
  );
}

/* ------------------------------------------------------------------ */

const SCRATCH = '__scratch';

function labelFor(key: string, projects: Map<string, ProjectMeta>) {
  if (key === SCRATCH) return 'Scratch chats';
  if (key.startsWith('path:')) return projectName(key.slice(5));
  const p = projects.get(key);
  return p?.displayName || projectName(p?.path, key);
}

/** One folder can hold chats from several agents: group by path, not by source key. */
function groupKey(s: { projectPath?: string; projectKey: string }) {
  if (isScratch(s)) return SCRATCH;
  return s.projectPath ? `path:${s.projectPath.replace(/[\\/]+$/, '')}` : s.projectKey;
}

function useInfiniteList<T>(key: unknown[], fetchPage: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string }>) {
  return useInfiniteQuery({
    queryKey: key,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => fetchPage(pageParam),
    getNextPageParam: (last) => last.nextCursor,
  });
}

function useSessions() {
  const route = useRoute();
  const q = useInfiniteList(['sessions', route.source, route.project], (cursor) => api.sessions({ source: route.source, project: route.project, cursor }));
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const loadMore = useCallback(() => {
    if (q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage();
  }, [q]);
  return { q, items, loadMore };
}

function VirtualList<T>({ items, render, onEnd, estimate, getKey, label }: { items: T[]; render: (item: T) => ReactNode; onEnd: () => void; estimate: (item: T) => number; getKey: (item: T) => string; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({ count: items.length, getScrollElement: () => ref.current, estimateSize: (i) => estimate(items[i]!), overscan: 10, getItemKey: (i) => getKey(items[i]!) });
  const vis = v.getVirtualItems();
  useEffect(() => {
    if ((vis.at(-1)?.index ?? 0) >= items.length - 8) onEnd();
  }, [vis, items.length, onEnd]);
  return (
    <div ref={ref} className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-2 pb-3" role="list" aria-label={label}>
      <div style={{ height: v.getTotalSize(), position: 'relative' }}>
        {vis.map((it) => (
          <div key={it.key} data-index={it.index} ref={v.measureElement} role="listitem" className="absolute top-0 left-0 w-full" style={{ transform: `translateY(${it.start}px)` }}>
            {render(items[it.index]!)}
          </div>
        ))}
      </div>
    </div>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="px-5 py-4 text-[13px] leading-relaxed text-muted">{children}</p>;
}

/* ------------------------------------------------------------------ */

type TreeItem =
  | { t: 'group'; key: string; label: string; collapsed: boolean; count: number }
  | { t: 'chat'; key: string; s: SessionMeta }
  | { t: 'more'; key: string; group: string; hidden: number; expanded: boolean };

const PER_GROUP = 5;

function ProjectTree({ projectMap }: { projectMap: Map<string, ProjectMeta> }) {
  const route = useRoute();
  const { q, items, loadMore } = useSessions();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  // Which source project keys make up each group (a folder used by two agents has two).
  const keysByGroup = useMemo(() => {
    const m = new Map<string, Set<string>>();
    const add = (g: string, k: string) => m.set(g, (m.get(g) ?? new Set()).add(k));
    for (const p of projectMap.values()) add(groupKey({ projectPath: p.path, projectKey: p.key }), p.key);
    for (const s of items) add(groupKey(s), s.projectKey);
    return m;
  }, [projectMap, items]);

  // "Show more" fetches that project's whole list (one page is plenty).
  const extraKeys = [...expanded].filter((g) => g !== SCRATCH).flatMap((g) => [...(keysByGroup.get(g) ?? [])]);
  const extra = useQueries({
    queries: extraKeys.map((k) => ({ queryKey: ['sessions', route.source, k, 'all'], queryFn: () => api.sessions({ source: route.source, project: k, limit: 200 }) })),
  });
  const extraByGroup = useMemo(() => {
    const m = new Map<string, SessionMeta[]>();
    for (const r of extra) for (const s of r.data?.items ?? []) m.set(groupKey(s), [...(m.get(groupKey(s)) ?? []), s]);
    for (const list of m.values()) list.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    return m;
  }, [extra]);

  const tree = useMemo(() => {
    const groups = new Map<string, SessionMeta[]>();
    for (const s of items) {
      const k = groupKey(s);
      groups.set(k, [...(groups.get(k) ?? []), s]);
    }
    const out: TreeItem[] = [];
    for (const [k, list] of groups) {
      let all = list;
      const more = extraByGroup.get(k);
      if (more) {
        const seen = new Set(list.map((s) => s.id));
        all = [...list, ...more.filter((s) => !seen.has(s.id))];
      }
      const known = k === SCRATCH ? 0 : [...(keysByGroup.get(k) ?? [])].reduce((n, key) => n + (projectMap.get(key)?.sessionCount ?? 0), 0);
      const total = Math.max(all.length, known);
      const isCollapsed = collapsed.has(k);
      out.push({ t: 'group', key: `g:${k}`, label: labelFor(k, projectMap), collapsed: isCollapsed, count: total });
      if (isCollapsed) continue;
      const isExpanded = expanded.has(k);
      const shown = isExpanded ? all : all.slice(0, PER_GROUP);
      // Keep the open chat visible even if it's past the fold.
      const active = !isExpanded ? all.find((s) => s.id === route.sessionId) : undefined;
      if (active && !shown.includes(active)) shown.push(active);
      for (const s of shown) out.push({ t: 'chat', key: s.id, s });
      if (total > PER_GROUP) out.push({ t: 'more', key: `m:${k}`, group: k, hidden: total - shown.length, expanded: isExpanded });
    }
    return out;
  }, [items, collapsed, expanded, extraByGroup, keysByGroup, projectMap, route.sessionId]);

  const toggle = (set: Set<string>, k: string) => {
    const n = new Set(set);
    if (n.has(k)) n.delete(k);
    else n.add(k);
    return n;
  };

  if (q.isLoading) return <ListSkeleton />;
  if (q.isError) return <Note>{(q.error as Error).message}</Note>;
  if (!items.length) return <Note>No chats yet. They appear here as indexing finishes.</Note>;

  return (
    <VirtualList
      label="Chats by project"
      items={tree}
      estimate={(i) => (i.t === 'group' ? 40 : 32)}
      getKey={(i) => i.key}
      onEnd={loadMore}
      render={(i) => {
        if (i.t === 'group') {
          const k = i.key.slice(2);
          return (
            <button
              type="button"
              onClick={() => setCollapsed((c) => toggle(c, k))}
              aria-expanded={!i.collapsed}
              className="group mt-2 flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13.5px] text-ink/90 hover:bg-hover"
              title={k === SCRATCH ? 'Chats run in temporary scratch folders' : k.startsWith('path:') ? k.slice(5) : (projectMap.get(k)?.path ?? k)}
            >
              {i.collapsed ? <Folder size={15} className="shrink-0 text-muted" strokeWidth={1.75} /> : <FolderOpen size={15} className="shrink-0 text-muted" strokeWidth={1.75} />}
              <span className="min-w-0 flex-1 truncate font-medium">{i.label}</span>
              <span className="text-[11.5px] text-faint tabular-nums opacity-0 transition-opacity group-hover:opacity-100">{i.count}</span>
              <ChevronRight size={14} className={`shrink-0 text-faint transition-transform ${i.collapsed ? '' : 'rotate-90'}`} />
            </button>
          );
        }
        if (i.t === 'more')
          return (
            <button type="button" onClick={() => setExpanded((e) => toggle(e, i.group))} className="flex h-8 w-full items-center rounded-lg pl-[31px] text-left text-[12.5px] text-faint hover:bg-hover hover:text-muted">
              {i.expanded ? 'Show less' : i.hidden > 0 ? `Show ${i.hidden} more` : 'Show more'}
            </button>
          );
        return <ChatRow s={i.s} active={i.s.id === route.sessionId} indent showAgent={!route.source} />;
      }}
    />
  );
}

function ChatRow({ s, active, indent, showAgent }: { s: SessionMeta; active: boolean; indent?: boolean; showAgent?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => navigate({ sessionId: s.id, seq: undefined })}
      aria-current={active ? 'page' : undefined}
      title={s.title || s.firstPrompt}
      className={`group flex h-8 w-full items-center gap-2 rounded-lg pr-2 text-left text-[13.5px] transition-colors ${indent ? 'pl-[31px]' : 'pl-2.5'} ${
        active ? 'bg-press text-ink' : 'text-ink/80 hover:bg-hover hover:text-ink'
      }`}
    >
      <span className="min-w-0 flex-1 truncate">{s.title || s.firstPrompt || 'Untitled chat'}</span>
      {showAgent && s.sourceId !== 'claude-code' && <span className="shrink-0 text-[11px] text-faint group-hover:hidden">{sourceLabel(s.sourceId)}</span>}
      <span className="hidden shrink-0 text-[11.5px] text-faint tabular-nums group-hover:block">{relDate(s.updatedAt)}</span>
    </button>
  );
}

/* ------------------------------------------------------------------ */

type RecentItem = { t: 'head'; key: string; label: string } | { t: 'chat'; key: string; s: SessionMeta };

function bucket(iso?: string): string {
  if (!iso) return 'Older';
  const d = new Date(iso);
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = d.getTime();
  if (t >= start) return 'Today';
  if (t >= start - 86_400_000) return 'Yesterday';
  if (t >= start - 6 * 86_400_000) return 'Previous 7 days';
  if (t >= start - 29 * 86_400_000) return 'Previous 30 days';
  return d.getFullYear() === now.getFullYear() ? d.toLocaleString(undefined, { month: 'long' }) : String(d.getFullYear());
}

function RecentList({ projectMap }: { projectMap: Map<string, ProjectMeta> }) {
  const route = useRoute();
  const { q, items, loadMore } = useSessions();
  const list = useMemo(() => {
    const out: RecentItem[] = [];
    let last = '';
    for (const s of items) {
      const b = bucket(s.updatedAt);
      if (b !== last) out.push({ t: 'head', key: `h:${b}:${s.id}`, label: b });
      last = b;
      out.push({ t: 'chat', key: s.id, s });
    }
    return out;
  }, [items]);

  if (q.isLoading) return <ListSkeleton />;
  if (q.isError) return <Note>{(q.error as Error).message}</Note>;
  if (!items.length) return <Note>No chats yet. They appear here as indexing finishes.</Note>;

  return (
    <VirtualList
      label="Recent chats"
      items={list}
      estimate={(i) => (i.t === 'head' ? 34 : 50)}
      getKey={(i) => i.key}
      onEnd={loadMore}
      render={(i) =>
        i.t === 'head' ? (
          <div className="px-2.5 pt-4 pb-1.5 text-[11.5px] font-medium text-faint">{i.label}</div>
        ) : (
          <button
            type="button"
            onClick={() => navigate({ sessionId: i.s.id, seq: undefined })}
            aria-current={i.s.id === route.sessionId ? 'page' : undefined}
            className={`block w-full rounded-lg px-2.5 py-1.5 text-left transition-colors ${i.s.id === route.sessionId ? 'bg-press' : 'hover:bg-hover'}`}
          >
            <div className="truncate text-[13.5px] text-ink/90">{i.s.title || i.s.firstPrompt || 'Untitled chat'}</div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-faint">
              <span className="min-w-0 truncate">{isScratch(i.s) ? 'Scratch chat' : labelFor(groupKey(i.s), projectMap)}</span>
              <span>·</span>
              <span className="shrink-0">{relDate(i.s.updatedAt)}</span>
              {!route.source && i.s.sourceId !== 'claude-code' && (
                <>
                  <span>·</span>
                  <span className="shrink-0">{sourceLabel(i.s.sourceId)}</span>
                </>
              )}
            </div>
          </button>
        )
      }
    />
  );
}

/* ------------------------------------------------------------------ */

function SearchResults({ q: text, projectMap }: { q: string; projectMap: Map<string, ProjectMeta> }) {
  const route = useRoute();
  const q = useInfiniteList(['search', text, route.source, route.project], (cursor) => api.search({ q: text, source: route.source, project: route.project, cursor }));
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const loadMore = useCallback(() => {
    if (q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage();
  }, [q]);
  if (q.isLoading) return <ListSkeleton two />;
  if (q.isError) return <Note>{(q.error as Error).message}</Note>;
  if (!items.length)
    return (
      <Note>
        No messages match “{text}”.
        <br />
        <span className="text-faint">Try fewer or different words.</span>
      </Note>
    );
  return (
    <>
      <div className="px-5 pt-1 pb-1 text-[11.5px] font-medium text-faint">{q.hasNextPage ? `${items.length}+ matches` : `${items.length} ${items.length === 1 ? 'match' : 'matches'}`}</div>
      <VirtualList
        label="Search results"
        items={items}
        estimate={() => 92}
        getKey={(h) => `${h.sessionId}:${h.seq}`}
        onEnd={loadMore}
        render={(h) => <Hit h={h} active={route.sessionId === h.sessionId && route.seq === h.seq} project={isScratch(h) ? 'Scratch chat' : labelFor(groupKey(h), projectMap)} />}
      />
    </>
  );
}

function Hit({ h, active, project }: { h: SearchHit; active: boolean; project: string }) {
  const who = h.role === 'user' ? 'You' : h.role === 'assistant' ? 'Reply' : h.role === 'tool' ? 'Tool output' : 'Background';
  return (
    <button type="button" onClick={() => navigate({ sessionId: h.sessionId, seq: h.seq })} className={`block w-full rounded-lg px-2.5 py-2 text-left transition-colors ${active ? 'bg-press' : 'hover:bg-hover'}`}>
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink/90">{h.sessionTitle || 'Untitled chat'}</span>
        <span className="shrink-0 text-[11.5px] text-faint">{relDate(h.timestamp)}</span>
      </div>
      {/* The server escapes everything except <mark>. */}
      <p className="mt-0.5 line-clamp-2 text-[12.5px] leading-snug text-muted" dangerouslySetInnerHTML={{ __html: h.snippet }} />
      <div className="mt-1 truncate text-[11px] text-faint">
        {who} · {project}
      </div>
    </button>
  );
}

function ListSkeleton({ two }: { two?: boolean }) {
  return (
    <div className="space-y-1 px-4 py-3" aria-label="Loading" role="status">
      {Array.from({ length: 9 }, (_, i) => (
        <div key={i} className="py-1.5">
          <div className="h-3 animate-pulse rounded bg-hover" style={{ width: `${55 + ((i * 37) % 40)}%` }} />
          {two && <div className="mt-2 h-2.5 w-4/5 animate-pulse rounded bg-hover" />}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Footer({ status, theme, onTheme }: { status?: Status; theme: ThemePref; onTheme: (t: ThemePref) => void }) {
  const index = status?.index;
  const indexing = index?.state === 'indexing' && index.filesTotal > 0;
  return (
    <div className="shrink-0 border-t border-line px-3 py-2.5" aria-live="polite">
      {indexing && (
        <div className="mb-2 px-1">
          <div className="mb-1.5 flex justify-between text-[11.5px] text-muted">
            <span>Indexing chats…</span>
            <span className="tabular-nums">
              {index.filesDone} / {index.filesTotal}
            </span>
          </div>
          <div className="h-[3px] overflow-hidden rounded-full bg-hover">
            <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${(100 * index.filesDone) / Math.max(1, index.filesTotal)}%` }} />
          </div>
        </div>
      )}
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate px-1 text-[11.5px] text-faint" title="Read from local files; nothing leaves this computer">
          {index ? `${index.sessionCount.toLocaleString()} chats · on this computer` : ''}
        </span>
        <div role="radiogroup" aria-label="Theme" className="flex rounded-lg bg-hover p-0.5">
          {(
            [
              ['system', Monitor, 'Match system'],
              ['light', Sun, 'Light'],
              ['dark', Moon, 'Dark'],
            ] as const
          ).map(([v, Icon, label]) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={theme === v}
              aria-label={label}
              title={label}
              onClick={() => onTheme(v)}
              className={`flex size-6 items-center justify-center rounded-md transition-colors ${theme === v ? 'bg-canvas text-ink shadow-[0_1px_2px_rgb(0_0_0/0.1)] dark:bg-raised-2' : 'text-faint hover:text-ink'}`}
            >
              <Icon size={13} />
            </button>
          ))}
        </div>
      </div>
      {index?.lastError && (
        <div className="mt-1.5 truncate px-1 text-[11.5px] text-error" title={index.lastError}>
          {index.lastError}
        </div>
      )}
    </div>
  );
}
