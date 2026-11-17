import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, normalize, sep, extname } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { stream, streamSSE } from 'hono/streaming';
import type { ParseLine, SourceAdapter } from '../core/adapter.ts';
import type { SourceId } from '../core/types.ts';
import { searchText } from '../index/extract.ts';
import { makeSnippet } from '../index/snippet.ts';
import type { EventRef, IndexStore, SearchHit } from '../index/store.ts';
import {
  ExistsCache,
  lookupAdapter,
  noticeEvent,
  readRefs,
  resolveBlobPath,
  sanitizeEvent,
  type Adapter,
} from './events.ts';
import { eventToMarkdown } from './markdown.ts';
import { securityMiddleware } from './security.ts';

export interface AppDeps {
  store: IndexStore;
  adapters: Map<SourceId, SourceAdapter & { parseLine: ParseLine }>;
  token: string;
  port: number;
  webDir?: string;
  allowedRoots: string[];
  dev?: boolean;
  devToken?: string;
  version?: string;
  /** roots actually scanned per source (for /api/status); defaults to adapter.defaultRoots() */
  roots?: Map<SourceId, string[]>;
}

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const HEARTBEAT_MS = 25_000;

function intParam(v: string | undefined, def: number, min: number, max: number): number {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function fail(c: Context, status: 400 | 403 | 404 | 413 | 415 | 500, error: string) {
  return c.json({ error }, status);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

async function realRoots(roots: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const r of roots) {
    try {
      out.push(await realpath(r));
    } catch {
      /* root doesn't exist */
    }
  }
  return out;
}

function isInside(real: string, roots: string[]): boolean {
  return roots.some((r) => real === r || real.startsWith(r.endsWith(sep) ? r : r + sep));
}

/** Resolve a user-supplied path to a real path inside the allowed roots, or undefined. */
async function resolveAllowed(p: string, allowedRoots: string[]): Promise<string | undefined> {
  if (!p || p.includes('\0') || !isAbsolute(p)) return undefined;
  if (p.split(/[\\/]/).includes('..')) return undefined;
  let real: string;
  try {
    real = await realpath(p);
  } catch {
    return undefined;
  }
  return isInside(real, await realRoots(allowedRoots)) ? real : undefined;
}

/** Blob types we serve inline. Anything else (text/html, xml, js, ...) goes out as an opaque download. */
const INLINE_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/svg+xml', 'application/pdf',
]);
const IMAGE_EXT: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.bmp': 'image/bmp',
};
const MAX_IMAGE_FILE_BYTES = 25 * 1024 * 1024;

/**
 * Real path of an image file recorded in a chat (e.g. a Codex screenshot in a
 * temp dir). Allowed inside the scanned roots, or anywhere if it is a regular
 * raster-image file (by extension) of bounded size: only images the chat
 * references are reachable this way, never arbitrary text files.
 */
async function resolveImageFile(p: string, allowedRoots: string[]): Promise<{ real: string; type?: string } | undefined> {
  const inRoots = await resolveAllowed(p, allowedRoots);
  if (inRoots) return { real: inRoots };
  if (!p || p.includes('\0') || !isAbsolute(p)) return undefined;
  let real: string;
  try {
    real = await realpath(p);
  } catch {
    return undefined;
  }
  const type = IMAGE_EXT[extname(real).toLowerCase()];
  return type ? { real, type } : undefined;
}

