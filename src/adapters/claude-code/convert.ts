/**
 * Pure record -> event conversion. No state; shared by the stateful parser and
 * the stateless parseLine so the two cannot drift.
 */
import type {
  Block,
  ChatEvent,
  FileRefBlock,
  ImageBlock,
  NoticeBlock,
  RawBlock,
  Role,
  TextBlock,
  ToolResultBlock,
  Visibility,
} from '../../core/types.ts';
import { clip, isObj, num, type Rec, shrink, str } from './util.ts';

/** An event before seq / file location are assigned. */
export type Draft = Omit<ChatEvent, 'seq' | 'line' | 'offset' | 'length'>;

/** Record types that produce no events; they only feed SessionMeta. */
const BOOKKEEPING = new Set([
  'custom-title',
  'agent-name',
  'last-prompt',
  'cost-state',
  'pr-link',
  'frame-link',
  'queue-operation',
  'mode',
  'permission-mode',
  'atis-latch',
  'bridge-session',
  'relocated',
  'tools-used',
]);

export function isBookkeeping(type: string): boolean {
  return (
    BOOKKEEPING.has(type) ||
    type.startsWith('api-request') ||
    type.startsWith('file-history-') ||
    type.startsWith('artifact-')
  );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const WRAPPER_TAGS = [
  'system-reminder',
  'command-name',
  'command-message',
  'command-args',
  'local-command-stdout',
  'local-command-stderr',
  'local-command-caveat',
  'task-notification',
  'user-prompt-submit-hook',
  'bash-input',
  'bash-stdout',
  'bash-stderr',
  'ide_opened_file',
  'ide_selection',
];

/** True if the text consists only of harness wrapper elements (and whitespace). */
export function isWrapperOnly(text: string): boolean {
  let s = text.trimStart();
  if (s.length === 0) return false;
  let guard = 0;
  while (s.length > 0 && guard++ < 200) {
    if (s[0] !== '<') return false;
    let matched: string | undefined;
    for (const t of WRAPPER_TAGS) {
      if (s.startsWith(`<${t}>`) || s.startsWith(`<${t} `)) {
        matched = t;
        break;
      }
    }
    if (!matched) return false;
    const close = `</${matched}>`;
    const idx = s.indexOf(close);
    if (idx === -1) return true; // unterminated wrapper: treat the rest as wrapper content
    s = s.slice(idx + close.length).trimStart();
  }
  return true;
}

function textBlock(text: string): TextBlock {
  return { type: 'text', text };
}
function raw(recordType: string, json: unknown): RawBlock {
  return { type: 'raw', recordType, json: shrink(json) };
}
function notice(level: NoticeBlock['level'], kind: string, text: string): NoticeBlock {
  return { type: 'notice', level, kind, text };
}
function b64Size(data: string): number {
  const pad = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - pad);
}

/** Convert one content block that can appear in user/tool_result content. */
function contentBlock(b: unknown): Block {
  if (typeof b === 'string') return textBlock(b);
  if (!isObj(b)) return raw('block', b);
  const type = str(b.type);
  switch (type) {
    case 'text':
      return textBlock(str(b.text) ?? '');
    case 'image': {
      const src = isObj(b.source) ? b.source : undefined;
      if (src && src.type === 'base64' && typeof src.data === 'string') {
        const img: ImageBlock = {
          type: 'image',
          mediaType: str(src.media_type) ?? 'application/octet-stream',
          size: b64Size(src.data),
          data: src.data,
        };
        return img;
      }
      return raw('block:image', b);
    }
    case 'document': {
      const src = isObj(b.source) ? b.source : undefined;
      if (src && src.type === 'base64' && typeof src.data === 'string') {
        const title = str(b.title);
        return {
          type: 'document',
          mediaType: str(src.media_type) ?? 'application/octet-stream',
          size: b64Size(src.data),
          data: src.data,
          ...(title ? { title } : {}),
        };
      }
      if (src && src.type === 'text' && typeof src.data === 'string') {
        return textBlock(src.data);
      }
      return raw('block:document', b);
    }
    case 'tool_reference':
      return textBlock(`[tool reference: ${str(b.tool_name) ?? '?'}]`);
    default:
      return raw(`block:${type ?? 'unknown'}`, b);
  }
}

