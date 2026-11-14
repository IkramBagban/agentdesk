import { useCallback, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { History, Lock, PanelLeft } from 'lucide-react';
import { api, ApiError } from './api.ts';
import { useRoute } from './router.ts';
import { Sidebar } from './components/Sidebar.tsx';
import { SessionHeader } from './components/SessionHeader.tsx';
import { Conversation } from './components/Conversation.tsx';
import { IconButton } from './components/ui.tsx';

export type ThemePref = 'system' | 'light' | 'dark';

function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    if (v && (allowed as readonly string[]).includes(v)) return v as T;
  } catch {
    /* storage blocked */
  }
  return fallback;
}

function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

/** Theme follows the OS unless the reader picks one; the OS is tracked live. */
function useTheme() {
  const [pref, setPref] = useState<ThemePref>(() => readPref('ah-theme', ['system', 'light', 'dark'] as const, 'system'));
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      document.documentElement.dataset.theme = pref === 'system' ? (mq.matches ? 'dark' : 'light') : pref;
    };
    apply();
    writePref('ah-theme', pref);
    if (pref !== 'system') return;
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [pref]);
  return [pref, setPref] as const;
}

/** Live updates: index progress and changed sessions arrive over SSE. */
function useLiveUpdates() {
  const qc = useQueryClient();
  useEffect(() => {
    const es = new EventSource('/api/stream');
    let pending = false;
    const refreshLists = () => {
      if (pending) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        void qc.invalidateQueries({ queryKey: ['sessions'] });
        void qc.invalidateQueries({ queryKey: ['projects'] });
        void qc.invalidateQueries({ queryKey: ['status'] });
      }, 1500);
    };
    es.addEventListener('index-progress', refreshLists);
    es.addEventListener('session-updated', (e) => {
      refreshLists();
      try {
        const { id } = JSON.parse((e as MessageEvent).data) as { id: string };
        void qc.invalidateQueries({ queryKey: ['session', id] });
        void qc.invalidateQueries({ queryKey: ['outline', id] });
        void qc.invalidateQueries({ queryKey: ['events', id] });
      } catch {
        /* ignore */
      }
    });
    return () => es.close();
  }, [qc]);
}

const DESKTOP = '(min-width: 1024px)';
const isDesktop = () => window.matchMedia(DESKTOP).matches;

