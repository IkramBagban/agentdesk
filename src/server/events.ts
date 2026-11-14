import { open, stat } from 'node:fs/promises';
import type { ParseLine, SourceAdapter } from '../core/adapter.ts';
import type { DiscoveredFile } from '../core/adapter.ts';
import type { Block, ChatEvent, RawLine, SessionMeta } from '../core/types.ts';
import type { EventRef, IndexStore } from '../index/store.ts';

export type Adapter = SourceAdapter & { parseLine: ParseLine };

export const TRUNCATE_CHARS = 20 * 1024;
const MAX_COALESCE_BYTES = 4 * 1024 * 1024;

export function noticeEvent(ref: EventRef, text: string): ChatEvent {
  return {
    seq: ref.seq,
    role: 'system',
    visibility: ref.visibility,
    offBranch: ref.offBranch || undefined,
    blocks: [{ type: 'notice', level: 'error', kind: 'read_error', text }],
    line: ref.line,
    offset: ref.offset,
    length: ref.length,
  };
}

function discoveredFor(meta: SessionMeta): DiscoveredFile {
  return {
    path: meta.filePath,
    nativeId: meta.nativeId,
    projectKey: meta.projectKey,
    ...(meta.parentSessionId
      ? { parentNativeId: meta.parentSessionId.slice(meta.parentSessionId.indexOf(':') + 1) }
      : {}),
  };
}

/** Parse the event for one ref from already-read line text. */
function parseRef(adapter: Adapter, meta: SessionMeta, ref: EventRef, text: string): ChatEvent {
  const raw: RawLine = { line: ref.line, offset: ref.offset, length: ref.length, text };
  const events = adapter.parseLine(raw, ref.lineFirstSeq, discoveredFor(meta));
  const ev = events[ref.lineEventIndex];
  if (!ev || ev.seq !== ref.seq) {
    throw new Error('line no longer matches the index (file changed?)');
  }
  return { ...ev, offBranch: ref.offBranch || undefined };
}

/**
 * Read + parse the events for the given refs (unsanitised: still holds base64).
 * Never throws for per-event problems; those become error NoticeBlocks.
 */
export async function readRefs(
  adapter: Adapter | undefined,
  meta: SessionMeta,
  refs: EventRef[],
): Promise<ChatEvent[]> {
  if (refs.length === 0) return [];
  if (!adapter) return refs.map((r) => noticeEvent(r, `no adapter for source ${meta.sourceId}`));

  // group refs by line, preserving first-seen order for output
  const byLine = new Map<number, EventRef[]>();
  for (const r of refs) {
    const k = r.offset;
    const g = byLine.get(k);
    if (g) g.push(r);
    else byLine.set(k, [r]);
  }
  const groups = [...byLine.values()].sort((a, b) => a[0]!.offset - b[0]!.offset);

  // coalesce adjacent line ranges into single reads
  interface Span {
    start: number;
    end: number;
    groups: EventRef[][];
  }
  const spans: Span[] = [];
  for (const g of groups) {
    const first = g[0]!;
    const end = first.offset + first.length;
    const last = spans[spans.length - 1];
    if (last && first.offset - last.end <= 2 && end - last.start <= MAX_COALESCE_BYTES) {
      last.end = Math.max(last.end, end);
      last.groups.push(g);
    } else {
      spans.push({ start: first.offset, end, groups: [g] });
    }
  }

  const out = new Map<number, ChatEvent>();
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(meta.filePath, 'r');
  } catch {
    for (const r of refs) out.set(r.seq, noticeEvent(r, 'session file is no longer readable'));
  }
  try {
    if (fh) {
      for (const span of spans) {
        let buf: Buffer | undefined;
        try {
          const size = span.end - span.start;
          buf = Buffer.allocUnsafe(size);
          let got = 0;
          while (got < size) {
            const { bytesRead } = await fh.read(buf, got, size - got, span.start + got);
            if (bytesRead === 0) break;
            got += bytesRead;
          }
          if (got < size) buf = undefined;
        } catch {
          buf = undefined;
        }
        for (const g of span.groups) {
          const first = g[0]!;
          for (const ref of g) {
            try {
              if (!buf) throw new Error('could not read bytes (file truncated or changed)');
              const rel = first.offset - span.start;
              const text = buf.toString('utf8', rel, rel + first.length);
              out.set(ref.seq, parseRef(adapter, meta, ref, text));
            } catch (e) {
              out.set(ref.seq, noticeEvent(ref, e instanceof Error ? e.message : 'failed to read event'));
            }
          }
        }
      }
    }
  } finally {
    await fh?.close().catch(() => {});
  }
  return refs.map((r) => out.get(r.seq) ?? noticeEvent(r, 'event missing'));
}

