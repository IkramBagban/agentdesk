import type { ChatEvent, ToolUseBlock } from './api.ts';
import { basename, plural, toolName } from './format.ts';

/**
 * Turns raw tool calls (Claude Code, Codex, MCP servers) into words a person
 * reads: "Ran 3 commands, edited App.tsx, searched the web".
 */
export type ToolKind =
  | 'command'
  | 'read'
  | 'edit'
  | 'write'
  | 'search'
  | 'web_search'
  | 'fetch'
  | 'agent'
  | 'plan'
  | 'browser'
  | 'ask'
  | 'mcp'
  | 'other';

const KIND_BY_NAME: Record<string, ToolKind> = {
  Bash: 'command',
  BashOutput: 'command',
  exec: 'command',
  exec_command: 'command',
  shell: 'command',
  shell_command: 'command',
  local_shell: 'command',
  container_exec: 'command',
  run_in_terminal: 'command',
  Read: 'read',
  NotebookRead: 'read',
  read_file: 'read',
  view_image: 'read',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  apply_patch: 'edit',
  str_replace_editor: 'edit',
  Write: 'write',
  create_file: 'write',
  Grep: 'search',
  Glob: 'search',
  LS: 'search',
  grep: 'search',
  glob: 'search',
  WebSearch: 'web_search',
  web_search: 'web_search',
  WebFetch: 'fetch',
  web_fetch: 'fetch',
  Task: 'agent',
  Agent: 'agent',
  TodoWrite: 'plan',
  update_plan: 'plan',
  AskUserQuestion: 'ask',
};

const BROWSER_SERVERS = /^(Claude_Browser|claude-in-chrome|playwright|puppeteer|browser|chrome-devtools)/i;

export function toolKind(raw: string): ToolKind {
  const direct = KIND_BY_NAME[raw];
  if (direct) return direct;
  const { name, server } = toolName(raw);
  if (raw.startsWith('mcp__')) {
    const k = KIND_BY_NAME[name];
    if (k) return k;
    if (BROWSER_SERVERS.test(server ?? '') || BROWSER_SERVERS.test(raw.slice(5))) return 'browser';
    return 'mcp';
  }
  return 'other';
}

function obj(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

/** The shell command of a command-like call. */
export function commandOf(b: ToolUseBlock): string | undefined {
  if (typeof b.input === 'string') return b.input;
  const o = obj(b.input);
  const c = o.command ?? o.cmd;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    // Codex: ["bash", "-lc", "<script>"]
    const parts = c.map(String);
    if (parts.length === 3 && /(^|\/)(ba|z)?sh$/.test(parts[0]!) && parts[1] === '-lc') return parts[2];
    return parts.join(' ');
  }
  return undefined;
}

export function filePathOf(b: ToolUseBlock): string | undefined {
  const o = obj(b.input);
  return str(o.file_path) ?? str(o.path) ?? str(o.notebook_path) ?? str(o.filePath);
}

export interface EditPair {
  oldText: string;
  newText: string;
}

/** old/new pairs for Edit and MultiEdit. */
export function editsOf(b: ToolUseBlock): EditPair[] {
  const o = obj(b.input);
  if (typeof o.old_string === 'string' || typeof o.new_string === 'string')
    return [{ oldText: String(o.old_string ?? ''), newText: String(o.new_string ?? '') }];
  if (Array.isArray(o.edits))
    return o.edits.map((e) => {
      const x = obj(e);
      return { oldText: String(x.old_string ?? ''), newText: String(x.new_string ?? '') };
    });
  return [];
}

/** A unified-diff patch (Codex apply_patch). */
export function patchOf(b: ToolUseBlock): string | undefined {
  if (typeof b.input === 'string' && /^\*\*\* Begin Patch|^(---|\+\+\+|@@) /m.test(b.input)) return b.input;
  const o = obj(b.input);
  return str(o.patch) ?? str(o.input);
}

function lineCount(s: string): number {
  if (!s) return 0;
  return s.replace(/\n$/, '').split('\n').length;
}

/** +added / −removed line counts for edits and writes (rough, by line). */
export function lineStats(b: ToolUseBlock): { added: number; removed: number } | undefined {
  const kind = toolKind(b.name);
  if (kind === 'write') {
    const c = str(obj(b.input).content);
    return c != null ? { added: lineCount(c), removed: 0 } : undefined;
  }
  if (kind !== 'edit') return undefined;
  const patch = patchOf(b);
  if (patch) {
    let added = 0;
    let removed = 0;
    for (const l of patch.split('\n')) {
      if (l.startsWith('+') && !l.startsWith('+++')) added++;
      else if (l.startsWith('-') && !l.startsWith('---')) removed++;
    }
    return { added, removed };
  }
  const edits = editsOf(b);
  if (!edits.length) return undefined;
  let added = 0;
  let removed = 0;
  for (const e of edits) {
    const d = diffLines(e.oldText, e.newText);
    for (const l of d) if (l.op === '+') added++;
    else if (l.op === '-') removed++;
  }
  return { added, removed };
}