const TOOL_RESULT_PATH = /\/[^\s"'<>`]*\/tool-results\/[^\s"'<>`]+/g;

function toolOutputRefs(blocks: Block[]): FileRefBlock[] {
  const refs: FileRefBlock[] = [];
  const seen = new Set<string>();
  for (const b of blocks) {
    if (b.type !== 'text' || !b.text.includes('tool-results/')) continue;
    const head = b.text.length > 4000 ? b.text.slice(0, 4000) : b.text;
    for (const m of head.matchAll(TOOL_RESULT_PATH)) {
      const p = m[0].replace(/[.,;:)\]}]+$/, '');
      if (seen.has(p) || seen.size >= 3) continue;
      seen.add(p);
      refs.push({ type: 'file_ref', path: p, role: 'tool_output', label: p.slice(p.lastIndexOf('/') + 1) });
    }
  }
  return refs;
}

function toolResultBlock(b: Rec): ToolResultBlock {
  const c = b.content;
  let content: Block[];
  if (typeof c === 'string') content = c.length ? [textBlock(c)] : [];
  else if (Array.isArray(c)) content = c.map(contentBlock);
  else content = [];
  content.push(...toolOutputRefs(content));
  const out: ToolResultBlock = { type: 'tool_result', toolUseId: str(b.tool_use_id) ?? '', content };
  if (b.is_error === true) out.isError = true;
  return out;
}

/** Fill blobPath on every image/document block (dotted path inside the event's blocks). */
export function assignBlobPaths(blocks: Block[], prefix = ''): void {
  blocks.forEach((b, i) => {
    if (b.type === 'image' || b.type === 'document') b.blobPath = `${prefix}${i}`;
    else if (b.type === 'tool_result') assignBlobPaths(b.content, `${prefix}${i}.content.`);
  });
}

export function countImages(blocks: Block[]): number {
  let n = 0;
  for (const b of blocks) {
    if (b.type === 'image') n++;
    else if (b.type === 'tool_result') n += countImages(b.content);
  }
  return n;
}

