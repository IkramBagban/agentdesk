import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDownToLine, ArrowUpToLine, GitBranch, Images, Wrench } from 'lucide-react';
import { api, type ChatEvent, type View } from '../api.ts';
import { navigate } from '../router.ts';
import { fullDate, time } from '../format.ts';
import { activitySummary, buildRows, type Row } from './rows.ts';
import { BlockView, type BlockCtx } from './Blocks.tsx';

const PAGE = 120;
const END = 2 ** 31 - 1;

type Param = { from: number; dir: 'forward' | 'backward' };

export function Conversation({ sessionId, view, seq, onScrollToPrompt }: { sessionId: string; view: View; seq?: number; onScrollToPrompt?: (fn: (seq: number) => void) => void }) {
  const initial: Param = seq != null ? { from: Math.max(0, seq - 6), dir: 'forward' } : { from: 0, dir: 'forward' };
  const [anchor, setAnchor] = useState<Param>(initial);
  // Reset when the session/jump target changes.
  useEffect(() => setAnchor(initial), [sessionId, seq, view]); // eslint-disable-line react-hooks/exhaustive-deps

  const q = useInfiniteQuery({
    queryKey: ['events', sessionId, view, anchor.from, anchor.dir],
    initialPageParam: anchor,
    queryFn: ({ pageParam }) => api.events(sessionId, { from: pageParam.from, view, limit: PAGE, dir: pageParam.dir }),
    getNextPageParam: (last): Param | undefined => (last.nextFrom != null ? { from: last.nextFrom, dir: 'forward' } : undefined),
    getPreviousPageParam: (first): Param | undefined => (first.prevFrom != null ? { from: first.prevFrom, dir: 'backward' } : undefined),
    staleTime: 30_000,
  });

  const events = useMemo(() => {
    const seen = new Set<number>();
    const out: ChatEvent[] = [];
    for (const p of q.data?.pages ?? []) for (const e of p.items) if (!seen.has(e.seq)) (seen.add(e.seq), out.push(e));
    return out.sort((a, b) => a.seq - b.seq);
  }, [q.data]);
  const rows = useMemo(() => buildRows(events), [events]);
  const total = q.data?.pages[0]?.total;

  const scrollRef = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 140,
    overscan: 6,
    getItemKey: (i) => rows[i]!.key,
  });

  // Keep the reader's place when older rows are prepended.
  const firstKey = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const prev = firstKey.current;
    firstKey.current = rows[0]?.key;
    if (!prev || prev === rows[0]?.key) return;
    const idx = rows.findIndex((r) => r.key === prev);
    if (idx > 0) v.scrollToIndex(idx, { align: 'start' });
  }, [rows, v]);

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

  // Load more at either edge.
  const items = v.getVirtualItems();
  useEffect(() => {
    const first = items[0];
    const last = items.at(-1);
    if (!first || !last) return;
    if (last.index >= rows.length - 3 && q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage();
    if (first.index <= 2 && q.hasPreviousPage && !q.isFetchingPreviousPage) void q.fetchPreviousPage();
  }, [items, rows.length, q]);

  // Let the outline spine scroll us.
  useEffect(() => {
    onScrollToPrompt?.((target) => {
      const idx = rows.findIndex((r) => rowSeqs(r).includes(target));
      if (idx >= 0) v.scrollToIndex(idx, { align: 'start', behavior: 'smooth' });
      else navigate({ seq: target }, { replace: true });
    });
  }, [rows, v, onScrollToPrompt]);

  // j / k move between prompts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.metaKey || e.ctrlKey) return;
      if (e.key !== 'j' && e.key !== 'k') return;
      const top = v.getVirtualItems()[0]?.index ?? 0;
      const step = e.key === 'j' ? 1 : -1;
      for (let i = top + step; i >= 0 && i < rows.length; i += step) {
        if (rows[i]!.kind === 'prompt') return v.scrollToIndex(i, { align: 'start' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rows, v]);

  if (q.isError) return <Empty title="This chat couldn't be loaded" body={(q.error as Error).message} />;
  if (q.isLoading) return <div className="p-10 text-muted">Loading chat…</div>;
  if (!rows.length) return <Empty title="Nothing to show in this view" body={view === 'conversation' ? 'Switch to "Everything" to see tool calls and background records.' : 'This chat file has no readable records.'} />;

  const ctxBase = { sessionId, onOpenSubSession: (id: string) => navigate({ sessionId: id, seq: undefined }) };

  return (
    <div ref={scrollRef} className="scrollbar-thin relative h-full overflow-y-auto" data-testid="conversation">
      <div style={{ height: v.getTotalSize(), position: 'relative' }}>
        {items.map((it) => {
          const row = rows[it.index]!;
          return (
            <div key={it.key} data-index={it.index} ref={v.measureElement} className="absolute top-0 left-0 w-full" style={{ transform: `translateY(${it.start}px)` }}>
              <div className="mx-auto max-w-[46rem] px-5 sm:px-8">
                <RowView row={row} ctxBase={ctxBase} highlight={seq != null && rowSeqs(row).includes(seq)} />
              </div>
            </div>
          );
        })}
      </div>
      <div className="pointer-events-none sticky bottom-4 flex justify-end gap-2 pr-4">
        {q.hasPreviousPage || anchor.from > 0 ? (
          <EdgeButton label="Jump to start" onClick={() => (navigate({ seq: undefined }, { replace: true }), setAnchor({ from: 0, dir: 'forward' }))} icon={<ArrowUpToLine size={15} />} />
        ) : null}
        {q.hasNextPage || (total != null && total > PAGE) ? (
          <EdgeButton label="Jump to end" onClick={() => (navigate({ seq: undefined }, { replace: true }), setAnchor({ from: END, dir: 'backward' }))} icon={<ArrowDownToLine size={15} />} />
        ) : null}
      </div>
    </div>
  );
}

function EdgeButton({ label, onClick, icon }: { label: string; onClick: () => void; icon: React.ReactNode }) {
  return (
    <button type="button" title={label} aria-label={label} onClick={onClick} className="pointer-events-auto rounded-full border border-rule bg-surface p-2 text-muted shadow-sm hover:text-ink">
      {icon}
    </button>
  );
}

function rowSeqs(r: Row): number[] {
  return r.kind === 'activity' ? r.events.map((e) => e.seq) : [r.event.seq];
}

function Empty({ title, body }: { title: string; body?: string }) {
  return (
    <div className="flex h-full items-center justify-center p-10">
      <div className="max-w-sm text-center">
        <p className="font-medium">{title}</p>
        {body && <p className="mt-1 text-muted">{body}</p>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

const RowView = memo(function RowView({ row, ctxBase, highlight }: { row: Row; ctxBase: Omit<BlockCtx, 'seq'>; highlight: boolean }) {
  const hl = highlight ? 'rounded-lg ring-2 ring-mark ring-offset-4 ring-offset-paper' : '';
  switch (row.kind) {
    case 'prompt':
      return <Prompt event={row.event} ctx={{ ...ctxBase, seq: row.event.seq }} className={hl} />;
    case 'reply':
      return (
        <div className={`pt-3 pb-4 ${row.event.offBranch ? 'opacity-55' : ''} ${hl}`}>
          {row.event.offBranch && <OffBranch />}
          <div className="space-y-3">
            {row.event.blocks.map((b, i) => (
              <BlockView key={i} block={b} ctx={{ ...ctxBase, seq: row.event.seq, results: row.results }} />
            ))}
          </div>
        </div>
      );
    case 'divider':
      return (
        <div className={`my-6 flex items-center gap-3 text-[12px] text-faint ${hl}`}>
          <span className="h-px flex-1 bg-rule" />
          <span className="max-w-[70%] truncate" title={row.event.blocks.map((b) => (b.type === 'notice' ? b.text : '')).join(' ')}>
            {row.event.blocks.map((b) => (b.type === 'notice' ? b.text : '')).join(' ')} {time(row.event.timestamp)}
          </span>
          <span className="h-px flex-1 bg-rule" />
        </div>
      );
    case 'activity':
      return <Activity row={row} ctxBase={ctxBase} className={hl} />;
  }
});

function Prompt({ event, ctx, className }: { event: ChatEvent; ctx: BlockCtx; className: string }) {
  return (
    <div id={`seq-${event.seq}`} className={`pt-8 pb-3 ${event.offBranch ? 'opacity-55' : ''} ${className}`}>
      {event.offBranch && <OffBranch />}
      <div className="relative border-l-[3px] border-prompt pl-4">
        <div className="mb-1 text-[12px] text-faint" title={fullDate(event.timestamp)}>
          You · {time(event.timestamp)}
        </div>
        <div className="space-y-3 font-sans text-[16.5px] leading-relaxed font-[520] text-prompt [&_.prose-msg]:font-sans [&_.prose-msg]:text-[16.5px]">
          {event.blocks.map((b, i) => (
            <BlockView key={i} block={b} ctx={ctx} />
          ))}
        </div>
      </div>
    </div>
  );
}

function OffBranch() {
  return (
    <div className="mb-1 inline-flex items-center gap-1 text-[12px] text-faint">
      <GitBranch size={12} /> Earlier version, replaced by an edit or retry
    </div>
  );
}

function Activity({ row, ctxBase, className }: { row: Extract<Row, { kind: 'activity' }>; ctxBase: Omit<BlockCtx, 'seq'>; className: string }) {
  const [open, setOpen] = useState(false);
  const s = useMemo(() => activitySummary(row.events), [row.events]);
  const toolCount = [...s.tools.values()].reduce((a, b) => a + b, 0);
  const parts: string[] = [];
  if (toolCount) {
    const names = [...s.tools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, c]) => (c > 1 ? `${n} ×${c}` : n));
    parts.push(`${toolCount} tool ${toolCount === 1 ? 'call' : 'calls'}: ${names.join(', ')}${s.tools.size > 3 ? ', …' : ''}`);
  }
  if (s.thinking) parts.push('thinking');
  if (s.meta && !toolCount && !s.thinking) parts.push(`${s.meta} background ${s.meta === 1 ? 'record' : 'records'}`);
  if (!parts.length) parts.push(`${row.events.length} ${row.events.length === 1 ? 'item' : 'items'}`);

  // A tool_use's result is shown under the call; don't render it twice.
  const pairedIds = new Set<string>();
  for (const e of row.events) for (const b of e.blocks) if (b.type === 'tool_use' && row.results.has(b.id)) pairedIds.add(b.id);

  return (
    <div className={`py-1 ${className}`}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] text-muted hover:bg-sunken">
        <Wrench size={13} className="shrink-0 text-faint" />
        <span className="min-w-0 flex-1 truncate">{parts.join(' · ')}</span>
        {s.errors > 0 && <span className="shrink-0 text-error">{s.errors} failed</span>}
        {s.images > 0 && (
          <span className="inline-flex shrink-0 items-center gap-1 text-faint">
            <Images size={13} /> {s.images}
          </span>
        )}
      </button>
      {open && (
        <div className="mt-1 ml-3 space-y-1 border-l border-rule pl-3">
          {row.events.map((e) =>
            e.blocks
              .filter((b) => !(b.type === 'tool_result' && pairedIds.has(b.toolUseId)))
              .map((b, i) => (
                <div key={`${e.seq}-${i}`} className={e.visibility === 'meta' ? 'opacity-75' : ''}>
                  <BlockView block={b} ctx={{ ...ctxBase, seq: e.seq, results: row.results }} />
                </div>
              )),
          )}
        </div>
      )}
    </div>
  );
}
