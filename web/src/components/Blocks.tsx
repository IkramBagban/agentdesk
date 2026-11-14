import { useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  AppWindow,
  Bot,
  Braces,
  Brain,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleDashed,
  FilePen,
  FilePlus,
  FileSearch,
  FileText,
  Globe,
  ImageOff,
  Info,
  ListChecks,
  Maximize2,
  MessageCircleQuestionMark,
  Plug,
  SquareTerminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { api, type Block, type ImageBlock, type ToolResultBlock, type ToolUseBlock } from '../api.ts';
import { basename, bytes, tildify, toolName } from '../format.ts';
import { commandOf, describeCall, diffLines, editsOf, filePathOf, langOf, lineStats, patchOf, serverLabel, toolKind, type ToolKind } from '../tools.ts';
import { CodeBlock, Markdown } from './Markdown.tsx';
import { useLightbox } from './Lightbox.tsx';
import { CopyButton } from './ui.tsx';

export interface BlockCtx {
  sessionId: string;
  seq: number;
  /** tool_use id → result, so a call can show its result inline */
  results?: Map<string, ToolResultBlock>;
  onOpenSubSession?: (id: string) => void;
}

/* ------------------------------------------------------------------ */

export function Disclosure({ summary, children, defaultOpen = false, tone = 'default', icon }: { summary: ReactNode; children: () => ReactNode; defaultOpen?: boolean; tone?: 'default' | 'error'; icon?: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={`group inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-md py-0.5 text-left text-[13.5px] transition-colors ${tone === 'error' ? 'text-error' : 'text-muted hover:text-ink'}`}
      >
        {icon}
        <span className="min-w-0 truncate">{summary}</span>
        <ChevronRight size={14} className={`shrink-0 text-faint transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && <div className="mt-1.5 mb-1">{children()}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function FullText({ ctx, full }: { ctx: BlockCtx; full: number }) {
  const q = useQuery({ queryKey: ['event', ctx.sessionId, ctx.seq], queryFn: () => api.event(ctx.sessionId, ctx.seq) });
  if (q.data) {
    const text = q.data.blocks
      .filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n\n');
    return <Markdown text={text} />;
  }
  return <p className="text-[13px] text-faint">{q.isError ? (q.error as Error).message : `Loading ${bytes(full)}…`}</p>;
}

export function TextView({ text, truncated, ctx }: { text: string; truncated?: { fullLength: number }; ctx: BlockCtx }) {
  const [showAll, setShowAll] = useState(false);
  if (showAll && truncated) return <FullText ctx={ctx} full={truncated.fullLength} />;
  return (
    <>
      <Markdown text={text} />
      {truncated && (
        <button type="button" onClick={() => setShowAll(true)} className="mt-2 text-[13px] font-medium text-accent hover:underline">
          Show the full text ({bytes(truncated.fullLength)})
        </button>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */

export function ImageView({ block, ctx, small = false }: { block: ImageBlock; ctx: BlockCtx; small?: boolean }) {
  const [failed, setFailed] = useState(false);
  const lightbox = useLightbox();
  const src = block.blobPath ? api.blobUrl(ctx.sessionId, ctx.seq, block.blobPath) : undefined;
  const h = small ? 'h-28' : 'h-56';
  if (!src || failed)
    return (
      <div className={`flex ${h} w-40 flex-col items-center justify-center gap-1.5 rounded-xl bg-raised text-[12px] text-faint`}>
        <ImageOff size={18} />
        {block.filePath ? 'Image file missing' : 'Image unavailable'}
      </div>
    );
  return (
    <button
      type="button"
      onClick={() => lightbox(src)}
      aria-label="Open image"
      className={`group relative block ${h} max-w-full overflow-hidden rounded-xl bg-raised ring-1 ring-line transition-shadow hover:ring-line-strong`}
      title={`${block.mediaType}, ${bytes(block.size)}`}
    >
      <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} className="h-full w-auto max-w-full object-contain" />
      <span className="absolute right-2 bottom-2 rounded-md bg-black/55 p-1 text-white opacity-0 backdrop-blur transition-opacity group-hover:opacity-100">
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
  const label = block.label ?? basename(block.path);
  return (
    <div className="text-[13px]">
      <span className="inline-flex max-w-full items-center gap-1.5 rounded-lg bg-raised px-2 py-1 text-muted" title={block.path}>
        <FileText size={13} className="shrink-0" />
        <span className="truncate">{label}</span>
        {block.exists === false && <span className="text-faint">· no longer on disk</span>}
        {canOpen && (
          <button type="button" className="ml-1 font-medium text-accent hover:underline" onClick={() => setOpen((o) => !o)}>
            {open ? 'Hide' : 'Open'}
          </button>
        )}
      </span>
      {block.snippet && !open && <pre className="code-block mt-1.5 max-h-48 overflow-auto">{block.snippet}</pre>}
      {open && (
        <div className="mt-1.5">
          {q.isLoading && <span className="text-faint">Loading…</span>}
          {q.error && <span className="text-error">{(q.error as Error).message}</span>}
          {q.data != null && <pre className="code-block max-h-[32rem] overflow-auto whitespace-pre-wrap">{q.data}</pre>}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

export function resultText(r: ToolResultBlock): string {
  return r.content
    .filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

const OUTPUT_PREVIEW_LINES = 14;

/** Plain output text, clipped with a "show all" toggle. */
function Output({ text, error, prompt }: { text: string; error?: boolean; prompt?: ReactNode }) {
  const [all, setAll] = useState(false);
  const lines = text.split('\n');
  const long = lines.length > OUTPUT_PREVIEW_LINES + 4;
  const shown = long && !all ? lines.slice(0, OUTPUT_PREVIEW_LINES).join('\n') : text;
  return (
    <div className={`code-block group/code relative !p-0 ${error ? '!border-error/30' : ''}`}>
      <div className="absolute top-1.5 right-1.5 opacity-0 transition-opacity group-hover/code:opacity-100 focus-within:opacity-100">
        <CopyButton text={text} label="Copy output" size={14} />
      </div>
      {prompt && <div className="border-b border-line px-3.5 py-2.5 pr-10">{prompt}</div>}
      {text ? (
        <pre className={`max-h-[30rem] overflow-auto px-3.5 py-2.5 pr-10 whitespace-pre-wrap ${error ? 'text-error' : 'text-muted'}`}>{shown}</pre>
      ) : (
        <div className="px-3.5 py-2 font-sans text-[12px] text-faint">No output</div>
      )}
      {long && (
        <button type="button" onClick={() => setAll((a) => !a)} className="w-full border-t border-line px-3.5 py-1.5 text-left font-sans text-[12px] font-medium text-muted hover:text-ink">
          {all ? 'Show less' : `Show all ${lines.length.toLocaleString()} lines`}
        </button>
      )}
    </div>
  );
}

function ResultExtras({ result, ctx }: { result: ToolResultBlock; ctx: BlockCtx }) {
  const others = result.content.filter((b) => b.type !== 'text');
  if (!others.length) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {others.map((b, i) => (b.type === 'image' ? <ImageView key={i} block={b} ctx={ctx} small /> : <BlockView key={i} block={b} ctx={ctx} />))}
    </div>
  );
}

export function ToolResultView({ block, ctx }: { block: ToolResultBlock; ctx: BlockCtx }) {
  const text = resultText(block);
  return (
    <div className="space-y-2">
      {(text || !block.content.length) && <Output text={text} error={block.isError} />}
      <ResultExtras result={block} ctx={ctx} />
    </div>
  );
}

/* ------------------------------------------------------------------ */

const KIND_ICON: Record<ToolKind, LucideIcon> = {
  command: SquareTerminal,
  read: FileText,
  edit: FilePen,
  write: FilePlus,
  search: FileSearch,
  web_search: Globe,
  fetch: Globe,
  agent: Bot,
  plan: ListChecks,
  browser: AppWindow,
  ask: MessageCircleQuestionMark,
  mcp: Plug,
  other: Wrench,
};

export function kindIcon(name: string): LucideIcon {
  return KIND_ICON[toolKind(name)];
}

function Stats({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="shrink-0 font-mono text-[11.5px] tabular-nums">
      {added > 0 && <span className="text-ok">+{added}</span>}
      {added > 0 && removed > 0 && ' '}
      {removed > 0 && <span className="text-error">−{removed}</span>}
    </span>
  );
}

/** One tool call inside an expanded activity panel. */
export function CallRow({ block, ctx }: { block: ToolUseBlock; ctx: BlockCtx }) {
  const [open, setOpen] = useState(false);
  const result = ctx.results?.get(block.id);
  const d = useMemo(() => describeCall(block), [block]);
  const st = useMemo(() => lineStats(block), [block]);
  const Icon = KIND_ICON[d.kind];
  const failed = result?.isError;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="group flex min-h-9 w-full min-w-0 items-center gap-2.5 px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-hover"
        title={block.name}
      >
        <Icon size={14} className={`shrink-0 ${failed ? 'text-error' : 'text-faint'}`} strokeWidth={1.9} />
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
          {d.title && d.kind === 'command' ? (
            <span className="truncate text-ink/90">{d.title}</span>
          ) : (
            <>
              <span className="shrink-0 text-muted">{d.verb}</span>
              {d.target && <span className={`truncate text-ink/90 ${d.mono ? 'font-mono text-[12px]' : ''}`}>{d.target}</span>}
              {d.title && <span className="shrink-0 truncate text-[12px] text-faint">· {d.title}</span>}
            </>
          )}
        </span>
        {st && <Stats {...st} />}
        {failed && <span className="shrink-0 rounded-md bg-error-soft px-1.5 py-px text-[11px] font-medium text-error">Failed</span>}
        {!result && ctx.results && <span className="shrink-0 text-[11px] text-faint">no result</span>}
        <ChevronRight size={14} className={`shrink-0 text-faint transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className="space-y-2 px-3 pt-0.5 pb-3">
          <CallDetail block={block} result={result} ctx={ctx} />
        </div>
      )}
    </div>
  );
}

