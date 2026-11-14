import type { Block, ChatEvent } from '../core/types.ts';

const RESULT_MAX = 4000;

function fenceFor(text: string): string {
  let max = 2;
  for (const m of text.matchAll(/`+/g)) max = Math.max(max, m[0].length);
  return '`'.repeat(max + 1);
}

function fenced(text: string, lang = ''): string {
  const f = fenceFor(text);
  return `${f}${lang}\n${text}\n${f}`;
}

function jsonText(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    return String(v);
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function blockToMarkdown(b: Block): string {
  switch (b.type) {
    case 'text':
      return b.text;
    case 'thinking':
      return b.redacted ? '_[redacted thinking]_' : `<details><summary>thinking</summary>\n\n${b.text}\n\n</details>`;
    case 'tool_use':
      return `**Tool call: ${b.name}**\n\n${fenced(jsonText(b.input), 'json')}`;
    case 'tool_result': {
      const inner = b.content
        .map((c) => (c.type === 'text' ? c.text : blockToMarkdown(c)))
        .join('\n\n');
      const clipped =
        inner.length > RESULT_MAX ? `${inner.slice(0, RESULT_MAX)}\n... [${inner.length - RESULT_MAX} more characters]` : inner;
      return `**Tool result${b.isError ? ' (error)' : ''}**\n\n${fenced(clipped)}`;
    }
    case 'image':
      return `[image: ${b.mediaType}, ${formatBytes(b.size)}]`;
    case 'document':
      return `[document: ${b.title ? `${b.title}, ` : ''}${b.mediaType}, ${formatBytes(b.size)}]`;
    case 'file_ref':
      return `[file: ${b.path}${b.label ? ` (${b.label})` : ''}]`;
    case 'notice':
      return `> ${b.level}: ${b.text}`;
    case 'raw':
      return `**Raw record: ${b.recordType}**\n\n${fenced(jsonText(b.json).slice(0, RESULT_MAX), 'json')}`;
  }
}

export function eventToMarkdown(ev: ChatEvent): string {
  const who =
    ev.role === 'user' ? 'User' : ev.role === 'assistant' ? 'Assistant' : ev.role === 'tool' ? 'Tool' : 'System';
  const head = `### ${who}${ev.timestamp ? ` (${ev.timestamp})` : ''}`;
  const body = ev.blocks.map(blockToMarkdown).filter((s) => s.length > 0).join('\n\n');
  return `${head}\n\n${body}\n\n`;
}
