import type { ChatEvent, ProjectMeta, SessionMeta } from '../../src/core/types.ts';

export type { ChatEvent, ProjectMeta, SessionMeta };
export type { Block, ImageBlock, ToolUseBlock, ToolResultBlock } from '../../src/core/types.ts';

export interface Status {
  version: string;
  sources: { id: string; displayName: string; roots: string[]; sessionCount: number }[];
  index: { state: 'idle' | 'indexing'; filesDone: number; filesTotal: number; sessionCount: number; lastError?: string };
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

export interface EventPage {
  items: ChatEvent[];
  total: number;
  nextFrom?: number;
  prevFrom?: number;
}

export interface SearchHit {
  sessionId: string;
  seq: number;
  sessionTitle?: string;
  projectKey: string;
  projectPath?: string;
  timestamp?: string;
  role: ChatEvent['role'];
  snippet: string;
}

export type View = 'conversation' | 'all';

/** One human prompt in a session, for the outline spine. */
export interface OutlineItem {
  seq: number;
  preview: string;
  timestamp?: string;
  offBranch: boolean;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== '') qs.set(k, String(v));
  const url = qs.size ? `${path}?${qs}` : path;
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = ((await res.json()) as { error?: string }).error ?? msg;
    } catch {
      /* not json */
    }
    throw new ApiError(res.status, msg);
  }
  return (await res.json()) as T;
}

const enc = encodeURIComponent;

export const api = {
  status: () => get<Status>('/api/status'),
  projects: (source?: string) => get<ProjectMeta[]>('/api/projects', { source }),
  sessions: (p: { source?: string; project?: string; q?: string; cursor?: string; limit?: number }) =>
    get<Page<SessionMeta>>('/api/sessions', { ...p, limit: p.limit ?? 50 }),
  session: (id: string) => get<SessionMeta & { subSessions: SessionMeta[] }>(`/api/sessions/${enc(id)}`),
  events: (id: string, p: { from: number; limit?: number; view: View; dir?: 'forward' | 'backward' }) =>
    get<EventPage>(`/api/sessions/${enc(id)}/events`, { from: p.from, limit: p.limit ?? 100, view: p.view, dir: p.dir }),
  outline: (id: string) => get<OutlineItem[]>(`/api/sessions/${enc(id)}/outline`),
  event: (id: string, seq: number) => get<ChatEvent>(`/api/sessions/${enc(id)}/events/${seq}`),
  file: (path: string) =>
    fetch(`/api/file?path=${enc(path)}`, { credentials: 'same-origin' }).then(async (r) => {
      if (!r.ok) throw new ApiError(r.status, ((await r.json().catch(() => ({}))) as { error?: string }).error ?? r.statusText);
      return r.text();
    }),
  search: (p: { q: string; source?: string; project?: string; cursor?: string; limit?: number }) =>
    get<Page<SearchHit>>('/api/search', { ...p, limit: p.limit ?? 30 }),
  blobUrl: (id: string, seq: number, path: string) => `/api/sessions/${enc(id)}/blob?seq=${seq}&path=${enc(path)}`,
  exportUrl: (id: string) => `/api/sessions/${enc(id)}/export.md`,
};
