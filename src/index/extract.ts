import type { Block, ChatEvent } from '../core/types.ts';

/** Max FTS characters per event, by visibility. Meta events are not indexed at all. */
export const FTS_CAP_CONVERSATION = 16 * 1024;
export const FTS_CAP_DETAIL = 6 * 1024;
export const PREVIEW_CHARS = 200;

// Private-use chars are our snippet markers; strip them from indexed text so content can't forge <mark>.
const SENTINELS = /[\u0000]/g;

class Collector {
  private parts: string[] = [];
  len = 0;
  readonly cap: number;
  constructor(cap: number) {
    this.cap = cap;
  }
  get full(): boolean {
    return this.len >= this.cap;
  }
  add(s: string): void {
    if (this.full || !s) return;
    const room = this.cap - this.len;
    let piece = s.length > room ? s.slice(0, room) : s;
    if (piece.length > 0 && s.length > room) {
      const last = piece.charCodeAt(piece.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) piece = piece.slice(0, -1); // don't split a surrogate pair
    }
    this.parts.push(piece);
    this.len += piece.length + 1;
  }
  text(): string {
    return this.parts.join('\n').replace(SENTINELS, '');
  }
}

/** Long whitespace-free strings are almost certainly base64 / opaque blobs. */
function looksOpaque(s: string): boolean {
  if (s.length < 400) return false;
  const head = s.length > 600 ? s.slice(0, 600) : s;
  return !/\s/.test(head);
}

function walkValue(v: unknown, c: Collector, depth: number): void {
  if (c.full || v == null) return;
  if (typeof v === 'string') {
    if (!looksOpaque(v)) c.add(v);
  } else if (typeof v === 'number' || typeof v === 'boolean') {
    // not useful for search
  } else if (depth > 6) {
    return;
  } else if (Array.isArray(v)) {
    for (const x of v) {
      if (c.full) break;
      walkValue(x, c, depth + 1);
    }
  } else if (typeof v === 'object') {
    for (const x of Object.values(v as Record<string, unknown>)) {
      if (c.full) break;
      walkValue(x, c, depth + 1);
    }
  }
}

function walkBlocks(blocks: Block[], c: Collector, flags: { image: boolean; tools: string[] }): void {
  for (const b of blocks) {
    if (!b) continue;
    switch (b.type) {
      case 'text':
        c.add(b.text);
        break;
      case 'thinking':
        if (!b.redacted) c.add(b.text);
        break;
      case 'tool_use':
        flags.tools.push(b.name);
        c.add(b.name);
        walkValue(b.input, c, 0);
        break;
      case 'tool_result':
        walkBlocks(b.content ?? [], c, flags);
        break;
      case 'image':
        flags.image = true;
        break;
      case 'document':
        if (b.title) c.add(b.title);
        break;
      case 'file_ref':
        c.add(b.path);
        if (b.snippet) c.add(b.snippet);
        break;
      case 'notice':
        c.add(b.text);
        break;
      default:
        break; // raw: not indexed
    }
  }
}

function firstString(blocks: Block[]): string | undefined {
  // prefer plain text, then thinking-free fallbacks
  for (const b of blocks) if (b.type === 'text' && b.text.trim()) return b.text;
  for (const b of blocks) {
    if (b.type === 'tool_use') {
      const c = new Collector(160);
      walkValue(b.input, c, 0);
      return `${b.name} ${c.text()}`;
    }
    if (b.type === 'tool_result') {
      const s = firstString(b.content ?? []);
      if (s) return s;
    }
    if (b.type === 'notice' && b.text.trim()) return b.text;
    if (b.type === 'thinking' && !b.redacted && b.text.trim()) return b.text;
    if (b.type === 'file_ref') return b.path;
  }
  return undefined;
}

export interface EventDigest {
  preview: string | null;
  hasImage: boolean;
  toolNames: string | null;
  /** null when the event should not be in the FTS index */
  fts: string | null;
}

export function digestEvent(ev: ChatEvent): EventDigest {
  const cap = ev.visibility === 'conversation' ? FTS_CAP_CONVERSATION : FTS_CAP_DETAIL;
  const c = new Collector(ev.visibility === 'meta' ? 0 : cap);
  const flags = { image: false, tools: [] as string[] };
  // for meta events we still need flags; collector with cap 0 ignores text
  walkBlocks(ev.blocks ?? [], c, flags);
  const first = firstString(ev.blocks ?? []);
  const preview = first ? first.slice(0, 2000).replace(/\s+/g, ' ').trim().slice(0, PREVIEW_CHARS) : '';
  const fts = ev.visibility === 'meta' ? null : c.text().trim();
  return {
    preview: preview || null,
    hasImage: flags.image,
    toolNames: flags.tools.length ? [...new Set(flags.tools)].join(',') : null,
    fts: fts ? fts : null,
  };
}
