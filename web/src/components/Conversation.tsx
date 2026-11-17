import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, Brain, ChevronRight, ClipboardPaste, GitBranch, Images } from 'lucide-react';
import { api, type Block, type ChatEvent, type View } from '../api.ts';
import { navigate } from '../router.ts';
import { bytes, duration, fullDate, plural, separatorDate, time } from '../format.ts';
import { sentence, summarize } from '../tools.ts';
import { buildRows, rowSeqs, type Row } from './rows.ts';
import { BlockView, Disclosure, ImageView, kindIcon, type BlockCtx } from './Blocks.tsx';
import { Markdown } from './Markdown.tsx';
import { Minimap } from './Spine.tsx';
import { CopyButton } from './ui.tsx';

const PAGE = 120;
const END = 2 ** 31 - 1;

type Param = { from: number; dir: 'forward' | 'backward' };

/**
 * `embedded`: shown in the side-chat panel. No minimap or j/k keys (those
 * belong to the main chat) and jumps stay local instead of changing the URL.
 */
export function Conversation({ sessionId, view, seq, embedded = false }: { sessionId: string; view: View; seq?: number; embedded?: boolean }) {
  const meta = useQuery({ queryKey: ['session', sessionId], queryFn: () => api.session(sessionId) });
  const fromAgent = !!meta.data?.parentSessionId;
  // A forked chat (e.g. a side chat) starts with a copy of the chat it came
  // from; begin where it diverges. The full chat view can reveal the copy.
  const [showInherited, setShowInherited] = useState(false);
  const forkedAt = meta.data?.forkedAtSeq ?? 0;
  // (a jump into the copied part, e.g. from search, shows it too)
  const floor = showInherited || (seq != null && seq < forkedAt) ? 0 : forkedAt;

  // Where loading starts: the jump target, the fork point, or (after "scroll to end") the end.
  const [atEnd, setAtEnd] = useState(false);
  useEffect(() => setAtEnd(false), [sessionId, seq, view]);
  const anchor: Param = atEnd ? { from: END, dir: 'backward' } : { from: seq != null ? Math.max(floor, seq - 6) : floor, dir: 'forward' };

  const q = useInfiniteQuery({
    queryKey: ['events', sessionId, view, anchor.from, anchor.dir],
    initialPageParam: anchor,
    queryFn: ({ pageParam }) => api.events(sessionId, { from: pageParam.from, view, limit: PAGE, dir: pageParam.dir }),
    getNextPageParam: (last): Param | undefined => (last.nextFrom != null ? { from: last.nextFrom, dir: 'forward' } : undefined),
    getPreviousPageParam: (first): Param | undefined => (first.prevFrom != null && first.prevFrom > floor ? { from: first.prevFrom, dir: 'backward' } : undefined),
    staleTime: 30_000,
    // the fork point comes from the session record
    enabled: !meta.isPending,
  });

  const events = useMemo(() => {
    const seen = new Set<number>();
    const out: ChatEvent[] = [];
    for (const p of q.data?.pages ?? []) for (const e of p.items) if (e.seq >= floor && !seen.has(e.seq)) (seen.add(e.seq), out.push(e));
    return out.sort((a, b) => a.seq - b.seq);
  }, [q.data, floor]);
  const rows = useMemo(() => buildRows(events), [events]);
  const inheritedNote = !embedded && floor > 0 && !q.hasPreviousPage;

  const scrollRef = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => estimate(rows[i]!),
    overscan: 6,
    getItemKey: (i) => rows[i]!.key,
    paddingStart: inheritedNote ? 64 : 8,
    paddingEnd: 120,
  });

  // Older rows are fetched only when the reader scrolls near the top, and
  // the scroll offset is shifted by exactly the height they add, so the
  // text under the reader's eyes doesn't move.
  const pendingPrepend = useRef<{ top: number; total: number; firstKey?: string } | undefined>(undefined);
  const firstKey = rows[0]?.key;
  useLayoutEffect(() => {
    const p = pendingPrepend.current;
    const el = scrollRef.current;
    if (!p || !el || p.firstKey === firstKey) return;
    pendingPrepend.current = undefined;
    el.scrollTop = p.top + (v.getTotalSize() - p.total);
  }, [firstKey, v]);

  // Which prompt is at the top of the viewport (for the minimap), and whether we're near the end.
  const [currentSeq, setCurrentSeq] = useState<number>();
  const [nearEnd, setNearEnd] = useState(true);
  const updatePosition = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setNearEnd(el.scrollHeight - el.scrollTop - el.clientHeight < 240);
    const top = el.scrollTop + 96;
    const vis = v.getVirtualItems();
    let idx = vis.find((it) => it.end > top)?.index ?? vis[0]?.index;
    if (idx == null) return;
    for (; idx >= 0; idx--) {
      const r = rows[idx]!;
      if (r.kind === 'prompt') return setCurrentSeq(r.event.seq);
    }
  }, [rows, v]);

  const onScroll = () => {
    updatePosition();
    const el = scrollRef.current;
    if (!el || el.scrollTop > 800 || !q.hasPreviousPage || q.isFetchingPreviousPage || pendingPrepend.current) return;
    pendingPrepend.current = { top: el.scrollTop, total: v.getTotalSize(), firstKey };
    void q.fetchPreviousPage().then((r) => {
      // Nothing was added (e.g. error): allow another attempt.
      if (r.data?.pages[0]?.items.length === 0 || r.isError) pendingPrepend.current = undefined;
    });
  };
  useEffect(updatePosition, [rows.length, updatePosition]);

  // Jump target: scroll to the row containing `seq` once loaded.
  const jumped = useRef<string>('');
  useEffect(() => {
    if (seq == null || jumped.current === `${sessionId}:${seq}`) return;
    const idx = rows.findIndex((r) => rowSeqs(r).includes(seq));
    if (idx >= 0) {
      jumped.current = `${sessionId}:${seq}`;
      requestAnimationFrame(() => v.scrollToIndex(idx, { align: 'start' }));
    }
  }, [rows, seq, sessionId, v]);

  // Pin to the bottom until it holds: measured rows replace estimates over a few frames.
  const pinBottom = useCallback(() => {
    const until = performance.now() + 2000;
    let stable = 0;
    const step = () => {
      const el = scrollRef.current;
      if (el) {
        const target = el.scrollHeight - el.clientHeight;
        if (Math.abs(el.scrollTop - target) < 2) stable++;
        else {
          stable = 0;
          el.scrollTop = target;
        }
      }
      // Timers, not animation frames, so this also settles in a background tab.
      if (stable < 8 && performance.now() < until) setTimeout(step, 16);
    };
    setTimeout(step, 0);
  }, []);

  // After "jump to end" loads the last page, land at the bottom.
  const landedEnd = useRef(false);
  const endLoaded = anchor.from === END && !q.isFetching && q.data?.pageParams[0] != null && (q.data.pageParams[0] as Param).from === END;
  useEffect(() => {
    if (!endLoaded || landedEnd.current || !rows.length) return;
    landedEnd.current = true;
    pinBottom();
  }, [endLoaded, rows.length, pinBottom]);

  // Newer rows: fetch when the end comes into view.
  const items = v.getVirtualItems();
  useEffect(() => {
    const last = items.at(-1);
    if (last && last.index >= rows.length - 3 && q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage();
  }, [items, rows.length, q]);

  const jumpTo = useCallback(
    (target: number) => {
      const idx = rows.findIndex((r) => rowSeqs(r).includes(target));
      if (idx >= 0) v.scrollToIndex(idx, { align: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      else if (!embedded) navigate({ seq: target }, { replace: true });
    },
    [rows, v, embedded],
  );

  const toBottom = () => {
    if (q.hasNextPage) {
      landedEnd.current = false;
      if (!embedded) navigate({ seq: undefined }, { replace: true });
      setAtEnd(true);
    } else pinBottom();
  };

  // j / k move between prompts.
  useEffect(() => {
    if (embedded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== 'j' && e.key !== 'k') return;
      const el = scrollRef.current;
      const top = (el?.scrollTop ?? 0) + 24;
      const vis = v.getVirtualItems();
      const at = vis.find((it) => it.end > top)?.index ?? 0;
      const step = e.key === 'j' ? 1 : -1;
      for (let i = at + step; i >= 0 && i < rows.length; i += step) {
        if (rows[i]!.kind === 'prompt') return v.scrollToIndex(i, { align: 'start' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rows, v, embedded]);

  if (q.isError) return <Empty title="This chat couldn’t be loaded" body={(q.error as Error).message} />;
  if (q.isPending) return <LoadingChat />;
  if (!rows.length)
    return <Empty title="Nothing to show in this view" body={view === 'conversation' ? 'Switch to “Everything” to see background records.' : 'This chat file has no readable records.'} />;

  const ctxBase = { sessionId, onOpenSubSession: (id: string) => navigate({ sessionId: id, seq: undefined }) };

  return (
    <>
      <div ref={scrollRef} onScroll={onScroll} className="scroll-quiet relative h-full overflow-y-auto [overflow-anchor:none]" data-testid="conversation">
        <div style={{ height: v.getTotalSize(), position: 'relative' }}>
          {inheritedNote && (
            <div className="absolute top-0 left-0 w-full">
              <div className="mx-auto flex max-w-[760px] items-center gap-3 px-5 pt-5 text-[11.5px] text-faint sm:px-8 md:px-10">
                <span className="h-px flex-1 bg-line" />
                <button type="button" onClick={() => setShowInherited(true)} className="rounded-md px-2 py-1 transition-colors hover:bg-hover hover:text-ink">
                  Started from another chat · show the earlier messages
                </button>
                <span className="h-px flex-1 bg-line" />
              </div>
            </div>
          )}
          {items.map((it) => {
            const row = rows[it.index]!;
            return (
              <div key={it.key} data-index={it.index} ref={v.measureElement} className="absolute top-0 left-0 w-full" style={{ transform: `translateY(${it.start}px)` }}>
                <div className={embedded ? 'mx-auto max-w-[760px] px-4 sm:px-5' : 'mx-auto max-w-[760px] px-5 sm:px-8 md:px-10'}>
                  <RowView row={row} ctxBase={ctxBase} fromAgent={fromAgent} showInjected={view === 'all'} highlight={seq != null && rowSeqs(row).includes(seq)} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {!embedded && <Minimap sessionId={sessionId} current={currentSeq} onJump={jumpTo} />}
      {(!nearEnd || q.hasNextPage) && (
        <button
          type="button"
          onClick={toBottom}
          aria-label="Scroll to the end"
          title="Scroll to the end"
          className="animate-pop absolute bottom-5 left-1/2 z-10 flex size-9 -translate-x-1/2 items-center justify-center rounded-full border border-line bg-canvas text-muted shadow-pop transition-colors hover:text-ink dark:bg-raised"
        >
          <ArrowDown size={17} />
        </button>
      )}
    </>
  );
}

function estimate(r: Row): number {
  switch (r.kind) {
    case 'date':
      return 56;
    case 'activity':
      return 36;
    case 'divider':
      return 56;
    case 'prompt':
      return 96;
    default:
      return 160;
  }
}

function LoadingChat() {
  return (
    <div className="mx-auto max-w-[760px] space-y-8 px-5 pt-10 sm:px-8 md:px-10" role="status" aria-label="Loading chat">
      {[0, 1].map((i) => (
        <div key={i} className="space-y-3">
          <div className="ml-auto h-10 w-2/5 animate-pulse rounded-[20px] bg-raised" />
          <div className="h-3 w-1/3 animate-pulse rounded bg-hover" />
          <div className="h-3 w-full animate-pulse rounded bg-hover" />
          <div className="h-3 w-11/12 animate-pulse rounded bg-hover" />
          <div className="h-3 w-3/5 animate-pulse rounded bg-hover" />
        </div>
      ))}
    </div>
  );
}

function Empty({ title, body }: { title: string; body?: string }) {
  return (
    <div className="flex h-full items-center justify-center p-10">
      <div className="max-w-sm text-center">
        <p className="text-[14px] font-medium">{title}</p>
        {body && <p className="mt-1.5 text-[13px] text-muted">{body}</p>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

const RowView = memo(function RowView({ row, ctxBase, highlight, showInjected, fromAgent }: { row: Row; ctxBase: Omit<BlockCtx, 'seq'>; highlight: boolean; showInjected: boolean; fromAgent: boolean }) {
  switch (row.kind) {
    case 'date':
      return (
        <div className="flex justify-center pt-7 pb-3">
          <span className="text-[11.5px] font-medium text-faint tabular-nums" title={fullDate(row.timestamp)}>
            {separatorDate(row.timestamp)}
          </span>
        </div>
      );
    case 'prompt':
      return <Prompt event={row.event} ctx={{ ...ctxBase, seq: row.event.seq }} highlight={highlight} showInjected={showInjected} fromAgent={fromAgent} />;
    case 'reply':
      return <Reply event={row.event} ctx={{ ...ctxBase, seq: row.event.seq }} highlight={highlight} endOfTurn={!!row.endOfTurn} />;
    case 'divider': {
      const text = row.event.blocks.map((b) => (b.type === 'notice' ? b.text : '')).join(' ');
      return (
        <div className="flex items-center gap-3 py-5 text-[11.5px] text-faint">
          <span className="h-px flex-1 bg-line" />
          <span className={`max-w-[75%] truncate ${highlight ? 'text-ink' : ''}`} title={text}>
            {text}
            {row.event.timestamp ? ` · ${time(row.event.timestamp)}` : ''}
          </span>
          <span className="h-px flex-1 bg-line" />
        </div>
      );
    }
    case 'activity':
      return <Activity row={row} ctxBase={ctxBase} defaultOpen={highlight} />;
  }
});

function highlightCls(on: boolean) {
  return on ? 'rounded-2xl bg-mark-soft/60 -mx-3 px-3 sm:-mx-4 sm:px-4' : '';
}

/* ---------------- prompts ---------------- */

const PASTE_RE = /<pasted_content(?:\s+id="[^"]*")?>\n?([\s\S]*?)\n?<\/pasted_content(?:\s+id="[^"]*")?>/g;

/** Split a prompt's text into what was typed and what was pasted. */
function splitPasted(text: string): { kind: 'typed' | 'pasted'; text: string }[] {
  const out: { kind: 'typed' | 'pasted'; text: string }[] = [];
  let last = 0;
  for (const m of text.matchAll(PASTE_RE)) {
    const before = text.slice(last, m.index).trim();
    if (before) out.push({ kind: 'typed', text: before });
    out.push({ kind: 'pasted', text: m[1] ?? '' });
    last = m.index + m[0].length;
  }
  // A paste cut off by transport truncation has no closing tag.
  const rest = text.slice(last);
  const open = rest.search(/<pasted_content(?:\s+id="[^"]*")?>/);
  if (open >= 0) {
    const before = rest.slice(0, open).trim();
    if (before) out.push({ kind: 'typed', text: before });
    out.push({ kind: 'pasted', text: rest.slice(open).replace(/^<pasted_content[^>]*>\n?/, '') });
  } else if (rest.trim()) out.push({ kind: 'typed', text: rest.trim() });
  return out;
}

function PastedText({ text, truncated }: { text: string; truncated?: { fullLength: number } }) {
  const [open, setOpen] = useState(false);
  const lines = text.split('\n').length;
  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="inline-flex max-w-full items-center gap-2 rounded-xl bg-canvas/70 px-2.5 py-1.5 text-left text-[12px] ring-1 ring-line transition-colors hover:ring-line-strong dark:bg-black/15"
      >
        <ClipboardPaste size={14} className="shrink-0 text-muted" />
        <span className="font-medium">Pasted text</span>
        <span className="text-faint">{truncated ? `${bytes(truncated.fullLength)} in total` : `${plural(lines, 'line')} · ${bytes(text.length)}`}</span>
        <ChevronRight size={13} className={`shrink-0 text-faint transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className="scroll-quiet mt-2 max-h-[28rem] overflow-y-auto rounded-xl bg-canvas/70 px-3.5 py-3 ring-1 ring-line dark:bg-black/15 [&_.prose-msg]:text-[13px]">
          <Markdown text={text} />
          {truncated && <p className="mt-2 text-[12px] text-faint">Showing the first part. Export the chat to read the whole paste.</p>}
        </div>
      )}
    </div>
  );
}

const CLAMP_LINES = 12;
const CLAMP_CHARS = 1100;

function TypedText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > CLAMP_CHARS || text.split('\n').length > CLAMP_LINES;
  return (
    <div>
      <div className={`whitespace-pre-wrap ${long && !open ? 'fade-bottom max-h-[300px] overflow-hidden' : ''}`}>{text}</div>
      {long && (
        <button type="button" onClick={() => setOpen((o) => !o)} className="mt-1 text-[12.5px] font-medium text-muted hover:text-ink">
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

function FullPrompt({ ctx }: { ctx: BlockCtx }) {
  const q = useQuery({ queryKey: ['event', ctx.sessionId, ctx.seq], queryFn: () => api.event(ctx.sessionId, ctx.seq) });
  if (!q.data) return <span className="text-[12.5px] text-faint">Loading…</span>;
  return <PromptText blocks={q.data.blocks} />;
}

function PromptText({ blocks, ctx }: { blocks: Block[]; ctx?: BlockCtx }) {
  const [full, setFull] = useState(false);
  if (full && ctx) return <FullPrompt ctx={ctx} />;
  return (
    <>
      {blocks.map((b, i) => {
        if (b.type !== 'text' || !b.text.trim()) return null;
        return (
          <div key={i} className="space-y-1">
            {splitPasted(b.text).map((part, j) => (part.kind === 'pasted' ? <PastedText key={j} text={part.text} truncated={b.truncated} /> : <TypedText key={j} text={part.text} />))}
            {b.truncated && !b.text.includes('<pasted_content') && ctx && (
              <button type="button" onClick={() => setFull(true)} className="text-[12.5px] font-medium text-muted hover:text-ink">
                Show the full text ({bytes(b.truncated.fullLength)})
              </button>
            )}
          </div>
        );
      })}
    </>
  );
}

function promptCopyText(blocks: Block[]) {
  return blocks
    .filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text.replace(PASTE_RE, (_m, inner: string) => inner))
    .join('\n\n');
}

function Prompt({ event, ctx, highlight, showInjected, fromAgent }: { event: ChatEvent; ctx: BlockCtx; highlight: boolean; showInjected: boolean; fromAgent: boolean }) {
  const images = event.blocks.filter((b) => b.type === 'image' || b.type === 'document');
  const injected = event.blocks.filter((b) => b.type === 'notice' && b.kind === 'injected');
  const other = event.blocks.filter((b) => b.type !== 'text' && b.type !== 'image' && b.type !== 'document' && !(b.type === 'notice' && b.kind === 'injected'));
  const hasText = event.blocks.some((b) => b.type === 'text' && b.text.trim());
  return (
    <div id={`seq-${event.seq}`} className={`group/msg flex flex-col items-end pt-4 pb-1 ${event.offBranch ? 'opacity-55' : ''} ${highlightCls(highlight)}`}>
      {event.offBranch && <OffBranch />}
      {fromAgent && <div className="mb-1.5 text-[11px] font-medium text-faint">Instructions from the main agent</div>}
      {images.length > 0 && (
        <div className="mb-2 flex max-w-[85%] flex-wrap justify-end gap-2">
          {images.map((b, i) => (b.type === 'image' ? <ImageView key={i} block={b} ctx={ctx} small /> : <BlockView key={i} block={b} ctx={ctx} />))}
        </div>
      )}
      {hasText && (
        <div className="max-w-[min(85%,620px)] min-w-0 rounded-[20px] bg-raised px-4 py-2.5 text-[14px] leading-[1.6] text-ink [overflow-wrap:anywhere]">
          <PromptText blocks={event.blocks} ctx={ctx} />
        </div>
      )}
      {other.length > 0 && (
        <div className="mt-2 flex max-w-[85%] flex-col items-end gap-1.5">
          {other.map((b, i) => (
            <BlockView key={i} block={b} ctx={ctx} />
          ))}
        </div>
      )}
      {showInjected &&
        injected.map((b, i) => (
          <div key={i} className="mt-2 w-full max-w-[85%]">
            <Disclosure summary={<span className="text-[12px]">Context the app added to this message</span>}>
              {() => <pre className="code-block max-h-80 overflow-auto whitespace-pre-wrap">{b.type === 'notice' ? b.text : ''}</pre>}
            </Disclosure>
          </div>
        ))}
      <div className="reveal mt-1 flex h-7 items-center gap-0.5 text-[11px] text-faint">
        <span className="px-1 tabular-nums" title={fullDate(event.timestamp)}>
          {time(event.timestamp)}
        </span>
        {hasText && <CopyButton text={() => promptCopyText(event.blocks)} label="Copy message" />}
      </div>
    </div>
  );
}

function OffBranch() {
  return (
    <div className="mb-1.5 inline-flex items-center gap-1 text-[11px] text-faint">
      <GitBranch size={12} /> Earlier version, replaced by an edit or retry
    </div>
  );
}

/* ---------------- replies ---------------- */

function Reply({ event, ctx, highlight, endOfTurn }: { event: ChatEvent; ctx: BlockCtx; highlight: boolean; endOfTurn: boolean }) {
  const text = event.blocks
    .filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n\n');
  return (
    <div className={`group/msg py-2.5 ${event.offBranch ? 'opacity-55' : ''} ${highlightCls(highlight)}`}>
      {event.offBranch && <OffBranch />}
      <div className="space-y-3">
        {event.blocks.map((b, i) => (
          <BlockView key={i} block={b} ctx={ctx} />
        ))}
      </div>
      {endOfTurn && (
        <div className="reveal mt-1.5 -ml-1.5 flex h-7 items-center gap-0.5 text-[11px] text-faint">
          {text && <CopyButton text={text} label="Copy reply" />}
          <span className="px-1 tabular-nums" title={fullDate(event.timestamp)}>
            {time(event.timestamp)}
          </span>
          {event.model && <span className="px-1">· {event.model}</span>}
        </div>
      )}
    </div>
  );
}

/* ---------------- agent work ---------------- */

function Activity({ row, ctxBase, defaultOpen }: { row: Extract<Row, { kind: 'activity' }>; ctxBase: Omit<BlockCtx, 'seq'>; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const s = useMemo(() => summarize(row.events, row.results), [row.events, row.results]);
  const firstTool = useMemo(() => {
    for (const e of row.events) for (const b of e.blocks) if (b.type === 'tool_use') return b.name;
    return undefined;
  }, [row.events]);
  const Icon = firstTool ? kindIcon(firstTool) : Brain;
  const onlyMeta = s.calls === 0 && s.thinking === 0;
  const dur = !onlyMeta && row.durationMs != null && row.durationMs >= 2000 ? duration(row.durationMs) : undefined;

  return (
    <div className="py-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={`group -mx-2 flex max-w-[calc(100%+16px)] min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-left text-[13px] transition-colors hover:bg-hover ${onlyMeta ? 'text-faint' : 'text-muted'} hover:text-ink`}
      >
        <Icon size={14} className="shrink-0 opacity-80" strokeWidth={1.9} />
        <span className="min-w-0 truncate">{sentence(s.phrases)}</span>
        {(s.added > 0 || s.removed > 0) && (
          <span className="shrink-0 font-mono text-[11.5px] tabular-nums">
            {s.added > 0 && <span className="text-ok">+{s.added}</span>}
            {s.added > 0 && s.removed > 0 && ' '}
            {s.removed > 0 && <span className="text-error">−{s.removed}</span>}
          </span>
        )}
        {s.errors > 0 && <span className="shrink-0 text-error">· {s.errors} failed</span>}
        {s.images > 0 && (
          <span className="inline-flex shrink-0 items-center gap-1 text-faint">
            · <Images size={13} /> {s.images}
          </span>
        )}
        {dur && <span className="shrink-0 text-faint tabular-nums">· {dur}</span>}
        <ChevronRight size={14} className={`shrink-0 text-faint transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className="mt-1.5 mb-2 overflow-hidden rounded-xl border border-line">
          {row.events.map((e) =>
            e.blocks
              .filter((b) => !((b.type === 'thinking' || b.type === 'text') && !b.text.trim()))
              .map((b, i) => {
                const padded = b.type !== 'tool_use' && b.type !== 'thinking' && b.type !== 'tool_result';
                return (
                  <div key={`${e.seq}-${i}`} className={`border-b border-line last:border-b-0 ${e.visibility === 'meta' ? 'bg-hover/50' : ''}`}>
                    <div className={padded ? 'px-3 py-2.5 [&_.prose-msg]:text-[13px]' : ''}>
                      <BlockView block={b} ctx={{ ...ctxBase, seq: e.seq, results: row.results }} />
                    </div>
                  </div>
                );
              }),
          )}
        </div>
      )}
    </div>
  );
}