function useIsDesktop() {
  const [v, setV] = useState(isDesktop);
  useEffect(() => {
    const mq = window.matchMedia(DESKTOP);
    const on = () => setV(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return v;
}

export function App() {
  const route = useRoute();
  const [theme, setTheme] = useTheme();
  // Desktop: sidebar shown/hidden (remembered). Below 1024px: a drawer.
  const [pinned, setPinned] = useState(() => readPref('ah-sidebar', ['open', 'closed'] as const, 'open') === 'open');
  const [drawer, setDrawer] = useState(false);
  const desktop = useIsDesktop();
  const status = useQuery({ queryKey: ['status'], queryFn: api.status, refetchInterval: (q) => (q.state.data?.index.state === 'indexing' ? 2000 : false) });
  useLiveUpdates();

  const toggleSidebar = useCallback(() => {
    if (isDesktop()) {
      setPinned((p) => {
        writePref('ah-sidebar', p ? 'closed' : 'open');
        return !p;
      });
    } else setDrawer((d) => !d);
  }, []);

  useEffect(() => setDrawer(false), [route.sessionId, route.seq]);
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setDrawer(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawer]);

  // Cmd/Ctrl+\ toggles the sidebar, like desktop chat apps.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleSidebar]);

  if (status.error instanceof ApiError && status.error.status === 401) return <Locked />;

  return (
    <div className="flex h-full bg-canvas">
      <div
        className={`fixed inset-y-0 left-0 z-40 w-[280px] max-w-[86vw] transition-transform duration-200 ease-out lg:static lg:z-auto lg:shrink-0 lg:transition-[margin] ${
          drawer ? 'translate-x-0 shadow-pop' : '-translate-x-full'
        } lg:translate-x-0 lg:shadow-none ${pinned ? '' : 'lg:-ml-[280px]'}`}
        inert={(desktop ? !pinned : !drawer) ? true : undefined}
      >
        <Sidebar status={status.data} theme={theme} onTheme={setTheme} onClose={toggleSidebar} />
      </div>
      {drawer && <div className="fixed inset-0 z-30 bg-black/40 backdrop-blur-[1px] lg:hidden" onClick={() => setDrawer(false)} aria-hidden />}

      <main className="flex min-w-0 flex-1 flex-col">
        {route.sessionId ? (
          <>
            <SessionHeader sessionId={route.sessionId} view={route.view} onToggleSidebar={toggleSidebar} sidebarShown={pinned} />
            <div className="relative min-h-0 flex-1">
              <Conversation
                key={`${route.sessionId}:${route.view}`}
                sessionId={route.sessionId}
                view={route.view}
                seq={route.seq}
              />
            </div>
          </>
        ) : (
          <Welcome onToggleSidebar={toggleSidebar} sidebarShown={pinned} sessionCount={status.data?.index.sessionCount} />
        )}
      </main>
    </div>
  );
}

function Welcome({ onToggleSidebar, sidebarShown, sessionCount }: { onToggleSidebar: () => void; sidebarShown: boolean; sessionCount?: number }) {
  return (
    <div className="flex h-full flex-col">
      <div className={`flex h-[52px] shrink-0 items-center px-3 ${sidebarShown ? 'lg:hidden' : ''}`}>
        <IconButton label="Show sidebar" onClick={onToggleSidebar}>
          <PanelLeft size={18} />
        </IconButton>
      </div>
      <div className="flex flex-1 items-center justify-center px-6 pb-16">
        <div className="max-w-[420px] text-center">
          <div className="mx-auto mb-5 flex size-12 items-center justify-center rounded-2xl bg-raised text-muted">
            <History size={22} strokeWidth={1.75} />
          </div>
          <h1 className="text-[22px] font-semibold tracking-[-0.01em]">Your agent history</h1>
          <p className="mt-2 text-[14.5px] leading-relaxed text-muted">
            {sessionCount ? `${sessionCount.toLocaleString()} chats` : 'Your chats'} from Claude Code and Codex, read straight from the files on this computer. Nothing leaves it.
          </p>
          <div className="mt-6 inline-flex flex-wrap justify-center gap-x-5 gap-y-2 text-[12.5px] text-faint">
            <span>
              <kbd>/</kbd> search
            </span>
            <span>
              <kbd>j</kbd> <kbd>k</kbd> next / previous prompt
            </span>
            <span>
              <kbd>⌘</kbd> <kbd>\</kbd> sidebar
            </span>
          </div>
          <button type="button" onClick={onToggleSidebar} className="mt-7 rounded-full bg-ink px-4 py-2 text-[13.5px] font-medium text-canvas lg:hidden">
            Browse chats
          </button>
        </div>
      </div>
    </div>
  );
}

function Locked() {
  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="max-w-[420px] text-center">
        <div className="mx-auto mb-5 flex size-12 items-center justify-center rounded-2xl bg-raised text-muted">
          <Lock size={20} strokeWidth={1.75} />
        </div>
        <h1 className="text-[20px] font-semibold tracking-[-0.01em]">Open the link from your terminal</h1>
        <p className="mt-2 text-[14.5px] leading-relaxed text-muted">
          This page needs the private link that <code className="rounded bg-raised px-1 py-0.5 font-mono text-[12.5px]">agent-history</code> printed when it started. It keeps other websites and apps from reading your chats.
        </p>
        <p className="mt-3 text-[13px] text-faint">Closed the terminal? Run the command again for a new link.</p>
      </div>
    </div>
  );
}