function DiffView({ oldText, newText }: { oldText: string; newText: string }) {
  const lines = useMemo(() => diffLines(oldText, newText), [oldText, newText]);
  return <DiffLines lines={lines} />;
}

function DiffLines({ lines }: { lines: { op: ' ' | '+' | '-'; text: string }[] }) {
  return (
    <div className="code-block max-h-[30rem] overflow-auto !px-0 !py-1.5">
      {lines.map((l, i) => (
        <div
          key={i}
          className={`flex min-w-fit pr-3 ${l.op === '+' ? 'bg-[color-mix(in_srgb,var(--ok)_12%,transparent)]' : l.op === '-' ? 'bg-[color-mix(in_srgb,var(--error)_11%,transparent)]' : ''}`}
        >
          <span className={`w-7 shrink-0 text-center select-none ${l.op === '+' ? 'text-ok' : l.op === '-' ? 'text-error' : 'text-faint'}`}>{l.op === ' ' ? '' : l.op === '-' ? '−' : '+'}</span>
          <span className="whitespace-pre">{l.text || ' '}</span>
        </div>
      ))}
    </div>
  );
}

function patchLines(patch: string) {
  return patch
    .replace(/^\*\*\* (Begin|End) Patch\n?/gm, '')
    .replace(/\n$/, '')
    .split('\n')
    .map((t) => ({ op: (t.startsWith('+') && !t.startsWith('+++') ? '+' : t.startsWith('-') && !t.startsWith('---') ? '-' : ' ') as ' ' | '+' | '-', text: /^[+-](?![+-]{2})/.test(t) ? t.slice(1) : t }));
}

