import type { ChatEvent, ToolResultBlock } from '../api.ts';

/**
 * Turns a flat event list into display rows:
 * - a human prompt is its own row
 * - assistant prose is its own row
 * - runs of tool calls / results / thinking / meta between them collapse
 *   into one "activity" row, with tool results paired to their calls
 */
export type Row =
  | { kind: 'prompt'; key: string; event: ChatEvent }
  | { kind: 'reply'; key: string; event: ChatEvent; results: Map<string, ToolResultBlock> }
  | { kind: 'divider'; key: string; event: ChatEvent }
  | { kind: 'activity'; key: string; events: ChatEvent[]; results: Map<string, ToolResultBlock>; firstSeq: number };

function isPrompt(e: ChatEvent) {
  return e.role === 'user' && e.visibility === 'conversation' && !e.synthetic;
}

function isReply(e: ChatEvent) {
  return e.role === 'assistant' && e.visibility === 'conversation' && e.blocks.some((b) => b.type === 'text' && b.text.trim());
}

function isDivider(e: ChatEvent) {
  return e.visibility === 'conversation' && e.blocks.length > 0 && e.blocks.every((b) => b.type === 'notice');
}

export function buildRows(events: ChatEvent[]): Row[] {
  const rows: Row[] = [];
  let group: ChatEvent[] = [];

  const flush = () => {
    if (!group.length) return;
    const results = new Map<string, ToolResultBlock>();
    for (const e of group) for (const b of e.blocks) if (b.type === 'tool_result') results.set(b.toolUseId, b);
    rows.push({ kind: 'activity', key: `a${group[0]!.seq}`, events: group, results, firstSeq: group[0]!.seq });
    group = [];
  };

  for (const e of events) {
    if (isPrompt(e)) {
      flush();
      rows.push({ kind: 'prompt', key: `p${e.seq}`, event: e });
    } else if (isReply(e)) {
      flush();
      rows.push({ kind: 'reply', key: `r${e.seq}`, event: e, results: new Map() });
    } else if (isDivider(e)) {
      flush();
      rows.push({ kind: 'divider', key: `d${e.seq}`, event: e });
    } else {
      group.push(e);
    }
  }
  flush();

  // Results of tool calls made inside a reply row usually arrive in the
  // following activity row; let the reply see them too.
  for (let i = 0; i < rows.length - 1; i++) {
    const r = rows[i]!;
    const next = rows[i + 1]!;
    if (r.kind === 'reply' && next.kind === 'activity') r.results = next.results;
  }
  return rows;
}

export function activitySummary(events: ChatEvent[]): { tools: Map<string, number>; thinking: number; meta: number; errors: number; images: number } {
  const tools = new Map<string, number>();
  let thinking = 0;
  let meta = 0;
  let errors = 0;
  let images = 0;
  for (const e of events) {
    if (e.visibility === 'meta') meta++;
    for (const b of e.blocks) {
      if (b.type === 'tool_use') tools.set(b.name, (tools.get(b.name) ?? 0) + 1);
      else if (b.type === 'thinking') thinking++;
      else if (b.type === 'tool_result') {
        if (b.isError) errors++;
        images += b.content.filter((c) => c.type === 'image').length;
      } else if (b.type === 'image') images++;
    }
  }
  return { tools, thinking, meta, errors, images };
}
