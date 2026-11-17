import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, Maximize2, Minimize2, PanelRight, PictureInPicture2, X } from 'lucide-react';
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

/* ------------------------------------------------------------------ */
/* Layout state: docked or floating, width, full screen.               */

export type SideMode = 'docked' | 'floating';
/** How the panel is actually drawn right now. */
export type SidePresentation = 'docked' | 'floating' | 'full' | 'sheet';

const MIN_W = 320;
const MAX_W = 900;
const DEFAULT_W = 440;
/** The chat beside a docked panel keeps at least this much room. */
const MAIN_MIN = 460;
const SIDEBAR_W = 280;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* ignore */
  }
}

function useViewportWidth() {
  const [w, setW] = useState(() => window.innerWidth);
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return w;
}

export interface SideLayout {
  presentation: SidePresentation;
  mode: SideMode;
  setMode: (m: SideMode) => void;
  width: number;
  maxWidth: number;
  setWidth: (w: number) => void;
  full: boolean;
  setFull: (f: boolean) => void;
  /** docking is possible at the current window size */
  canDock: boolean;
}

/**
 * The side-chat panel sits in the page beside the chat whenever there's room
 * for both; it can be popped out to float over the chat, or take over the
 * whole main area. Width and mode are remembered.
 */
export function useSideLayout(open: boolean, sidebarShown: boolean): SideLayout {
  const vw = useViewportWidth();
  const [mode, setModeState] = useState<SideMode>(() => (read('agentdesk-side-mode') === 'floating' ? 'floating' : 'docked'));
  const [width, setWidthState] = useState(() => {
    const n = Number(read('agentdesk-side-width'));
    return Number.isFinite(n) && n >= MIN_W ? Math.min(n, MAX_W) : DEFAULT_W;
  });
  const [full, setFull] = useState(false);
  useEffect(() => {
    if (!open) setFull(false);
  }, [open]);

  const desktop = vw >= 1024;
  const available = vw - (desktop && sidebarShown ? SIDEBAR_W : 0);
  const maxWidth = Math.max(MIN_W, Math.min(MAX_W, available - MAIN_MIN, vw - 24));
  const canDock = vw >= 768 && available - MIN_W >= MAIN_MIN;

  const setMode = useCallback((m: SideMode) => {
    setModeState(m);
    write('agentdesk-side-mode', m);
  }, []);
  const setWidth = useCallback((w: number) => {
    const n = Math.round(Math.min(MAX_W, Math.max(MIN_W, w)));
    setWidthState(n);
    write('agentdesk-side-width', String(n));
  }, []);

  const presentation: SidePresentation = full ? 'full' : vw < 768 ? 'sheet' : mode === 'floating' || !canDock ? 'floating' : 'docked';
  return { presentation, mode, setMode, width: Math.min(width, maxWidth), maxWidth, setWidth, full, setFull, canDock };
}

/* ------------------------------------------------------------------ */

function ResizeHandle({ layout }: { layout: SideLayout }) {
  const start = useRef<{ x: number; w: number } | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, w: layout.width };
    setDragging(true);
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = start.current;
    if (!s) return;
    // Dragging the left edge left makes the panel wider.
    layout.setWidth(Math.min(layout.maxWidth, s.w + (s.x - e.clientX)));
  };
  const onUp = () => {
    start.current = undefined;
    setDragging(false);
  };
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 80 : 24;
    if (e.key === 'ArrowLeft') layout.setWidth(Math.min(layout.maxWidth, layout.width + step));
    else if (e.key === 'ArrowRight') layout.setWidth(layout.width - step);
    else if (e.key === 'Home') layout.setWidth(MIN_W);
    else if (e.key === 'End') layout.setWidth(layout.maxWidth);
    else return;
    e.preventDefault();
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize side chats"
      aria-valuemin={MIN_W}
      aria-valuemax={layout.maxWidth}
      aria-valuenow={layout.width}
      tabIndex={0}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onKeyDown={onKey}
      onDoubleClick={() => layout.setWidth(DEFAULT_W)}
      title="Drag to resize · double-click to reset"
      className="group absolute inset-y-0 -left-[3px] z-20 w-[7px] cursor-col-resize touch-none focus-visible:outline-none"
    >
      <span className={`absolute inset-y-0 left-[3px] w-px transition-colors ${dragging ? 'bg-accent' : 'bg-transparent group-hover:bg-accent/60 group-focus-visible:bg-accent'}`} />
      {/* Keep the cursor while dragging over the conversation. */}
      {dragging && <span className="fixed inset-0 cursor-col-resize" />}
    </div>
  );
}

