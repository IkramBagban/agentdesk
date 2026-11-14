import type { Block, ChatEvent, ToolResultBlock } from '../api.ts';
import { span } from '../format.ts';

/**
 * Turns a flat event list into display rows:
 * - a human prompt is its own row (a bubble)
 * - assistant prose is its own row (plain text)
 * - everything between them (tool calls, results, thinking, background
 *   records) collapses into one "activity" row, with results paired to calls
 * - a date row appears where the day changes or after a long pause
 *
 * An assistant message that mixes prose and tool calls is split, so the
 * prose reads as prose and the calls join the activity around them.
 */
export type Row =
  | { kind: 'prompt'; key: string; event: ChatEvent }
  | { kind: 'reply'; key: string; event: ChatEvent; endOfTurn?: boolean }
  | { kind: 'divider'; key: string; event: ChatEvent }
  | { kind: 'date'; key: string; timestamp: string }
  | {
      kind: 'activity';
      key: string;
      events: ChatEvent[];
      results: Map<string, ToolResultBlock>;
      firstSeq: number;
      /** ms from the first step to whatever came next */
      durationMs?: number;
    };

function isPrompt(e: ChatEvent) {
  return e.role === 'user' && e.visibility === 'conversation' && !e.synthetic;
}

function isDivider(e: ChatEvent) {
  return e.visibility === 'conversation' && e.blocks.length > 0 && e.blocks.every((b) => b.type === 'notice');
}

const isProse = (b: Block) => (b.type === 'text' && b.text.trim() !== '') || b.type === 'image' || b.type === 'document';

/** Split an assistant event into alternating prose / work pieces. */
function pieces(e: ChatEvent): { prose: boolean; event: ChatEvent; part: number }[] {
  const out: { prose: boolean; event: ChatEvent; part: number }[] = [];
  let cur: Block[] = [];
  let curProse: boolean | undefined;
  const push = () => {
    if (cur.length) out.push({ prose: !!curProse, event: { ...e, blocks: cur }, part: out.length });
    cur = [];
  };
  for (const b of e.blocks) {
    // Empty text blocks carry nothing; keep them with whatever is around.
    const p = b.type === 'text' && !b.text.trim() ? (curProse ?? false) : isProse(b);
    if (curProse !== undefined && p !== curProse) push();
    curProse = p;
    cur.push(b);
  }
  push();
  return out;
}

const hasContent = (b: Block) => !((b.type === 'thinking' || b.type === 'text') && !b.text.trim());

const LONG_PAUSE = 3 * 60 * 60 * 1000;

function rowTime(r: Row): string | undefined {
  switch (r.kind) {
    case 'activity':
      return r.events.find((e) => e.timestamp)?.timestamp;
    case 'date':
      return r.timestamp;
    default:
      return r.event.timestamp;
  }
}

export function buildRows(events: ChatEvent[]): Row[] {
  const rows: Row[] = [];
  let group: ChatEvent[] = [];
  let groupKey = '';

  // Results are paired with their calls across the whole loaded range (a call
  // and its result can land in different runs); paired results are shown
  // under the call, so they're dropped from the event they arrived in.
  const results = new Map<string, ToolResultBlock>();
  const calls = new Set<string>();
  for (const e of events)
    for (const b of e.blocks) {
      if (b.type === 'tool_result') results.set(b.toolUseId, b);
      else if (b.type === 'tool_use') calls.add(b.id);
    }

  const flush = () => {
    if (!group.length) return;
    rows.push({ kind: 'activity', key: groupKey, events: group, results, firstSeq: group[0]!.seq });
    group = [];
  };
  const add = (e: ChatEvent, key: string) => {
    if (!group.length) groupKey = key;
    group.push(e);
  };

  for (let e of events) {
    if (e.blocks.some((b) => b.type === 'tool_result' && calls.has(b.toolUseId))) e = { ...e, blocks: e.blocks.filter((b) => !(b.type === 'tool_result' && calls.has(b.toolUseId))) };
    // Records with nothing readable (e.g. signature-only thinking) would be empty rows.
    if (!e.blocks.some(hasContent)) continue;
    if (isPrompt(e)) {
      flush();
      rows.push({ kind: 'prompt', key: `p${e.seq}`, event: e });
    } else if (isDivider(e)) {
      flush();
      rows.push({ kind: 'divider', key: `d${e.seq}`, event: e });
    } else if (e.role === 'assistant' && e.visibility === 'conversation' && e.blocks.some(isProse)) {
      for (const p of pieces(e)) {
        if (p.prose) {
          flush();
          rows.push({ kind: 'reply', key: `r${e.seq}.${p.part}`, event: p.event });
        } else add(p.event, `a${e.seq}.${p.part}`);
      }
    } else add(e, `a${e.seq}`);
  }
  flush();

  // How long each run of work took: until the next row starts.
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.kind !== 'activity') continue;
    const start = rowTime(r);
    // Until the reply that follows; if the user speaks next, only until the last step (not their idle time).
    const next = rows[i + 1];
    const lastStep = [...r.events].reverse().find((e) => e.timestamp)?.timestamp;
    const end = next && next.kind !== 'prompt' ? (rowTime(next) ?? lastStep) : lastStep;
    r.durationMs = span(start, end);
  }

  // The last reply before the next prompt carries the action row (copy, time).
  let seenReply = false;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (r.kind === 'prompt') seenReply = false;
    else if (r.kind === 'reply' && !seenReply) {
      r.endOfTurn = true;
      seenReply = true;
    }
  }

  // Date separators: at the top, when the day changes, or after a long pause before a prompt.
  const out: Row[] = [];
  let last: string | undefined;
  for (const r of rows) {
    const t = rowTime(r);
    if (t) {
      const d = new Date(t);
      const prev = last ? new Date(last) : undefined;
      const newDay = !prev || prev.toDateString() !== d.toDateString();
      const pause = prev && r.kind === 'prompt' && d.getTime() - prev.getTime() > LONG_PAUSE;
      if (newDay || pause) out.push({ kind: 'date', key: `t${r.key}`, timestamp: t });
      last = t;
    }
    out.push(r);
  }
  return out;
}

/** Event seqs a row covers (for jump-to-seq). */
export function rowSeqs(r: Row): number[] {
  switch (r.kind) {
    case 'activity':
      return r.events.map((e) => e.seq);
    case 'date':
      return [];
    default:
      return [r.event.seq];
  }
}
