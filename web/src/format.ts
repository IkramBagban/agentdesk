const dayFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const yearFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const fullFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function relDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return timeFmt.format(d);
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.getFullYear() === now.getFullYear() ? dayFmt.format(d) : yearFmt.format(d);
}

export function fullDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : fullFmt.format(d);
}

export function time(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : timeFmt.format(d);
}

export function bytes(n?: number): string {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function usd(n?: number): string {
  if (n == null) return '';
  return n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`;
}

export function tokens(n?: number): string {
  if (n == null) return '';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Chats run in throwaway scratch folders (e.g. Claude desktop's quick chats). */
export function isScratch(s: { projectPath?: string; projectKey: string }): boolean {
  const p = s.projectPath ?? s.projectKey;
  return /scratch-workspaces|[\\/]scratch-\d{4}-\d{2}-\d{2}/.test(p) || /-scratch-\d{4}-\d{2}-\d{2}-/.test(s.projectKey);
}

/** Display name of a session's project, with scratch folders named as such. */
export function projectLabel(s: { projectPath?: string; projectKey: string }): string {
  return isScratch(s) ? 'Scratch chat' : projectName(s.projectPath, s.projectKey);
}

/** "-Users-alice-code-demo-app" / "/Users/alice/code/demo-app" → "demo-app" */
export function projectName(path?: string, key?: string): string {
  const p = path ?? key?.replace(/^[^:]+:/, '') ?? '';
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? p;
}

export function sourceLabel(id: string): string {
  return id === 'claude-code' ? 'Claude Code' : id === 'codex' ? 'Codex' : id;
}

/** One-line description of a tool call input. */
export function toolSummary(name: string, input: unknown): string {
  if (input == null || typeof input !== 'object') return typeof input === 'string' ? input : '';
  const o = input as Record<string, unknown>;
  const pick = (...keys: string[]) => {
    for (const k of keys) if (typeof o[k] === 'string' && o[k]) return o[k] as string;
    return undefined;
  };
  const s =
    pick('description') ??
    pick('command', 'cmd') ??
    pick('file_path', 'path', 'notebook_path') ??
    pick('pattern', 'query', 'q', 'url', 'prompt', 'skill', 'subject') ??
    (Array.isArray(o.command) ? (o.command as unknown[]).join(' ') : undefined);
  if (s) return s.split('\n')[0]!.slice(0, 200);
  const first = Object.entries(o).find(([, v]) => typeof v === 'string' || typeof v === 'number');
  return first ? `${first[0]}: ${String(first[1]).slice(0, 160)}` : name;
}

/** "mcp__<server>__<tool>" → { name: tool, server }; servers that are bare UUIDs are dropped. */
export function toolName(raw: string): { name: string; server?: string } {
  const m = /^mcp__(.+?)__(.+)$/.exec(raw);
  if (!m) return { name: raw };
  const server = m[1]!;
  return { name: m[2]!, server: /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(server) ? undefined : server.replace(/^plugin_/, '') };
}

const sepDayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const sepYearFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

/** "Today at 15:20" / "Yesterday at 9:02" / "Sun 25 Oct at 15:20" (year added when not this year). */
export function separatorDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  const day =
    d.toDateString() === now.toDateString()
      ? 'Today'
      : d.toDateString() === y.toDateString()
        ? 'Yesterday'
        : d.getFullYear() === now.getFullYear()
          ? sepDayFmt.format(d)
          : sepYearFmt.format(d);
  return `${day} at ${timeFmt.format(d)}`;
}

/** Milliseconds between two ISO timestamps, or undefined. */
export function span(a?: string, b?: string): number | undefined {
  if (!a || !b) return undefined;
  const ms = Date.parse(b) - Date.parse(a);
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

/** 4210 → "4s", 250000 → "4m 10s", 7_500_000 → "2h 5m" */
export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Last path segment: "/a/b/c.ts" → "c.ts" */
export function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).at(-1) ?? p;
}

/** "/Users/me/x" → "~/x" for display. */
export function tildify(p: string): string {
  return p.replace(/^\/(?:Users|home)\/[^/]+/, '~');
}
