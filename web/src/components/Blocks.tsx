import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ChevronRight, FileText, Info, Brain, Bot, ImageOff, Maximize2, Braces } from 'lucide-react';
import { api, type Block, type ImageBlock, type ToolResultBlock, type ToolUseBlock } from '../api.ts';
import { bytes, toolName, toolSummary } from '../format.ts';
import { CodeBlock, Markdown } from './Markdown.tsx';
import { useLightbox } from './Lightbox.tsx';

export interface BlockCtx {
  sessionId: string;
  seq: number;
  /** tool_use id → result, so a call can show its result inline */
  results?: Map<string, ToolResultBlock>;
  onOpenSubSession?: (id: string) => void;
}

/* ------------------------------------------------------------------ */

export function Disclosure({
  summary,
  children,
  defaultOpen = false,
  tone = 'default',
}: {
  summary: ReactNode;
  children: () => ReactNode;
  defaultOpen?: boolean;
  tone?: 'default' | 'error';
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={`group flex w-full min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left text-[13px] hover:bg-sunken ${tone === 'error' ? 'text-error' : 'text-muted'}`}
      >
        <ChevronRight size={14} className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
        <span className="min-w-0 flex-1 truncate">{summary}</span>
      </button>
      {open && <div className="mt-1 mb-2 ml-5">{children()}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function TruncatedNote({ ctx, full }: { ctx: BlockCtx; full: number }) {
  const [show, setShow] = useState(false);
  const q = useQuery({ queryKey: ['event', ctx.sessionId, ctx.seq], queryFn: () => api.event(ctx.sessionId, ctx.seq), enabled: show });
  if (show && q.data) {
    const text = q.data.blocks
      .filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n\n');
    return <Markdown text={text} />;
  }
  return (
    <button type="button" onClick={() => setShow(true)} className="mt-2 text-[13px] text-prompt hover:underline">
      {q.isFetching ? 'Loading…' : `Show the full text (${bytes(full)})`}
    </button>
  );
}

export function TextView({ text, truncated, ctx }: { text: string; truncated?: { fullLength: number }; ctx: BlockCtx }) {
  const [showAll, setShowAll] = useState(false);
  if (showAll && truncated) return <TruncatedNote ctx={ctx} full={truncated.fullLength} />;
  return (
    <>
      <Markdown text={text} />
      {truncated && (
        <button type="button" onClick={() => setShowAll(true)} className="mt-2 text-[13px] text-prompt hover:underline">
          Show the full text ({bytes(truncated.fullLength)})
        </button>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */

export function ImageView({ block, ctx }: { block: ImageBlock; ctx: BlockCtx }) {
  const [failed, setFailed] = useState(false);
  const lightbox = useLightbox();
  const src = block.blobPath ? api.blobUrl(ctx.sessionId, ctx.seq, block.blobPath) : undefined;
  if (!src || failed)
    return (
      <div className="flex h-24 w-40 flex-col items-center justify-center gap-1 rounded-md border border-dashed border-rule text-xs text-faint">
        <ImageOff size={18} />
        {block.filePath ? 'Image file missing' : 'Image unavailable'}
      </div>
    );
  return (
    <button
      type="button"
      onClick={() => lightbox(src)}
      className="group relative block h-48 max-w-full overflow-hidden rounded-md border border-rule bg-sunken"
      title={`${block.mediaType}, ${bytes(block.size)}`}
    >
      <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} className="h-full w-auto max-w-full object-contain" />
      <span className="absolute right-1.5 bottom-1.5 rounded bg-ink/70 p-1 text-paper opacity-0 group-hover:opacity-100">
        <Maximize2 size={12} />
      </span>
    </button>
  );
}

/* ------------------------------------------------------------------ */

function FileRefView({ block }: { block: Extract<Block, { type: 'file_ref' }> }) {
  const [open, setOpen] = useState(false);
  const canOpen = block.role === 'tool_output' && block.exists !== false;
  const q = useQuery({ queryKey: ['file', block.path], queryFn: () => api.file(block.path), enabled: open });
  const label = block.label ?? block.path.split('/').at(-1);
  return (
    <div className="text-[13px]">
      <span className="inline-flex max-w-full items-center gap-1.5 rounded border border-rule bg-surface px-2 py-0.5 text-muted" title={block.path}>
        <FileText size={13} className="shrink-0" />
        <span className="truncate">{label}</span>
        {block.exists === false && <span className="text-faint">(no longer on disk)</span>}
        {canOpen && (
          <button type="button" className="ml-1 text-prompt hover:underline" onClick={() => setOpen((o) => !o)}>
            {open ? 'Hide' : 'Open'}
          </button>
        )}
      </span>
      {block.snippet && !open && <pre className="code-block mt-1 max-h-48 overflow-auto">{block.snippet}</pre>}
      {open && (
        <div className="mt-1">
          {q.isLoading && <span className="text-faint">Loading…</span>}
          {q.error && <span className="text-error">{(q.error as Error).message}</span>}
          {q.data != null && <pre className="code-block max-h-[32rem] overflow-auto whitespace-pre-wrap">{q.data}</pre>}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function resultText(r: ToolResultBlock): string {
  return r.content
    .filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

export function ToolResultView({ block, ctx }: { block: ToolResultBlock; ctx: BlockCtx }) {
  const text = resultText(block);
  const others = block.content.filter((b) => b.type !== 'text');
  return (
    <div className="space-y-2">
      {text && (
        <pre className={`code-block max-h-[28rem] overflow-auto whitespace-pre-wrap ${block.isError ? 'border-error/40 text-error' : ''}`}>{text}</pre>
      )}
      {others.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {others.map((b, i) => (
            <BlockView key={i} block={b} ctx={ctx} />
          ))}
        </div>
      )}
      {!text && others.length === 0 && <span className="text-[13px] text-faint">No output</span>}
    </div>
  );
}

export function ToolUseView({ block, ctx }: { block: ToolUseBlock; ctx: BlockCtx }) {
  const result = ctx.results?.get(block.id);
  const summary = toolSummary(block.name, block.input);
  return (
    <Disclosure
      tone={result?.isError ? 'error' : 'default'}
      summary={
        <>
          <span className="font-medium text-ink" title={block.name}>{toolName(block.name).name}</span>
          {toolName(block.name).server && <span className="ml-1.5 text-faint">{toolName(block.name).server}</span>}
          {summary && summary !== block.name && <span className="ml-2 font-mono text-[12px]">{summary}</span>}
          {result?.isError && <span className="ml-2">failed</span>}
        </>
      }
    >
      {() => (
        <div className="space-y-2">
          {block.subSessionId && ctx.onOpenSubSession && (
            <button
              type="button"
              onClick={() => ctx.onOpenSubSession!(block.subSessionId!)}
              className="inline-flex items-center gap-1.5 rounded border border-prompt/40 bg-prompt-soft px-2 py-1 text-[13px] text-prompt hover:border-prompt"
            >
              <Bot size={14} /> Open this agent's run
            </button>
          )}
          <CodeBlock code={typeof block.input === 'string' ? block.input : JSON.stringify(block.input, null, 2)} lang="json" />
          {result && <ToolResultView block={result} ctx={ctx} />}
        </div>
      )}
    </Disclosure>
  );
}

/* ------------------------------------------------------------------ */

export function BlockView({ block, ctx }: { block: Block; ctx: BlockCtx }): ReactNode {
  switch (block.type) {
    case 'text':
      return <TextView text={block.text} truncated={block.truncated} ctx={ctx} />;
    case 'thinking':
      // Thinking that wasn't saved in readable form (signature-only or encrypted): nothing to show.
      if (!block.text.trim()) return null;
      return (
        <Disclosure summary={<span className="inline-flex items-center gap-1.5"><Brain size={14} /> Thinking <span className="text-faint">{block.text.split(/\s+/).slice(0, 14).join(' ')}…</span></span>}>
          {() => <TextView text={block.text} truncated={block.truncated} ctx={ctx} />}
        </Disclosure>
      );
    case 'tool_use':
      return <ToolUseView block={block} ctx={ctx} />;
    case 'tool_result':
      return (
        <Disclosure tone={block.isError ? 'error' : 'default'} summary={block.isError ? 'Tool error' : 'Tool result'}>
          {() => <ToolResultView block={block} ctx={ctx} />}
        </Disclosure>
      );
    case 'image':
      return <ImageView block={block} ctx={ctx} />;
    case 'document':
      return (
        <a
          href={block.blobPath ? api.blobUrl(ctx.sessionId, ctx.seq, block.blobPath) : undefined}
          target="_blank"
          rel="noopener"
          className="inline-flex items-center gap-1.5 rounded border border-rule bg-surface px-2 py-1 text-[13px] text-muted hover:text-ink"
        >
          <FileText size={14} /> {block.title ?? 'Document'} <span className="text-faint">{block.mediaType}, {bytes(block.size)}</span>
        </a>
      );
    case 'file_ref':
      return <FileRefView block={block} />;
    case 'notice': {
      const Icon = block.level === 'info' ? Info : AlertTriangle;
      const color = block.level === 'error' ? 'text-error' : block.level === 'warning' ? 'text-warn' : 'text-muted';
      return (
        <div className={`flex items-start gap-1.5 px-1 text-[13px] ${color}`}>
          <Icon size={14} className="mt-0.5 shrink-0" />
          <span className="min-w-0 whitespace-pre-wrap">{block.text}</span>
        </div>
      );
    }
    case 'raw':
      return (
        <Disclosure summary={<span className="inline-flex items-center gap-1.5"><Braces size={14} /> {block.recordType}</span>}>
          {() => <CodeBlock code={JSON.stringify(block.json, null, 2)} lang="json" />}
        </Disclosure>
      );
    default:
      return null;
  }
}