/** Files touched by a patch: "*** Update File: a/b.ts" or "+++ b/a/b.ts". */
function patchFiles(patch: string): string[] {
  const out = new Set<string>();
  for (const m of patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) out.add(m[1]!.trim());
  if (!out.size) for (const m of patch.matchAll(/^\+\+\+ (?:b\/)?(.+)$/gm)) if (m[1] !== '/dev/null') out.add(m[1]!.trim());
  return [...out];
}

export function touchedFiles(b: ToolUseBlock): string[] {
  const p = filePathOf(b);
  if (p) return [p];
  const patch = patchOf(b);
  return patch ? patchFiles(patch) : [];
}

function host(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '') + (u.pathname.length > 1 ? u.pathname : '');
  } catch {
    return url;
  }
}

/** "notion-fetch" / "fetch_meeting_notes" → "notion fetch" / "fetch meeting notes" */
export function humanize(s: string): string {
  return s
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
}

/** Readable name for an MCP server or tool. */
export function serverLabel(raw: string): string {
  const { name, server } = toolName(raw);
  if (!server) {
    // Servers registered under an opaque id: "notion-fetch" → "Notion".
    const prefix = /^([a-z][a-z0-9]+)-/.exec(name)?.[1];
    return prefix ? prefix.charAt(0).toUpperCase() + prefix.slice(1) : humanize(name);
  }
  if (/^Claude_Browser$/i.test(server)) return 'the browser';
  if (/claude-in-chrome/i.test(server)) return 'Chrome';
  if (/^ccd_/.test(server)) return 'the app';
  return humanize(server);
}

export interface CallView {
  kind: ToolKind;
  /** Verb phrase for a row: "Ran", "Edited", ... */
  verb: string;
  /** What it acted on: a file name, a command, a query */
  target?: string;
  /** monospace target (commands, paths, patterns) */
  mono?: boolean;
  /** muted description shown instead of / before the target */
  title?: string;
}

/** One-row description of a single call. */
export function describeCall(b: ToolUseBlock): CallView {
  const kind = toolKind(b.name);
  const o = obj(b.input);
  const { name } = toolName(b.name);
  switch (kind) {
    case 'command': {
      const cmd = commandOf(b)?.trim();
      return { kind, verb: 'Ran', target: cmd?.split('\n')[0], mono: true, title: str(o.description) };
    }
    case 'read':
      return { kind, verb: 'Read', target: basenameOrPath(filePathOf(b)), mono: true };
    case 'edit': {
      const files = touchedFiles(b);
      return { kind, verb: 'Edited', target: files.length > 1 ? plural(files.length, 'file') : basenameOrPath(files[0]), mono: files.length === 1 };
    }
    case 'write':
      return { kind, verb: 'Wrote', target: basenameOrPath(filePathOf(b)), mono: true };
    case 'search': {
      const pattern = str(o.pattern) ?? str(o.query) ?? str(o.glob);
      const where = str(o.path);
      return { kind, verb: name === 'LS' ? 'Listed' : 'Searched', target: pattern ?? (where ? basename(where) : undefined), mono: true };
    }
    case 'web_search':
      return { kind, verb: 'Searched the web', target: str(o.query) ?? (typeof b.input === 'string' ? b.input : undefined) };
    case 'fetch':
      return { kind, verb: 'Fetched', target: str(o.url) ? host(o.url as string) : undefined, mono: true };
    case 'agent':
      return { kind, verb: 'Helper agent', target: str(o.description) ?? str(o.subagent_type) };
    case 'plan':
      return { kind, verb: 'Updated the plan' };
    case 'ask':
      return { kind, verb: 'Asked a question' };
    case 'browser': {
      const target = str(o.url) ?? str(o.action) ?? str(o.query) ?? (str(o.text)?.split('\n')[0]);
      return { kind, verb: humanize(name).replace(/^./, (c) => c.toUpperCase()), target, mono: !!str(o.text) && !str(o.url) && !str(o.action) };
    }
    case 'mcp':
    case 'other': {
      const target = str(o.description) ?? str(o.query) ?? str(o.url) ?? str(o.title) ?? str(o.id) ?? str(o.path);
      return { kind, verb: humanize(name).replace(/^./, (c) => c.toUpperCase()), target, title: kind === 'mcp' ? serverLabel(b.name) : undefined };
    }
  }
}

function basenameOrPath(p?: string): string | undefined {
  return p ? basename(p) : undefined;
}

/* ------------------------------------------------------------------ */

export interface ActivityFacts {
  phrases: string[];
  errors: number;
  images: number;
  calls: number;
  thinking: number;
  meta: number;
  added: number;
  removed: number;
}

