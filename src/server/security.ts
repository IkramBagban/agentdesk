import { createHash, timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';

/**
 * Cookies are scoped by host, not port: include the port so two instances (or
 * another app on 127.0.0.1) never overwrite each other's token.
 */
export const cookieName = (port: number): string => `agentdesk_token_${port}`;

export const CSP =
  "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'";

export interface SecurityOptions {
  port: number;
  token: string;
  dev?: boolean;
  /** fixed token accepted in addition to `token` (dev mode only) */
  devToken?: string;
}

function digest(s: string): Buffer {
  return createHash('sha256').update(s).digest();
}

/** Constant-time string comparison (hashes first so lengths don't leak). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

export function allowedHosts(port: number, dev?: boolean): Set<string> {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  if (dev) {
    for (const h of ['localhost:5173', '127.0.0.1:5173', '[::1]:5173']) hosts.add(h);
  }
  return hosts;
}

export function securityMiddleware(opts: SecurityOptions): MiddlewareHandler {
  const hosts = allowedHosts(opts.port, opts.dev);
  const cookie = cookieName(opts.port);
  const tokens = [opts.token];
  if (opts.dev && opts.devToken) tokens.push(opts.devToken);
  const valid = (candidate: string | undefined): boolean => {
    if (!candidate) return false;
    let ok = false;
    for (const t of tokens) if (safeEqual(candidate, t)) ok = true;
    return ok;
  };

  return async (c, next) => {
    const host = (c.req.header('host') ?? '').toLowerCase();
    if (!hosts.has(host)) {
      return c.json({ error: 'forbidden host' }, 403);
    }

    const url = new URL(c.req.url);
    const queryToken = url.searchParams.get('t');
    if (url.pathname === '/' && queryToken !== null && valid(queryToken)) {
      setCookie(c, cookie, queryToken, {
        httpOnly: true,
        sameSite: 'Strict',
        path: '/',
        // the token is persisted per cache dir (see cli.ts), so the cookie can outlive a restart
        maxAge: 400 * 24 * 60 * 60,
      });
      c.header('Cache-Control', 'no-store');
      c.header('Referrer-Policy', 'no-referrer');
      return c.redirect('/', 302);
    }

    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      const auth = c.req.header('authorization');
      const bearer = auth && /^Bearer /i.test(auth) ? auth.slice(7).trim() : undefined;
      if (!valid(getCookie(c, cookie)) && !valid(bearer)) {
        return c.json({ error: 'unauthorized' }, 401);
      }
    }

    await next();

    c.res.headers.set('X-Content-Type-Options', 'nosniff');
    c.res.headers.set('Referrer-Policy', 'no-referrer');
    if ((c.res.headers.get('content-type') ?? '').startsWith('text/html')) {
      c.res.headers.set('Content-Security-Policy', CSP);
    }
  };
}
