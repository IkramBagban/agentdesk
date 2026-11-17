import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Maximize2, X } from 'lucide-react';
import { api, type SessionMeta } from '../api.ts';
import { navigate } from '../router.ts';
import { relDate } from '../format.ts';
import { Conversation } from './Conversation.tsx';
import { IconButton } from './ui.tsx';

/** "btw: how does x work" → "how does x work" */
export function sideChatLabel(s: Pick<SessionMeta, 'title' | 'firstPrompt'>): string {
  const t = (s.title || s.firstPrompt || 'Side chat').trim();
  return t.replace(/^btw:\s*/i, '') || 'Side chat';
}

/**
 * Side chats ("btw" questions, forks) started from the open chat, shown in a
 * panel on the right like the agent's own app does: one tab per side chat,
 * closeable, and openable as a full chat.
 */
export function SidePanel({ sessionId, sideId, overlay }: { sessionId: string; sideId: string; overlay: boolean }) {
  const parent = useQuery({ queryKey: ['session', sessionId], queryFn: () => api.session(sessionId) });
  const side = useQuery({ queryKey: ['session', sideId], queryFn: () => api.session(sideId) });
  const list = parent.data?.sideChats ?? [];
  // A side chat linked from elsewhere still gets a tab.
  const tabs = list.some((s) => s.id === sideId) || !side.data ? list : [...list, side.data];

  const close = () => navigate({ side: undefined }, { replace: true });
  const activeTab = useRef<HTMLButtonElement>(null);
  useEffect(() => activeTab.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' }), [sideId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      {overlay && <div className="fixed inset-0 z-30 bg-black/30 backdrop-blur-[1px]" onClick={close} aria-hidden />}
      <aside
        aria-label="Side chats"
        className={`flex h-full flex-col border-l border-line bg-canvas ${
          overlay ? 'animate-slide-in fixed inset-y-0 right-0 z-40 w-[min(460px,92vw)] shadow-pop' : 'w-[clamp(360px,34vw,520px)] shrink-0'
        }`}
      >
        <div className="flex h-[56px] shrink-0 items-center gap-1 border-b border-line pr-2 pl-2">
          <div role="tablist" aria-label="Side chats" className="scroll-quiet flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">
            {tabs.map((t) => {
              const active = t.id === sideId;
              const label = sideChatLabel(t);
              return (
                <button
                  key={t.id}
                  ref={active ? activeTab : undefined}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  title={`${label}${t.startedAt ? ` · ${relDate(t.startedAt)}` : ''}`}
                  onClick={() => navigate({ side: t.id }, { replace: true })}
                  className={`max-w-[180px] shrink-0 truncate rounded-lg px-2.5 py-1.5 text-[12.5px] transition-colors ${
                    active ? 'bg-press font-medium text-ink' : 'text-muted hover:bg-hover hover:text-ink'
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <IconButton label="Open as a full chat" onClick={() => navigate({ sessionId: sideId, side: undefined, seq: undefined })}>
            <Maximize2 size={15} />
          </IconButton>
          <IconButton label="Close side chats (Esc)" onClick={close}>
            <X size={17} />
          </IconButton>
        </div>
        <div className="relative min-h-0 flex-1">
          <Conversation key={sideId} sessionId={sideId} view="conversation" embedded />
        </div>
      </aside>
    </>
  );
}
