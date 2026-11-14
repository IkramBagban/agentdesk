import { createReadStream } from 'node:fs';

export interface ReadLine {
  /** byte offset of the first byte of the line */
  offset: number;
  /** raw bytes of the line, excluding the terminating \n (a trailing \r, if any, is still included) */
  raw: Buffer;
  /** offset just after the terminating \n (or end of data for an unterminated line) */
  nextOffset: number;
  /** false only for a final line with no terminating \n */
  complete: boolean;
}

/**
 * Stream a file's lines with exact byte offsets. Splits on byte 0x0A only; never
 * decodes-then-re-encodes, so offsets are right for any UTF-8 content. Holds at
 * most one line (plus one 1 MiB chunk) in memory. Reads bytes [start, endExclusive).
 */
export async function* readLines(path: string, start: number, endExclusive: number): AsyncGenerator<ReadLine> {
  if (endExclusive <= start) return;
  const stream = createReadStream(path, { start, end: endExclusive - 1, highWaterMark: 1 << 20 });
  let pos = start; // absolute offset of the current chunk's first byte
  let lineStart = start;
  let pending: Buffer[] = [];
  let pendingLen = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    let i = 0;
    for (;;) {
      const nl = chunk.indexOf(0x0a, i);
      if (nl < 0) {
        if (i < chunk.length) {
          pending.push(chunk.subarray(i));
          pendingLen += chunk.length - i;
        }
        break;
      }
      const part = chunk.subarray(i, nl);
      const raw = pending.length ? Buffer.concat([...pending, part], pendingLen + part.length) : part;
      pending = [];
      pendingLen = 0;
      const next = pos + nl + 1;
      yield { offset: lineStart, raw, nextOffset: next, complete: true };
      lineStart = next;
      i = nl + 1;
    }
    pos += chunk.length;
  }
  if (pendingLen > 0) {
    yield { offset: lineStart, raw: Buffer.concat(pending, pendingLen), nextOffset: pos, complete: false };
  }
}