/** "Ran 3 commands, edited App.tsx, searched the web" */
export function summarize(events: ChatEvent[]): ActivityFacts {
  const order: ToolKind[] = [];
  const count = new Map<ToolKind, number>();
  const files = new Map<'read' | 'edit' | 'write', Set<string>>([
    ['read', new Set()],
    ['edit', new Set()],
    ['write', new Set()],
  ]);
  const others = new Map<string, number>();
  let errors = 0;
  let images = 0;
  let calls = 0;
  let thinking = 0;
  let meta = 0;
  let added = 0;
  let removed = 0;

  for (const e of events) {
    if (e.visibility === 'meta') meta++;
    for (const b of e.blocks) {
      if (b.type === 'tool_use') {
        calls++;
        const k = toolKind(b.name);
        if (!count.has(k)) order.push(k);
        count.set(k, (count.get(k) ?? 0) + 1);
        if (k === 'read' || k === 'edit' || k === 'write') for (const f of touchedFiles(b)) files.get(k)!.add(f);
        if (k === 'mcp' || k === 'other') {
          const label = k === 'mcp' ? serverLabel(b.name) : toolName(b.name).name;
          others.set(label, (others.get(label) ?? 0) + 1);
        }
        const st = lineStats(b);
        if (st) {
          added += st.added;
          removed += st.removed;
        }
      } else if (b.type === 'thinking' && b.text.trim()) thinking++;
      else if (b.type === 'tool_result') {
        if (b.isError) errors++;
        images += b.content.filter((c) => c.type === 'image').length;
      } else if (b.type === 'image') images++;
    }
  }

  const fileWord = (k: 'read' | 'edit' | 'write', verb: string) => {
    const set = files.get(k)!;
    const n = set.size || (count.get(k) ?? 0);
    return set.size === 1 ? `${verb} ${basename([...set][0]!)}` : `${verb} ${plural(n, 'file')}`;
  };

  const phrases: string[] = [];
  let usedOthers = false;
  for (const k of order) {
    const n = count.get(k)!;
    switch (k) {
      case 'command':
        phrases.push(n === 1 ? 'ran a command' : `ran ${n} commands`);
        break;
      case 'read':
        phrases.push(fileWord('read', 'read'));
        break;
      case 'edit':
        phrases.push(fileWord('edit', 'edited'));
        break;
      case 'write':
        phrases.push(fileWord('write', 'wrote'));
        break;
      case 'search':
        phrases.push(n === 1 ? 'searched files' : `searched files ${n} times`);
        break;
      case 'web_search':
        phrases.push('searched the web');
        break;
      case 'fetch':
        phrases.push(n === 1 ? 'read a web page' : `read ${n} web pages`);
        break;
      case 'agent':
        phrases.push(n === 1 ? 'ran a helper agent' : `ran ${n} helper agents`);
        break;
      case 'plan':
        phrases.push('updated the plan');
        break;
      case 'ask':
        phrases.push('asked a question');
        break;
      case 'browser':
        phrases.push('used the browser');
        break;
      case 'mcp':
      case 'other': {
        if (usedOthers) break;
        usedOthers = true;
        const labels = [...others.keys()];
        phrases.push(labels.length <= 2 ? `used ${labels.join(' and ')}` : `used ${labels.length} other tools`);
        break;
      }
    }
  }
  if (!phrases.length) {
    if (thinking) phrases.push('thought it through');
    else if (meta) phrases.push(plural(meta, 'background record'));
    else phrases.push(plural(events.length, 'item'));
  }
  return { phrases, errors, images, calls, thinking, meta, added, removed };
}

export function sentence(phrases: string[], max = 4): string {
  const shown = phrases.slice(0, max);
  let s = shown.join(', ');
  if (phrases.length > max) s += ` and ${phrases.length - max} more`;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/* ------------------------------------------------------------------ */

export type DiffLine = { op: ' ' | '+' | '-'; text: string };

/** Line diff (LCS) for small inputs; falls back to remove-all/add-all. */
export function diffLines(a: string, b: string): DiffLine[] {
  const x = a ? a.replace(/\n$/, '').split('\n') : [];
  const y = b ? b.replace(/\n$/, '').split('\n') : [];
  if (x.length * y.length > 250_000) return [...x.map((t) => ({ op: '-' as const, text: t })), ...y.map((t) => ({ op: '+' as const, text: t }))];
  const n = x.length;
  const m = y.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = x[i] === y[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) (out.push({ op: ' ', text: x[i]! }), i++, j++);
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push({ op: '-', text: x[i++]! });
    else out.push({ op: '+', text: y[j++]! });
  }
  while (i < n) out.push({ op: '-', text: x[i++]! });
  while (j < m) out.push({ op: '+', text: y[j++]! });
  return out;
}

export function langOf(path?: string): string | undefined {
  const ext = path?.split('.').at(-1)?.toLowerCase();
  if (!ext) return undefined;
  const map: Record<string, string> = { mjs: 'js', cjs: 'js', mts: 'ts', cts: 'ts', sh: 'bash', zsh: 'bash', yml: 'yaml', md: 'markdown', py: 'python', rs: 'rust' };
  return map[ext] ?? ext;
}
