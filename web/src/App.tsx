import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Moon, Sun } from 'lucide-react';
import { api } from './api.ts';
import { useRoute } from './router.ts';
import { Sidebar } from './components/Sidebar.tsx';
import { SessionHeader } from './components/SessionHeader.tsx';
import { Conversation } from './components/Conversation.tsx';
import { Spine } from './components/Spine.tsx';

function useTheme() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try {
      const saved = localStorage.getItem('ah-theme');
      if (saved === 'light' || saved === 'dark') return saved;
    } catch {
      /* storage blocked */
    }
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('ah-theme', theme);
    } catch {
      /* ignore */
    }
  }, [theme]);
  return [theme, () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))] as const;
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

export function App() {
  const route = useRoute();
  const [theme, toggleTheme] = useTheme();
  const [drawer, setDrawer] = useState(false);
  const status = useQuery({ queryKey: ['status'], queryFn: api.status, refetchInterval: (q) => (q.state.data?.index.state === 'indexing' ? 2000 : false) });
  useLiveUpdates();

  const jumpRef = useRef<(seq: number) => void>(undefined);
  const registerJump = useCallback((fn: (seq: number) => void) => {
    jumpRef.current = fn;
  }, []);

  useEffect(() => setDrawer(false), [route.sessionId]);

  return (
    <div className="flex h-full">
      <div className={`fixed inset-y-0 left-0 z-30 w-[22rem] max-w-[88vw] transition-transform lg:static lg:translate-x-0 ${drawer ? 'translate-x-0 shadow-2xl' : '-translate-x-full'}`}>
        <Sidebar status={status.data} />
      </div>
      {drawer && <div className="fixed inset-0 z-20 bg-black/30 lg:hidden" onClick={() => setDrawer(false)} />}

      <main className="flex min-w-0 flex-1 flex-col">
        {route.sessionId ? (
          <>
            <SessionHeader sessionId={route.sessionId} view={route.view} onMenu={() => setDrawer(true)} />
            <div className="flex min-h-0 flex-1">
              <div className="min-w-0 flex-1">
                <Conversation key={route.sessionId} sessionId={route.sessionId} view={route.view} seq={route.seq} onScrollToPrompt={registerJump} />
              </div>
              <Spine sessionId={route.sessionId} current={route.seq} onJump={(seq) => jumpRef.current?.(seq)} />
            </div>
          </>
        ) : (
          <Welcome onMenu={() => setDrawer(true)} sessionCount={status.data?.index.sessionCount} />
        )}
      </main>

      <button
        type="button"
        onClick={toggleTheme}
        aria-label={theme === 'dark' ? 'Use light theme' : 'Use dark theme'}
        className="fixed right-3 bottom-3 z-10 rounded-full border border-rule bg-surface p-2 text-muted shadow-sm hover:text-ink"
      >
        {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
      </button>
    </div>
  );
}

function Welcome({ onMenu, sessionCount }: { onMenu: () => void; sessionCount?: number }) {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-md">
        <h1 className="font-serif text-[28px] leading-tight font-medium">Your agent history</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-muted">
          {sessionCount ? `${sessionCount.toLocaleString()} chats` : 'Your chats'} from this computer, read straight from the files your coding agents keep. Pick a chat on the left, or press <kbd className="rounded border border-rule bg-surface px-1.5 font-mono text-[12px]">/</kbd> to search every message.
        </p>
        <p className="mt-3 text-[13px] text-faint">
          Inside a chat, <kbd className="rounded border border-rule bg-surface px-1 font-mono text-[11px]">j</kbd> and <kbd className="rounded border border-rule bg-surface px-1 font-mono text-[11px]">k</kbd> move between your prompts.
        </p>
        <button type="button" onClick={onMenu} className="mt-5 rounded-md bg-ink px-3 py-1.5 text-paper lg:hidden">
          Show chats
        </button>
      </div>
    </div>
  );
}