export function textOf(blocks: Block[]): string {
  const parts: string[] = [];
  for (const b of blocks) if (b.type === 'text') parts.push(b.text);
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// per-type conversion
// ---------------------------------------------------------------------------

interface Base {
  uuid?: string;
  parentUuid?: string;
  timestamp?: string;
}

function base(rec: Rec): Base {
  const out: Base = {};
  const uuid = str(rec.uuid);
  if (uuid) out.uuid = uuid;
  const parent = str(rec.parentUuid) ?? str(rec.logicalParentUuid);
  if (parent) out.parentUuid = parent;
  const ts = str(rec.timestamp);
  if (ts) out.timestamp = ts;
  return out;
}

function draft(rec: Rec, role: Role, visibility: Visibility, blocks: Block[], extra?: Partial<Draft>): Draft {
  return { ...base(rec), role, visibility, blocks, ...extra };
}

function userText(rec: Rec, blocks: Block[], hint?: { forceMeta?: boolean }): Draft {
  const text = textOf(blocks);
  const hasNonText = blocks.some((b) => b.type !== 'text');
  const trimmed = text.trim();
  if (rec.isMeta === true || hint?.forceMeta || (!hasNonText && trimmed && isWrapperOnly(trimmed))) {
    return draft(rec, 'user', 'meta', blocks, { synthetic: true });
  }
  if (rec.isCompactSummary === true) {
    return draft(rec, 'user', 'detail', blocks, { synthetic: true });
  }
  if (!hasNonText && trimmed.startsWith('[Request interrupted by user')) {
    return draft(rec, 'system', 'detail', [notice('info', 'interrupted', trimmed)]);
  }
  return draft(rec, 'user', 'conversation', blocks);
}

function convertUser(rec: Rec): Draft[] {
  const msg = isObj(rec.message) ? rec.message : {};
  const content = msg.content;
  if (typeof content === 'string') return [userText(rec, [textBlock(content)])];
  if (!Array.isArray(content)) return [draft(rec, 'user', 'meta', [raw('user', rec)], { synthetic: true })];

  const toolBlocks: Block[] = [];
  const other: Block[] = [];
  for (const b of content) {
    if (isObj(b) && b.type === 'tool_result') toolBlocks.push(toolResultBlock(b));
    else other.push(contentBlock(b));
  }
  const out: Draft[] = [];
  if (toolBlocks.length) out.push(draft(rec, 'tool', 'detail', toolBlocks));
  if (other.length || !toolBlocks.length) out.push(userText(rec, other));
  return out;
}

function convertAssistant(rec: Rec): Draft[] {
  const msg = isObj(rec.message) ? rec.message : {};
  const content = msg.content;
  const blocks: Block[] = [];
  let hasText = false;
  const items = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
  for (const b of items) {
    if (!isObj(b)) {
      blocks.push(raw('block', b));
      continue;
    }
    switch (b.type) {
      case 'text': {
        const t = str(b.text) ?? '';
        if (t.trim()) hasText = true;
        blocks.push(textBlock(t));
        break;
      }
      case 'thinking': {
        const t = str(b.thinking) ?? '';
        blocks.push({ type: 'thinking', text: t, ...(t === '' && b.signature ? { redacted: true } : {}) });
        break;
      }
      case 'redacted_thinking':
        blocks.push({ type: 'thinking', text: '', redacted: true });
        break;
      case 'tool_use':
      case 'server_tool_use':
      case 'mcp_tool_use':
        blocks.push({ type: 'tool_use', id: str(b.id) ?? '', name: str(b.name) ?? '', input: b.input });
        break;
      default:
        blocks.push(raw(`block:${str(b.type) ?? 'unknown'}`, b));
    }
  }
  const model = str(msg.model);
  return [draft(rec, 'assistant', hasText ? 'conversation' : 'detail', blocks, model ? { model } : undefined)];
}

const NOISE_ATTACHMENTS = new Set([
  'instructions',
  'deferred_tools_delta',
  'deferred_tools_record',
  'environment',
  'model',
  'skill_listing',
  'session_context',
  'date',
  'date_change',
  'credential_org',
  'remote_session_change',
  'prompt_snapshot',
  'agent_listing_delta',
  'mcp_instructions_delta',
  'auto_mode',
  'total_tokens_reminder',
  'silent_turn_reminder',
  'thinking_drop',
  'command_permissions',
  'task_reminder',
  'read_truncation_notice',
  'unknown_command_fallback',
  'plan_mode',
  'todo_reminder',
  'diagnostics',
  'ultrathink_effort',
  'output_style',
]);

function arrLen(v: unknown): number {
  return Array.isArray(v) ? v.length : 0;
}

function noiseSummary(type: string, a: Rec, rec: Rec): string {
  switch (type) {
    case 'skill_listing':
      return `skill listing (${num(a.skillCount) ?? arrLen(a.names)} skills)`;
    case 'deferred_tools_delta':
      return `deferred tools (+${arrLen(a.addedNames)} / -${arrLen(a.removedNames)})`;
    case 'deferred_tools_record':
      return `deferred tools record (${arrLen(a.entries)} entries)`;
    case 'agent_listing_delta':
      return `agent listing (+${arrLen(a.addedTypes)} / -${arrLen(a.removedTypes)})`;
    case 'mcp_instructions_delta':
      return `MCP instructions (+${arrLen(a.addedNames)} / -${arrLen(a.removedNames)})`;
    case 'instructions':
      return `instructions (${arrLen(a.files)} files)`;
    case 'date':
      return `date ${str(a.date) ?? ''}`.trim();
    case 'date_change':
      return `date changed to ${str(a.newDate) ?? '?'}`;
    case 'environment': {
      const snap = isObj(a.snapshot) ? a.snapshot : {};
      return `environment ${str(snap.workingDirectory) ?? ''}`.trim();
    }
    case 'model': {
      const id = isObj(a.identity) ? a.identity : {};
      return `model ${str(id.marketingName) ?? str(id.modelId) ?? ''}`.trim();
    }
    case 'command_permissions':
      return `command permissions (${arrLen(a.allowedTools)} tools)`;
    case 'task_reminder':
      return `task reminder (${num(a.itemCount) ?? 0} items)`;
    case 'total_tokens_reminder':
    case 'silent_turn_reminder':
    case 'read_truncation_notice': {
      const t = str(a.text) ?? str(a.banner);
      return t ? `${type}: ${clip(t, 300)}` : type;
    }
    default: {
      const rendered = Array.isArray(rec.rendered) ? rec.rendered : [];
      const first = rendered[0];
      const t = isObj(first) ? str(first.content) : undefined;
      return t ? `${type}: ${clip(t.replace(/\s+/g, ' '), 200)}` : type;
    }
  }
}

function convertAttachment(rec: Rec): Draft[] {
  const a = isObj(rec.attachment) ? rec.attachment : undefined;
  if (!a) return [draft(rec, 'system', 'meta', [raw('attachment', rec)])];
  const type = str(a.type) ?? 'unknown';

  switch (type) {
    case 'file': {
      const content = isObj(a.content) ? a.content : {};
      const file = isObj(content.file) ? content.file : {};
      const snippetSrc = str(file.content) ?? (typeof a.content === 'string' ? a.content : undefined);
      const path = str(a.filename) ?? str(file.filePath) ?? str(a.displayPath) ?? '';
      const ref: FileRefBlock = {
        type: 'file_ref',
        path,
        role: 'mention',
        ...(str(a.displayPath) ? { label: str(a.displayPath) } : {}),
        ...(snippetSrc ? { snippet: clip(snippetSrc, 2000) } : {}),
      };
      // User-provided file context: 'detail' so it is visible (collapsed) in the default view.
      return [draft(rec, 'system', 'detail', [ref])];
    }
    case 'at_mention_reference': {
      const mentions = Array.isArray(a.mentions) ? a.mentions.filter((m): m is string => typeof m === 'string') : [];
      const path = str(a.displayPath) ?? mentions[0] ?? '';
      const ref: FileRefBlock = { type: 'file_ref', path, role: 'mention' };
      if (mentions.length) ref.label = mentions.join(', ');
      return [draft(rec, 'system', 'detail', [ref])];
    }
    case 'directory': {
      const c = str(a.content);
      const ref: FileRefBlock = {
        type: 'file_ref',
        path: str(a.path) ?? str(a.displayPath) ?? '',
        role: 'directory',
        ...(str(a.displayPath) ? { label: str(a.displayPath) } : {}),
        ...(c ? { snippet: clip(c, 2000) } : {}),
      };
      return [draft(rec, 'system', 'detail', [ref])];
    }
    case 'edited_text_file': {
      const sn = str(a.snippet);
      const ref: FileRefBlock = {
        type: 'file_ref',
        path: str(a.filename) ?? '',
        role: 'edited',
        ...(sn ? { snippet: clip(sn, 2000) } : {}),
      };
      return [draft(rec, 'system', 'meta', [ref])];
    }
    case 'compact_file_reference': {
      const ref: FileRefBlock = {
        type: 'file_ref',
        path: str(a.filename) ?? str(a.displayPath) ?? '',
        role: 'mention',
        ...(str(a.displayPath) ? { label: str(a.displayPath) } : {}),
      };
      return [draft(rec, 'system', 'meta', [ref])];
    }
    case 'nested_memory': {
      const ref: FileRefBlock = {
        type: 'file_ref',
        path: str(a.path) ?? str(a.displayPath) ?? '',
        role: 'memory',
        ...(str(a.displayPath) ? { label: str(a.displayPath) } : {}),
      };
      return [draft(rec, 'system', 'meta', [ref])];
    }
    case 'queued_command': {
      const prompt = a.prompt;
      let blocks: Block[];
      if (typeof prompt === 'string') blocks = [textBlock(prompt)];
      else if (Array.isArray(prompt)) blocks = prompt.map(contentBlock);
      else blocks = [raw('attachment:queued_command', a)];
      const origin = isObj(a.origin) ? str(a.origin.kind) : undefined;
      const forceMeta = a.commandMode === 'task-notification' || (origin !== undefined && origin.includes('task'));
      return [userText(rec, blocks, { forceMeta })];
    }
    default:
      break;
  }

  if (type.startsWith('hook_')) {
    const name = str(a.hookName) ?? str(a.hookEvent) ?? type;
    const out = str(a.stdout) ?? (Array.isArray(a.content) ? a.content.filter((x) => typeof x === 'string').join('\n') : str(a.content));
    const level = type === 'hook_cancelled' || (num(a.exitCode) ?? 0) !== 0 ? 'warning' : 'info';
    const text = `${type.slice(5)}: ${name}${out ? ` — ${clip(out.trim(), 2000)}` : ''}`;
    return [draft(rec, 'system', 'meta', [notice(level, 'hook', text)])];
  }

  if (NOISE_ATTACHMENTS.has(type)) {
    return [draft(rec, 'system', 'meta', [notice('info', `attachment:${type}`, noiseSummary(type, a, rec))])];
  }
  return [draft(rec, 'system', 'meta', [raw(`attachment:${type}`, a)])];
}

function convertSystem(rec: Rec): Draft[] {
  const sub = str(rec.subtype) ?? 'unknown';
  const content = str(rec.content);
  switch (sub) {
    case 'compact_boundary': {
      const md = isObj(rec.compactMetadata) ? rec.compactMetadata : {};
      const pre = num(md.preTokens);
      const trigger = str(md.trigger);
      const text = `${content ?? 'Conversation compacted'}${trigger ? ` (${trigger}` : ''}${
        pre !== undefined ? `${trigger ? ', ' : ' ('}${pre} tokens before` : ''
      }${trigger || pre !== undefined ? ')' : ''}`;
      return [draft(rec, 'system', 'conversation', [notice('info', 'compact', text)])];
    }
    case 'api_error': {
      const err = isObj(rec.error) ? rec.error : {};
      const conn = isObj(err.connection) ? err.connection : {};
      let text = str(err.formatted) ?? str(err.message) ?? str(conn.message) ?? 'API error';
      const attempt = num(rec.retryAttempt);
      const max = num(rec.maxRetries);
      if (attempt !== undefined && max !== undefined) text += ` (retry ${attempt}/${max})`;
      return [draft(rec, 'system', 'detail', [notice('error', 'api_error', clip(text, 2000))])];
    }
    case 'model_refusal_fallback': {
      const text =
        content ??
        `Model refusal fallback${str(rec.originalModel) ? ` from ${str(rec.originalModel)}` : ''}${
          str(rec.fallbackModel) ? ` to ${str(rec.fallbackModel)}` : ''
        }`;
      return [draft(rec, 'system', 'detail', [notice('warning', 'model_refusal_fallback', clip(text, 2000))])];
    }
    case 'local_command':
      return [draft(rec, 'system', 'detail', [notice('info', 'local_command', clip(content ?? '', 4000))])];
    case 'turn_duration': {
      const ms = num(rec.durationMs);
      const n = num(rec.messageCount);
      return [
        draft(rec, 'system', 'meta', [
          notice('info', 'turn_duration', `Turn took ${ms !== undefined ? `${Math.round(ms / 100) / 10}s` : '?'}${n !== undefined ? `, ${n} messages` : ''}`),
        ]),
      ];
    }
    case 'stop_hook_summary': {
      const n = num(rec.hookCount) ?? arrLen(rec.hookInfos);
      const errs = arrLen(rec.hookErrors);
      return [
        draft(rec, 'system', 'meta', [
          notice(errs ? 'warning' : 'info', 'stop_hook_summary', `${n} stop hook(s)${errs ? `, ${errs} error(s)` : ''}`),
        ]),
      ];
    }
    default:
      return [draft(rec, 'system', 'meta', [notice('info', sub, clip(content ?? sub, 2000))])];
  }
}

/**
 * Convert one parsed record into zero or more event drafts. Bookkeeping
 * records return []. Never throws.
 */
export function convertRecord(rec: Rec): Draft[] {
  try {
    const type = str(rec.type);
    if (type === undefined) return [draft(rec, 'system', 'meta', [raw('unknown', rec)])];
    if (isBookkeeping(type)) return [];
    switch (type) {
      case 'user':
        return convertUser(rec);
      case 'assistant':
        return convertAssistant(rec);
      case 'attachment':
        return convertAttachment(rec);
      case 'system':
        return convertSystem(rec);
      case 'summary': {
        const text = str(rec.summary) ?? '';
        return [draft(rec, 'system', 'conversation', [notice('info', 'summary', text)])];
      }
      default:
        return [draft(rec, 'system', 'meta', [raw(type, rec)])];
    }
  } catch (err) {
    return [draft(rec, 'system', 'meta', [raw('error', { message: String(err) })])];
  }
}

/** Parse a raw line into a record; undefined if blank or malformed. `blank` distinguishes the two. */
export function parseJson(text: string): { rec?: Rec; blank: boolean } {
  if (text.length === 0 || text.trim().length === 0) return { blank: true };
  try {
    const v: unknown = JSON.parse(text);
    if (isObj(v)) return { rec: v, blank: false };
  } catch {
    // fallthrough
  }
  return { blank: false };
}

export function materialize(
  drafts: Draft[],
  firstSeq: number,
  loc: { line: number; offset: number; length: number },
): ChatEvent[] {
  return drafts.map((d, i) => {
    assignBlobPaths(d.blocks);
    return { seq: firstSeq + i, ...d, line: loc.line, offset: loc.offset, length: loc.length };
  });
}