function PathLine({ path }: { path?: string }) {
  if (!path) return null;
  return (
    <div className="flex min-w-0 items-center gap-1 text-[12px] text-faint" title={path}>
      <span className="truncate font-mono">{tildify(path)}</span>
      <CopyButton text={path} label="Copy path" size={13} className="size-5 shrink-0" />
    </div>
  );
}

function asObj(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

function PlanList({ input }: { input: unknown }) {
  const o = asObj(input);
  const items = (Array.isArray(o.todos) ? o.todos : Array.isArray(o.items) ? o.items : Array.isArray(o.plan) ? o.plan : []) as unknown[];
  if (!items.length) return null;
  return (
    <ul className="space-y-1 rounded-xl bg-raised/60 px-3 py-2.5 text-[13px]">
      {items.map((it, i) => {
        const x = asObj(it);
        const status = String(x.status ?? '');
        const text = String(x.content ?? x.step ?? x.text ?? '');
        const Icon = status === 'completed' ? CircleCheck : status === 'in_progress' ? CircleDashed : Circle;
        return (
          <li key={i} className={`flex items-start gap-2 ${status === 'completed' ? 'text-muted' : ''}`}>
            <Icon size={14} className={`mt-[3px] shrink-0 ${status === 'completed' ? 'text-ok' : status === 'in_progress' ? 'text-accent' : 'text-faint'}`} />
            <span className={status === 'completed' ? 'line-through decoration-faint' : ''}>{text}</span>
          </li>
        );
      })}
    </ul>
  );
}

function JsonInput({ input }: { input: unknown }) {
  if (input == null || (typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length === 0)) return null;
  return <CodeBlock code={typeof input === 'string' ? input : JSON.stringify(input, null, 2)} lang={typeof input === 'string' ? undefined : 'json'} />;
}

function CallDetail({ block, result, ctx }: { block: ToolUseBlock; result?: ToolResultBlock; ctx: BlockCtx }) {
  const kind = toolKind(block.name);
  const o = asObj(block.input);
  const out = result ? resultText(result) : '';
  const extras = result ? <ResultExtras result={result} ctx={ctx} /> : null;
  const output = result ? <Output text={out} error={result.isError} /> : null;

  switch (kind) {
    case 'command': {
      const cmd = commandOf(block) ?? '';
      return (
        <>
          <Output
            text={out}
            error={result?.isError}
            prompt={
              <div className="flex gap-2 text-ink">
                <span className="text-faint select-none">$</span>
                <span className="min-w-0 whitespace-pre-wrap">{cmd}</span>
              </div>
            }
          />
          {extras}
        </>
      );
    }
    case 'edit': {
      const path = filePathOf(block);
      const patch = patchOf(block);
      const edits = editsOf(block);
      return (
        <>
          <PathLine path={path} />
          {patch ? <DiffLines lines={patchLines(patch)} /> : edits.map((e, i) => <DiffView key={i} oldText={e.oldText} newText={e.newText} />)}
          {!patch && !edits.length && <JsonInput input={block.input} />}
          {result?.isError && output}
        </>
      );
    }
    case 'write': {
      const path = filePathOf(block);
      const content = typeof o.content === 'string' ? o.content : '';
      return (
        <>
          <PathLine path={path} />
          <div className="max-h-[30rem] overflow-auto rounded-[10px]">
            <CodeBlock code={content} lang={langOf(path)} />
          </div>
          {result?.isError && output}
        </>
      );
    }
    case 'read':
      return (
        <>
          <PathLine path={filePathOf(block)} />
          {output}
          {extras}
        </>
      );
    case 'fetch':
    case 'web_search':
      return (
        <>
          {typeof o.url === 'string' && (
            <a href={o.url} target="_blank" rel="noopener noreferrer nofollow" className="block truncate text-[12.5px] text-accent hover:underline">
              {o.url}
            </a>
          )}
          {typeof o.query === 'string' && <div className="text-[13px] text-ink">“{o.query}”</div>}
          {typeof o.prompt === 'string' && <div className="text-[12.5px] text-muted">{o.prompt}</div>}
          {output}
        </>
      );
    case 'agent':
      return (
        <>
          {block.subSessionId && ctx.onOpenSubSession && (
            <button
              type="button"
              onClick={() => ctx.onOpenSubSession!(block.subSessionId!)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent-soft px-2.5 py-1.5 text-[12.5px] font-medium text-accent hover:brightness-110"
            >
              <Bot size={14} /> Open this agent’s run
              <ChevronRight size={13} />
            </button>
          )}
          {typeof o.prompt === 'string' && (
            <Disclosure summary="Instructions it was given">{() => <div className="rounded-xl bg-raised/60 px-4 py-3 [&_.prose-msg]:text-[13.5px]"><Markdown text={o.prompt as string} /></div>}</Disclosure>
          )}
          {result && out && (
            <div className="rounded-xl border border-line px-4 py-3 [&_.prose-msg]:text-[13.5px]">
              <div className="mb-1.5 text-[11.5px] font-medium text-faint">What it reported back</div>
              <Markdown text={out} />
            </div>
          )}
          {extras}
        </>
      );
    case 'plan':
      return <PlanList input={block.input} />;
    default: {
      const { server } = toolName(block.name);
      return (
        <>
          {server && <div className="text-[12px] text-faint">{serverLabel(block.name)} · {toolName(block.name).name}</div>}
          <JsonInput input={block.input} />
          {output}
          {extras}
        </>
      );
    }
  }
}

/* ------------------------------------------------------------------ */

export function BlockView({ block, ctx }: { block: Block; ctx: BlockCtx }): ReactNode {
  switch (block.type) {
    case 'text':
      return <TextView text={block.text} truncated={block.truncated} ctx={ctx} />;
    case 'thinking':
      // Thinking saved without readable text (signature-only or encrypted): nothing to show.
      if (!block.text.trim()) return null;
      return (
        <div className="flex gap-2.5 px-3 py-2">
          <Brain size={14} className="mt-[3px] shrink-0 text-faint" strokeWidth={1.9} />
          <div className="min-w-0 flex-1 text-muted [&_.prose-msg]:text-[13.5px] [&_.prose-msg]:text-muted">
            <TextView text={block.text} truncated={block.truncated} ctx={ctx} />
          </div>
        </div>
      );
    case 'tool_use':
      return <CallRow block={block} ctx={ctx} />;
    case 'tool_result':
      return (
        <div className="px-3 py-2">
          <Disclosure tone={block.isError ? 'error' : 'default'} summary={block.isError ? 'Tool error' : 'Tool output'}>
            {() => <ToolResultView block={block} ctx={ctx} />}
          </Disclosure>
        </div>
      );
    case 'image':
      return <ImageView block={block} ctx={ctx} />;
    case 'document':
      return (
        <a
          href={block.blobPath ? api.blobUrl(ctx.sessionId, ctx.seq, block.blobPath) : undefined}
          target="_blank"
          rel="noopener"
          className="inline-flex items-center gap-2 rounded-xl bg-raised px-3 py-2 text-[13px] text-ink hover:bg-raised-2"
        >
          <FileText size={15} className="text-muted" /> {block.title ?? 'Document'} <span className="text-faint">{bytes(block.size)}</span>
        </a>
      );
    case 'file_ref':
      return <FileRefView block={block} />;
    case 'notice': {
      const Icon = block.level === 'info' ? Info : AlertTriangle;
      const color = block.level === 'error' ? 'text-error' : block.level === 'warning' ? 'text-warn' : 'text-muted';
      return (
        <div className={`flex items-start gap-2 text-[13px] ${color}`}>
          <Icon size={14} className="mt-[2px] shrink-0" />
          <span className="min-w-0 whitespace-pre-wrap">{block.text}</span>
        </div>
      );
    }
    case 'raw':
      return (
        <Disclosure icon={<Braces size={14} className="shrink-0" />} summary={block.recordType}>
          {() => <CodeBlock code={JSON.stringify(block.json, null, 2)} lang="json" />}
        </Disclosure>
      );
    default:
      return null;
  }
}