// ---------------------------------------------------------------------------
// Sanitising
// ---------------------------------------------------------------------------

export class ExistsCache {
  private m = new Map<string, { v: boolean; at: number }>();
  constructor(private ttlMs = 5000) {}
  async exists(path: string): Promise<boolean> {
    const hit = this.m.get(path);
    const now = Date.now();
    if (hit && now - hit.at < this.ttlMs) return hit.v;
    let v = false;
    try {
      await stat(path);
      v = true;
    } catch {
      v = false;
    }
    if (this.m.size > 5000) this.m.clear();
    this.m.set(path, { v, at: now });
    return v;
  }
}

export interface SanitizeOpts {
  truncate: boolean;
  links: Map<string, string>;
  exists: ExistsCache;
}

async function sanitizeBlocks(blocks: Block[], prefix: string, o: SanitizeOpts): Promise<Block[]> {
  const out: Block[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    const path = prefix ? `${prefix}.content.${i}` : String(i);
    out.push(await sanitizeBlock(b, path, o));
  }
  return out;
}

async function sanitizeBlock(b: Block, path: string, o: SanitizeOpts): Promise<Block> {
  switch (b.type) {
    case 'text':
    case 'thinking': {
      if (o.truncate && b.text.length > TRUNCATE_CHARS) {
        return { ...b, text: b.text.slice(0, TRUNCATE_CHARS), truncated: { fullLength: b.text.length } };
      }
      return b;
    }
    case 'tool_use': {
      const sub = o.links.get(b.id);
      return sub && !b.subSessionId ? { ...b, subSessionId: sub } : b;
    }
    case 'tool_result':
      return { ...b, content: await sanitizeBlocks(b.content ?? [], path, o) };
    case 'image':
    case 'document': {
      const { data: _data, ...rest } = b;
      void _data;
      return { ...rest, blobPath: path } as Block;
    }
    case 'file_ref':
      return { ...b, exists: await o.exists.exists(b.path) };
    case 'raw': {
      if (o.truncate) {
        let s: string | undefined;
        try {
          s = JSON.stringify(b.json);
        } catch {
          s = String(b.json);
        }
        if (s !== undefined && s.length > TRUNCATE_CHARS) {
          return {
            ...b,
            json: { _truncated: true, fullLength: s.length, preview: s.slice(0, TRUNCATE_CHARS) },
          };
        }
      }
      return b;
    }
    default:
      return b;
  }
}

export async function sanitizeEvent(ev: ChatEvent, o: SanitizeOpts): Promise<ChatEvent> {
  return { ...ev, blocks: await sanitizeBlocks(ev.blocks, '', o) };
}

/** Follow a dotted blob path ("1.content.0") inside an event's blocks. */
export function resolveBlobPath(ev: ChatEvent, path: string): Block | undefined {
  const parts = path.split('.');
  let cur: unknown = ev.blocks;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (i % 2 === 0) {
      if (!/^\d+$/.test(p) || !Array.isArray(cur)) return undefined;
      cur = cur[Number(p)];
    } else {
      if (p !== 'content' || !cur || typeof cur !== 'object') return undefined;
      cur = (cur as { content?: unknown }).content;
    }
  }
  if (!cur || typeof cur !== 'object') return undefined;
  return cur as Block;
}

export function lookupAdapter(
  adapters: Map<string, Adapter>,
  store: IndexStore,
  sessionId: string,
): { meta: SessionMeta; adapter: Adapter | undefined } | undefined {
  const meta = store.getSession(sessionId);
  if (!meta) return undefined;
  return { meta, adapter: adapters.get(meta.sourceId) };
}
