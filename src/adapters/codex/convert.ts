/**
 * Pure record -> event-draft conversion for Codex rollout files.
 * Shared by the stateful parser and the stateless `parseLine`, so both
 * always agree on what a line produces.
 *
 * Duplicate handling: Codex logs the same content as `response_item` AND as
 * `event_msg` (`item_completed` UserMessage/AgentMessage/Reasoning/McpToolCall/
 * CommandExecution, or the legacy `user_message`/`agent_message`/...).
 * `response_item` is canonical; the event_msg copies produce no events.
 */
import type { Block, ImageBlock, Role, Visibility } from '../../core/types.ts';

export type Rec = Record<string, unknown>;

export interface Draft {
  uuid?: string;
  role: Role;
  visibility: Visibility;
  timestamp?: string;
  synthetic?: boolean;
  blocks: Block[];
}

export const RAW_LIMIT = 20 * 1024;

export function isObj(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export function rawBlock(recordType: string, json: unknown): Block {
  let s: string | undefined;
  try {
    s = JSON.stringify(json);
  } catch {
    s = undefined;
  }
  if (s !== undefined && s.length > RAW_LIMIT) {
    return {
      type: 'raw',
      recordType,
      json: { truncated: true, fullLength: s.length, preview: s.slice(0, RAW_LIMIT) },
    };
  }
  return { type: 'raw', recordType, json };
}

function tryParseJson(s: string): unknown {
  const t = s.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return s;
  try {
    return JSON.parse(t);
  } catch {
    return s;
  }
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

function imageFromUrl(url: string, blobPath: string): Block {
  const m = /^data:([^;,]+)?((?:;[^;,]+)*?),(.*)$/s.exec(url);
  if (m) {
    const mediaType = m[1] || 'application/octet-stream';
    const isB64 = (m[2] ?? '').includes('base64');
    const payload = m[3] ?? '';
    if (isB64) {
      const pad = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
      const size = Math.max(0, Math.floor((payload.length * 3) / 4) - pad);
      return { type: 'image', mediaType, size, data: payload, blobPath } satisfies ImageBlock;
    }
    try {
      const buf = Buffer.from(decodeURIComponent(payload), 'binary');
      return {
        type: 'image',
        mediaType,
        size: buf.length,
        data: buf.toString('base64'),
        blobPath,
      } satisfies ImageBlock;
    } catch {
      return { type: 'text', text: '[image: undecodable data URL]' };
    }
  }
  let path: string | undefined;
  if (url.startsWith('file://')) {
    try {
      path = decodeURIComponent(new URL(url).pathname);
    } catch {
      path = undefined;
    }
  } else if (url.startsWith('/')) {
    path = url;
  }
  if (path) {
    return { type: 'image', mediaType: mediaFromPath(path), size: 0, filePath: path };
  }
  return { type: 'text', text: `[image: ${url.slice(0, 500)}]` };
}

function mediaFromPath(p: string): string {
  const ext = p.slice(p.lastIndexOf('.') + 1).toLowerCase();
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
  };
  return map[ext] ?? 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// Content parts
// ---------------------------------------------------------------------------

/**
 * Convert an array of Codex content parts into blocks. `pathPrefix` is the
 * dotted blobPath prefix of this array inside the event ('' for top level,
 * '0.content.' for a tool_result at blocks[0]).
 */
function partsToBlocks(parts: unknown[], pathPrefix: string): Block[] {
  const out: Block[] = [];
  parts.forEach((part, i) => {
    if (typeof part === 'string') {
      out.push({ type: 'text', text: part });
      return;
    }
    if (!isObj(part)) {
      out.push(rawBlock('content_part', part));
      return;
    }
    const t = str(part.type);
    if ((t === 'input_text' || t === 'output_text' || t === 'text') && typeof part.text === 'string') {
      out.push({ type: 'text', text: part.text });
    } else if (t === 'refusal' && typeof part.refusal === 'string') {
      out.push({ type: 'text', text: part.refusal });
    } else if (t === 'input_image' || t === 'output_image' || t === 'image') {
      const url = str(part.image_url) ?? (isObj(part.image_url) ? str(part.image_url.url) : undefined);
      if (url) out.push(imageFromUrl(url, `${pathPrefix}${i}`));
      else out.push(rawBlock(t, part));
    } else {
      out.push(rawBlock(t ?? 'content_part', part));
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

const INJECTED_PREFIXES = [
  '<environment_context>',
  '# AGENTS.md instructions',
  '<user_instructions>',
  '<INSTRUCTIONS>',
  '<skill>',
  '<skills_instructions>',
  '<external_codex_apps_open_page>',
  '<turn_aborted>',
  '<user_shell_command>',
  '<send_user_message',
  '<permissions instructions>',
  '<collaboration_mode>',
];

function firstText(parts: unknown[]): string {
  for (const p of parts) {
    if (isObj(p) && typeof p.text === 'string') return p.text;
  }
  return '';
}

function isInjectedUser(p: Rec, parts: unknown[]): boolean {
  const md = p.internal_chat_message_metadata_passthrough;
  if (isObj(md) && Array.isArray(md.content_item_kinds) && md.content_item_kinds.length > 0) {
    return !md.content_item_kinds.includes('user.text');
  }
  const t = firstText(parts).trimStart();
  return INJECTED_PREFIXES.some((pre) => t.startsWith(pre));
}

const PASTED_RE = /^## ".*": (\/.+)$/gm;

function pastedFileRefs(text: string): Block[] {
  if (!text.includes('# Files pasted by the user')) return [];
  const out: Block[] = [];
  for (const m of text.matchAll(PASTED_RE)) {
    if (m[1]) out.push({ type: 'file_ref', path: m[1].trim(), role: 'attachment' });
  }
  return out;
}

function convertMessage(p: Rec, ts: string | undefined): Draft[] {
  const role = str(p.role) ?? 'user';
  const parts: unknown[] = Array.isArray(p.content)
    ? p.content
    : typeof p.content === 'string'
      ? [p.content]
      : [];
  const blocks = partsToBlocks(parts, '');
  if (blocks.length === 0) return [];
  const uuid = str(p.id);
  const base = { ...(uuid ? { uuid } : {}), ...(ts ? { timestamp: ts } : {}) };
  if (role === 'assistant') {
    return [{ ...base, role: 'assistant', visibility: 'conversation', blocks }];
  }
  if (role === 'developer' || role === 'system') {
    return [{ ...base, role: 'system', visibility: 'meta', blocks }];
  }
  // user (or unknown role treated as user)
  if (isInjectedUser(p, parts)) {
    return [{ ...base, role: 'user', visibility: 'meta', synthetic: true, blocks }];
  }
  for (const part of parts) {
    if (isObj(part) && typeof part.text === 'string') blocks.push(...pastedFileRefs(part.text));
  }
  return [{ ...base, role: 'user', visibility: 'conversation', blocks }];
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function toolName(p: Rec): string {
  const name = str(p.name) ?? 'unknown';
  const ns = str(p.namespace);
  if (!ns) return name;
  return ns.startsWith('mcp__') ? `${ns}__${name}` : `${ns}.${name}`;
}

function toolUseDraft(id: string, name: string, input: unknown, ts: string | undefined, uuid?: string): Draft {
  return {
    ...(uuid ? { uuid } : {}),
    ...(ts ? { timestamp: ts } : {}),
    role: 'assistant',
    visibility: 'detail',
    blocks: [{ type: 'tool_use', id, name, input }],
  };
}

function convertToolOutput(p: Rec, ts: string | undefined): Draft[] {
  const callId = str(p.call_id) ?? str(p.id) ?? '';
  const out = p.output;
  let content: Block[];
  let isError: boolean | undefined;
  if (Array.isArray(out)) {
    content = partsToBlocks(out, '0.content.');
  } else if (typeof out === 'string') {
    // legacy shape: JSON string {"output": "...", "metadata": {"exit_code": 0}}
    const parsed = tryParseJson(out);
    if (isObj(parsed) && typeof parsed.output === 'string') {
      content = [{ type: 'text', text: parsed.output }];
      const md = parsed.metadata;
      if (isObj(md) && typeof md.exit_code === 'number' && md.exit_code !== 0) isError = true;
    } else {
      content = [{ type: 'text', text: out }];
    }
  } else if (isObj(out) && typeof out.content === 'string') {
    content = [{ type: 'text', text: out.content }];
    if (out.success === false) isError = true;
  } else if (out === undefined || out === null) {
    content = [];
  } else {
    content = [rawBlock('tool_output', out)];
  }
  const uuid = str(p.id);
  return [
    {
      ...(uuid ? { uuid } : {}),
      ...(ts ? { timestamp: ts } : {}),
      role: 'tool',
      visibility: 'detail',
      blocks: [{ type: 'tool_result', toolUseId: callId, ...(isError ? { isError } : {}), content }],
    },
  ];
}

function convertReasoning(p: Rec, ts: string | undefined): Draft[] {
  const texts: string[] = [];
  for (const key of ['summary', 'content'] as const) {
    const arr = p[key];
    if (!Array.isArray(arr)) continue;
    for (const s of arr) {
      if (typeof s === 'string') texts.push(s);
      else if (isObj(s) && typeof s.text === 'string') texts.push(s.text);
    }
  }
  const text = texts.filter((t) => t.length > 0).join('\n\n');
  const uuid = str(p.id);
  const base = { ...(uuid ? { uuid } : {}), ...(ts ? { timestamp: ts } : {}) };
  if (text) {
    return [{ ...base, role: 'assistant', visibility: 'detail', blocks: [{ type: 'thinking', text }] }];
  }
  if (typeof p.encrypted_content === 'string' && p.encrypted_content.length > 0) {
    return [
      {
        ...base,
        role: 'assistant',
        visibility: 'detail',
        blocks: [{ type: 'thinking', text: '', redacted: true }],
      },
    ];
  }
  return [];
}

function flattenToolNames(tools: unknown, out: string[] = []): string[] {
  if (!Array.isArray(tools)) return out;
  for (const t of tools) {
    if (!isObj(t)) continue;
    if (t.type === 'namespace') flattenToolNames(t.tools, out);
    else if (typeof t.name === 'string') out.push(t.name);
  }
  return out;
}

function convertResponseItem(p: Rec, ts: string | undefined): Draft[] {
  const t = str(p.type);
  switch (t) {
    case 'message':
      return convertMessage(p, ts);
    case 'reasoning':
      return convertReasoning(p, ts);
    case 'function_call': {
      const id = str(p.call_id) ?? str(p.id) ?? '';
      const args = typeof p.arguments === 'string' ? tryParseJson(p.arguments) : p.arguments;
      return [toolUseDraft(id, toolName(p), args, ts, str(p.id))];
    }
    case 'custom_tool_call': {
      const id = str(p.call_id) ?? str(p.id) ?? '';
      return [toolUseDraft(id, toolName(p), p.input, ts, str(p.id))];
    }
    case 'local_shell_call': {
      const id = str(p.call_id) ?? str(p.id) ?? '';
      return [toolUseDraft(id, 'local_shell', p.action, ts, str(p.id))];
    }
    case 'web_search_call': {
      const id = str(p.id) ?? str(p.call_id) ?? '';
      return [toolUseDraft(id, 'web_search', p.action ?? { status: p.status }, ts, str(p.id))];
    }
    case 'function_call_output':
    case 'custom_tool_call_output':
    case 'local_shell_call_output':
      return convertToolOutput(p, ts);
    case 'additional_tools': {
      const names = flattenToolNames(p.tools);
      const shown = names.slice(0, 60).join(', ');
      return [
        {
          ...(str(p.id) ? { uuid: str(p.id) as string } : {}),
          ...(ts ? { timestamp: ts } : {}),
          role: 'system',
          visibility: 'meta',
          blocks: [
            {
              type: 'notice',
              level: 'info',
              kind: 'tools',
              text: `Tools available (${names.length}): ${shown}${names.length > 60 ? ', ...' : ''}`,
            },
          ],
        },
      ];
    }
    default:
      return [metaRaw(`response_item:${t ?? 'unknown'}`, p, ts)];
  }
}

function metaRaw(recordType: string, json: unknown, ts: string | undefined): Draft {
  return {
    ...(ts ? { timestamp: ts } : {}),
    role: 'system',
    visibility: 'meta',
    blocks: [rawBlock(recordType, json)],
  };
}

// ---------------------------------------------------------------------------
// event_msg
// ---------------------------------------------------------------------------

/** event_msg types that only duplicate response_items, or are pure bookkeeping. */
const IGNORED_EVENT_MSG = new Set([
  'task_started',
  'token_count',
  'thread_settings_applied',
  'user_message',
  'agent_message',
  'agent_message_delta',
  'agent_message_content_delta',
  'agent_reasoning',
  'agent_reasoning_delta',
  'agent_reasoning_raw_content',
  'agent_reasoning_raw_content_delta',
  'agent_reasoning_section_break',
  'reasoning_content_delta',
  'exec_command_begin',
  'exec_command_end',
  'exec_command_output_delta',
  'mcp_tool_call_begin',
  'mcp_tool_call_end',
  'web_search_begin',
  'web_search_end',
  'patch_apply_begin',
  'patch_apply_end',
  'item_started',
  'turn_diff',
  'session_configured',
  'mcp_startup_update',
  'mcp_startup_complete',
  'shutdown_complete',
  'thread_name_updated',
  'context_compacted',
  'background_event',
]);

/** item_completed item types that duplicate a response_item. */
const DUPLICATE_ITEMS = new Set([
  'UserMessage',
  'AgentMessage',
  'Reasoning',
  'McpToolCall',
  'CommandExecution',
  'ContextCompaction',
]);

function convertItemCompleted(p: Rec, ts: string | undefined): Draft[] {
  const item = p.item;
  if (!isObj(item)) return [metaRaw('event_msg:item_completed', p, ts)];
  const it = str(item.type);
  if (it && DUPLICATE_ITEMS.has(it)) return [];
  if (it === 'Extension' && item.kind === 'web.search') {
    const id = str(item.id) ?? '';
    const input: Rec = {};
    if (item.query !== undefined) input.query = item.query;
    if (isObj(item.action)) input.action = item.action;
    const results = Array.isArray(item.results) ? item.results : [];
    const lines = results
      .filter(isObj)
      .map((r) => `${str(r.title) ?? str(r.domain) ?? 'result'}${str(r.url) ? ` — ${str(r.url)}` : ''}`);
    return [
      toolUseDraft(id, 'web_search', input, ts),
      {
        ...(ts ? { timestamp: ts } : {}),
        role: 'tool',
        visibility: 'detail',
        blocks: [
          {
            type: 'tool_result',
            toolUseId: id,
            content: lines.length ? [{ type: 'text', text: lines.join('\n') }] : [],
          },
        ],
      },
    ];
  }
  return [metaRaw(`event_msg:item_completed:${it ?? 'unknown'}`, item, ts)];
}

function convertEventMsg(p: Rec, ts: string | undefined): Draft[] {
  const t = str(p.type);
  switch (t) {
    case 'task_complete': {
      const err = p.error;
      if (err === undefined || err === null) return [];
      const msg = isObj(err) ? (str(err.message) ?? JSON.stringify(err)) : String(err);
      const code = isObj(err) ? str(err.codex_error_info) : undefined;
      return [
        {
          ...(ts ? { timestamp: ts } : {}),
          role: 'system',
          visibility: 'conversation',
          blocks: [{ type: 'notice', level: 'error', kind: code ?? 'error', text: msg }],
        },
      ];
    }
    case 'error': {
      const msg = str(p.message) ?? 'Error';
      return [
        {
          ...(ts ? { timestamp: ts } : {}),
          role: 'system',
          visibility: 'conversation',
          blocks: [{ type: 'notice', level: 'error', kind: str(p.codex_error_info) ?? 'error', text: msg }],
        },
      ];
    }
    case 'turn_aborted': {
      const reason = str(p.reason) ?? 'aborted';
      return [
        {
          ...(ts ? { timestamp: ts } : {}),
          role: 'system',
          visibility: 'detail',
          blocks: [{ type: 'notice', level: 'warning', kind: 'interrupted', text: `Turn ${reason}` }],
        },
      ];
    }
    case 'item_completed':
      return convertItemCompleted(p, ts);
    default:
      if (t && IGNORED_EVENT_MSG.has(t)) return [];
      return [metaRaw(`event_msg:${t ?? 'unknown'}`, p, ts)];
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function convertRecord(rec: Rec): Draft[] {
  const ts = str(rec.timestamp);
  const type = str(rec.type);
  const p = rec.payload;
  switch (type) {
    case 'session_meta':
    case 'turn_context':
    case 'world_state':
    case 'token_usage_record':
      return [];
    case 'response_item':
      return isObj(p) ? convertResponseItem(p, ts) : [metaRaw('response_item', p, ts)];
    case 'event_msg':
      return isObj(p) ? convertEventMsg(p, ts) : [metaRaw('event_msg', p, ts)];
    case 'compacted':
      return [
        {
          ...(ts ? { timestamp: ts } : {}),
          role: 'system',
          visibility: 'detail',
          blocks: [{ type: 'notice', level: 'info', kind: 'compact', text: 'Conversation compacted' }],
        },
      ];
    default:
      return [metaRaw(type ?? 'unknown', rec, ts)];
  }
}

export function parseJsonLine(text: string): Rec | undefined {
  const t = text.trim();
  if (!t) return undefined;
  try {
    const v: unknown = JSON.parse(t);
    return isObj(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Plain text of a user draft's text blocks (for firstPrompt). */
export function draftText(d: Draft): string {
  return d.blocks
    .filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}