export function createApp(deps: AppDeps): Hono {
  const { store, adapters } = deps;
  const app = new Hono();
  const exists = new ExistsCache();

  app.use('*', securityMiddleware({
    port: deps.port,
    token: deps.token,
    dev: deps.dev,
    devToken: deps.devToken,
  }));

  app.onError((err, c) => {
    console.error('[server]', err instanceof Error ? err.message : err);
    return c.json({ error: 'internal error' }, 500);
  });

  app.notFound((c) => {
    if (c.req.path.startsWith('/api/')) return c.json({ error: 'not found' }, 404);
    return c.text('not found', 404);
  });

  // ---- status / lists ------------------------------------------------------

  app.get('/api/status', (c) => {
    const st = store.status();
    const sources = [...adapters.values()].map((a) => ({
      id: a.id,
      displayName: a.displayName,
      roots: deps.roots?.get(a.id) ?? a.defaultRoots(),
      sessionCount: store.listProjects({ sourceId: a.id }).reduce((n, p) => n + p.sessionCount, 0),
    }));
    return c.json({
      version: deps.version ?? '0.0.0',
      sources,
      index: { state: st.state, done: st.filesDone, total: st.filesTotal, sessionCount: st.sessionCount, lastError: st.lastError },
    });
  });

  app.get('/api/projects', (c) => {
    const source = c.req.query('source') || undefined;
    const list = store.listProjects({ sourceId: source });
    list.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    return c.json(list);
  });

  app.get('/api/sessions', (c) => {
    const q = c.req.query();
    const page = store.listSessions({
      sourceId: q.source || undefined,
      projectKey: q.project || undefined,
      q: q.q || undefined,
      includeSubSessions: q.includeSub === '1' || q.includeSub === 'true',
      tree: q.tree === '1' || q.tree === 'true',
      archived: q.archived === 'only' || q.archived === 'all' ? q.archived : 'hide',
      cursor: q.cursor || undefined,
      limit: intParam(q.limit, 50, 1, 200),
    });
    return c.json(page);
  });

  app.get('/api/sessions/:id', (c) => {
    const id = c.req.param('id');
    const meta = store.getSession(id);
    if (!meta) return fail(c, 404, 'session not found');
    return c.json({ ...meta, subSessions: store.getSubSessions(id), sideChats: store.getSideChats(id) });
  });

  app.get('/api/sessions/:id/outline', (c) => {
    const id = c.req.param('id');
    if (!store.getSession(id)) return fail(c, 404, 'session not found');
    return c.json(store.outline(id));
  });

  // ---- events --------------------------------------------------------------

  app.get('/api/sessions/:id/events', async (c) => {
    const id = c.req.param('id');
    const found = lookupAdapter(adapters, store, id);
    if (!found) return fail(c, 404, 'session not found');
    const q = c.req.query();
    const view = q.view === 'all' ? 'all' : 'conversation';
    const direction = q.dir === 'backward' ? 'backward' : 'forward';
    const from = intParam(q.from, direction === 'backward' ? Number.MAX_SAFE_INTEGER : 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = intParam(q.limit, 100, 1, 500);
    const page = store.listEventRefs({ sessionId: id, view, from, limit, direction });
    const raw = await readRefs(found.adapter, found.meta, page.items);
    const links = store.toolLinks(id);
    const items = await Promise.all(raw.map((e) => sanitizeEvent(e, { truncate: true, links, exists })));
    return c.json({ items, nextFrom: page.nextFrom, prevFrom: page.prevFrom, total: page.total });
  });

  app.get('/api/sessions/:id/events/:seq', async (c) => {
    const id = c.req.param('id');
    const seq = Number(c.req.param('seq'));
    const found = lookupAdapter(adapters, store, id);
    if (!found) return fail(c, 404, 'session not found');
    if (!Number.isInteger(seq) || seq < 0) return fail(c, 400, 'bad seq');
    const ref = store.getEventRef(id, seq);
    if (!ref) return fail(c, 404, 'event not found');
    const [raw] = await readRefs(found.adapter, found.meta, [ref]);
    const ev = await sanitizeEvent(raw ?? noticeEvent(ref, 'event missing'), {
      truncate: false,
      links: store.toolLinks(id),
      exists,
    });
    return c.json(ev);
  });

  // ---- blob ------------------------------------------------------------------

  app.get('/api/sessions/:id/blob', async (c) => {
    const id = c.req.param('id');
    const seq = Number(c.req.query('seq'));
    const path = c.req.query('path') ?? '';
    const found = lookupAdapter(adapters, store, id);
    if (!found) return fail(c, 404, 'session not found');
    if (!Number.isInteger(seq) || seq < 0 || !path) return fail(c, 400, 'seq and path required');
    const ref = store.getEventRef(id, seq);
    if (!ref) return fail(c, 404, 'event not found');
    const [ev] = await readRefs(found.adapter, found.meta, [ref]);
    const block = ev ? resolveBlobPath(ev, path) : undefined;
    if (!block || (block.type !== 'image' && block.type !== 'document')) return fail(c, 404, 'blob not found');

    const headers: Record<string, string> = {
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      // never let a blob (e.g. SVG/HTML) execute script in our origin
      'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
    };
    const mediaType = (block.mediaType ?? '').toLowerCase();
    let type = INLINE_TYPES.has(mediaType) ? mediaType : 'application/octet-stream';
    if (type === 'application/octet-stream') headers['Content-Disposition'] = 'attachment';

    if (block.type === 'image' && block.filePath && !block.data) {
      const file = await resolveImageFile(block.filePath, deps.allowedRoots);
      if (!file) return fail(c, 403, 'file outside allowed roots');
      const real = file.real;
      if (file.type) {
        type = file.type;
        delete headers['Content-Disposition'];
      }
      let st;
      try {
        st = await stat(real);
      } catch {
        return fail(c, 404, 'file not found');
      }
      if (!st.isFile()) return fail(c, 404, 'file not found');
      if (st.size > MAX_IMAGE_FILE_BYTES) return fail(c, 413, 'file too large');
      headers['Content-Type'] = type;
      headers['Content-Length'] = String(st.size);
      return new Response(Readable.toWeb(createReadStream(real)) as ReadableStream, { headers });
    }
    if (!block.data) return fail(c, 404, 'blob has no data');
    const bytes = Buffer.from(block.data, 'base64');
    headers['Content-Type'] = type;
    headers['Content-Length'] = String(bytes.length);
    return new Response(new Uint8Array(bytes), { headers });
  });

  // ---- file ------------------------------------------------------------------

  app.get('/api/file', async (c) => {
    const p = c.req.query('path') ?? '';
    const real = await resolveAllowed(p, deps.allowedRoots);
    if (!real) return fail(c, 403, 'path not allowed');
    let st;
    try {
      st = await stat(real);
    } catch {
      return fail(c, 404, 'file not found');
    }
    if (!st.isFile()) return fail(c, 400, 'not a file');
    if (st.size > MAX_FILE_BYTES) return fail(c, 413, 'file too large (max 5 MB)');
    const buf = await readFile(real);
    if (buf.subarray(0, 8192).includes(0)) return fail(c, 415, 'binary file');
    return c.body(new Uint8Array(buf), 200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    });
  });

  // ---- search ----------------------------------------------------------------

  /**
   * The FTS index is contentless, so snippets are built from the hit's event
   * re-read from the source file (same text that was indexed). Undefined entries
   * keep the store's preview-based snippet.
   */
  async function sourceSnippets(hits: SearchHit[], q: string): Promise<(string | undefined)[]> {
    const out: (string | undefined)[] = new Array(hits.length);
    const bySession = new Map<string, number[]>();
    hits.forEach((h, i) => {
      const g = bySession.get(h.sessionId);
      if (g) g.push(i);
      else bySession.set(h.sessionId, [i]);
    });
    await Promise.all(
      [...bySession].map(async ([sid, idxs]) => {
        const found = lookupAdapter(adapters, store, sid);
        if (!found?.adapter) return;
        const refs = idxs.map((i) => store.getEventRef(sid, hits[i]!.seq));
        const ok = refs.filter((r): r is EventRef => !!r);
        const events = await readRefs(found.adapter, found.meta, ok);
        const bySeq = new Map(events.map((e) => [e.seq, e]));
        for (const i of idxs) {
          const ev = bySeq.get(hits[i]!.seq);
          const text = ev ? searchText(ev) : null;
          if (text) out[i] = makeSnippet(text, q);
        }
      }),
    );
    return out;
  }

  app.get('/api/search', async (c) => {
    const q = c.req.query();
    const text = (q.q ?? '').trim().slice(0, 500);
    if (!text) return fail(c, 400, 'q required');
    const page = store.search({
      q: text,
      sourceId: q.source || undefined,
      projectKey: q.project || undefined,
      cursor: q.cursor || undefined,
      limit: intParam(q.limit, 30, 1, 100),
    });
    const snippets = await sourceSnippets(page.items, text);
    return c.json({
      items: page.items.map((h, i) => ({
        sessionId: h.sessionId,
        seq: h.seq,
        snippet: snippets[i] ?? h.snippet,
        sessionTitle: h.sessionTitle,
        timestamp: h.timestamp,
        projectKey: h.projectKey,
        projectPath: h.projectPath,
        role: h.role,
      })),
      nextCursor: page.nextCursor,
    });
  });

  // ---- export ----------------------------------------------------------------

  app.get('/api/sessions/:id/export.md', (c) => {
    const id = c.req.param('id');
    const found = lookupAdapter(adapters, store, id);
    if (!found) return fail(c, 404, 'session not found');
    const { meta, adapter } = found;
    const name = (meta.title ?? meta.nativeId).replace(/[^\w.-]+/g, '_').slice(0, 80) || 'session';
    c.header('Content-Type', 'text/markdown; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename="${name}.md"`);
    c.header('Cache-Control', 'no-store');
    return stream(c, async (s) => {
      const links = store.toolLinks(id);
      await s.write(`# ${meta.title ?? meta.nativeId}\n\n`);
      const facts = [
        `Source: ${meta.sourceId}`,
        meta.projectPath ? `Project: ${meta.projectPath}` : '',
        meta.gitBranch ? `Branch: ${meta.gitBranch}` : '',
        meta.startedAt ? `Started: ${meta.startedAt}` : '',
      ].filter(Boolean);
      await s.write(facts.map((f) => `- ${f}`).join('\n') + '\n\n---\n\n');
      let from = 0;
      for (;;) {
        const page = store.listEventRefs({ sessionId: id, view: 'conversation', from, limit: 200, direction: 'forward' });
        const raw = await readRefs(adapter, meta, page.items);
        for (const r of raw) {
          if (r.offBranch) continue;
          const ev = await sanitizeEvent(r, { truncate: false, links, exists });
          await s.write(eventToMarkdown(ev));
        }
        if (page.nextFrom === undefined || page.items.length === 0) break;
        from = page.nextFrom;
      }
    });
  });

  // ---- SSE -------------------------------------------------------------------

  app.get('/api/stream', (c) =>
    streamSSE(c, async (s) => {
      let chain: Promise<unknown> = Promise.resolve();
      const send = (event: string, data: unknown) => {
        chain = chain.then(() => s.writeSSE({ event, data: JSON.stringify(data) })).catch(() => {});
      };
      const unsub = store.onChange((e) => {
        if (e.type === 'progress') {
          const st = e.status;
          send('index-progress', { state: st.state, done: st.filesDone, total: st.filesTotal, sessionCount: st.sessionCount });
        } else {
          send('session-updated', { id: e.sessionId });
        }
      });
      const hb = setInterval(() => {
        chain = chain.then(() => s.write(': ping\n\n')).catch(() => {});
      }, HEARTBEAT_MS);
      const st = store.status();
      send('index-progress', { state: st.state, done: st.filesDone, total: st.filesTotal, sessionCount: st.sessionCount });
      await new Promise<void>((resolve) => s.onAbort(resolve));
      clearInterval(hb);
      unsub();
    }),
  );

  app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

  // ---- static UI -------------------------------------------------------------

  const webDir = deps.webDir ?? fileURLToPath(new URL('./web/', import.meta.url));
  const webRoot = normalize(webDir);

  app.get('*', async (c) => {
    let rel: string;
    try {
      rel = decodeURIComponent(c.req.path);
    } catch {
      return c.text('bad request', 400);
    }
    if (rel.includes('\0')) return c.text('bad request', 400);
    const file = normalize(join(webRoot, rel));
    const within = file === webRoot || file.startsWith(webRoot.endsWith(sep) ? webRoot : webRoot + sep);
    const serve = async (path: string, cache: string) => {
      const body = await readFile(path);
      return c.body(new Uint8Array(body), 200, {
        'Content-Type': MIME[extname(path).toLowerCase()] ?? 'application/octet-stream',
        'Cache-Control': cache,
      });
    };
    if (within) {
      try {
        const st = await stat(file);
        if (st.isFile()) {
          const cache = rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
          return await serve(file, cache);
        }
      } catch {
        /* fall through */
      }
    }
    if (rel.startsWith('/assets/') || extname(rel)) return c.text('not found', 404);
    try {
      return await serve(join(webRoot, 'index.html'), 'no-cache');
    } catch {
      return c.text('UI not built. Run the web build, or use --dev with the Vite dev server.', 404);
    }
  });

  return app;
}

export type { Adapter };