/**
 * Side chats ("btw" questions, forks) started from the open chat: one tab per
 * side chat, closeable, openable as a full chat; docked, floating or full.
 */
export function SidePanel({ sessionId, sideId, layout }: { sessionId: string; sideId: string; layout: SideLayout }) {
  const parent = useQuery({ queryKey: ['session', sessionId], queryFn: () => api.session(sessionId) });
  const side = useQuery({ queryKey: ['session', sideId], queryFn: () => api.session(sideId) });
  const list = parent.data?.sideChats ?? [];
  // A side chat linked from elsewhere still gets a tab.
  const tabs = list.some((s) => s.id === sideId) || !side.data ? list : [...list, side.data];
  const { presentation: p, full, setFull } = layout;

  const close = useCallback(() => navigate({ side: undefined }, { replace: true }), []);
  const activeTab = useRef<HTMLButtonElement>(null);
  useEffect(() => activeTab.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' }), [sideId]);

  // Esc leaves full screen first, then closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (document.querySelector('[role="dialog"]')) return; // a popover or lightbox handles its own Esc
      if (full) setFull(false);
      else close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [full, setFull, close]);

  const frame =
    p === 'docked'
      ? 'relative shrink-0 border-l border-line'
      : p === 'full'
        ? 'relative min-w-0 flex-1'
        : p === 'floating'
          ? 'animate-pop fixed top-14 right-3 bottom-3 z-40 !h-auto overflow-hidden rounded-xl border border-line-strong shadow-pop'
          : 'animate-slide-in fixed inset-y-0 right-0 z-40 w-[min(440px,100vw)] shadow-pop';
  const style = p === 'docked' || p === 'floating' ? { width: p === 'floating' ? Math.min(layout.width, window.innerWidth - 24) : layout.width } : undefined;

  return (
    <>
      {p === 'sheet' && <div className="fixed inset-0 z-30 bg-black/30 backdrop-blur-[1px]" onClick={close} aria-hidden />}
      <aside aria-label="Side chats" className={`flex h-full min-h-0 flex-col bg-canvas ${frame}`} style={style}>
        {(p === 'docked' || p === 'floating') && <ResizeHandle layout={layout} />}
        <div className="flex h-12 shrink-0 items-center gap-1 border-b border-line pr-2 pl-2">
          <div
            role="tablist"
            aria-label="Side chats"
            className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [mask-image:linear-gradient(to_right,#000_calc(100%-20px),transparent)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
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
                  className={`h-7 max-w-[168px] shrink-0 truncate rounded-md px-2.5 text-[12px] transition-colors ${
                    active ? 'bg-press font-medium text-ink' : 'text-muted hover:bg-hover hover:text-ink'
                  }`}
                >
                  {label}
                </button>
              );
            })}
            <span className="w-4 shrink-0" aria-hidden />
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            {p !== 'sheet' && p !== 'full' && (
              <IconButton
                label={p === 'docked' ? 'Pop out' : layout.canDock ? 'Dock to the side' : 'Not enough room to dock'}
                onClick={() => layout.setMode(p === 'docked' ? 'floating' : 'docked')}
                className={p === 'floating' && !layout.canDock ? 'pointer-events-none opacity-40' : ''}
              >
                {p === 'docked' ? <PictureInPicture2 size={15} /> : <PanelRight size={15} />}
              </IconButton>
            )}
            {p !== 'sheet' && (
              <IconButton label={full ? 'Exit full screen (Esc)' : 'Full screen'} onClick={() => setFull(!full)} active={full}>
                {full ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              </IconButton>
            )}
            <IconButton label="Open as a full chat" onClick={() => navigate({ sessionId: sideId, side: undefined, seq: undefined })}>
              <ArrowUpRight size={16} />
            </IconButton>
            <span className="mx-0.5 h-4 w-px bg-line" aria-hidden />
            <IconButton label="Close side chats (Esc)" onClick={close}>
              <X size={16} />
            </IconButton>
          </div>
        </div>
        <div className="relative min-h-0 flex-1">
          <Conversation key={sideId} sessionId={sideId} view="conversation" embedded />
        </div>
      </aside>
    </>
  );
}
