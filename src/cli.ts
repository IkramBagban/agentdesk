#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import type { SourceId } from './core/types.ts';
import { cacheDir as defaultCacheDir } from './index/paths.ts';
import type { Adapter } from './server/events.ts';
import { loadOrCreateToken } from './server/token.ts';

const MIN_NODE = [22, 13] as const;

const HELP = `agentdesk - read your coding-agent conversations in a local viewer

Usage: agentdesk [options]

Options:
  --port <n>          Port to listen on (default 4782; tries the next 20 if busy)
  --no-open           Do not open the browser
  --dev               Dev mode (accept the Vite dev server on :5173)
  --root <path>       Scan this directory instead of each adapter's default roots
                      (repeatable, applied to all adapters)
  --claude-root <p>   Override roots for the claude-code adapter (repeatable)
  --codex-root <p>    Override roots for the codex adapter (repeatable)
  --cache-dir <path>  Where to keep the index cache
  --reindex           Delete the cache database and rebuild it
  --reset-token       Issue a new access token (open the new link; old links stop working)
  --version           Print version
  --help              Show this help
`;

function checkNode(): void {
  const [maj = 0, min = 0] = process.versions.node.split('.').map(Number);
  if (maj < MIN_NODE[0] || (maj === MIN_NODE[0] && min < MIN_NODE[1])) {
    console.error(
      `agentdesk needs Node ${MIN_NODE[0]}.${MIN_NODE[1]} or newer (you have ${process.versions.node}).\n` +
        'Please upgrade Node: https://nodejs.org/',
    );
    process.exit(1);
  }
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function tryListen(
  port: number,
  fetch: (req: Request) => Response | Promise<Response>,
): Promise<ServerType | undefined> {
  return new Promise((resolveP, reject) => {
    const server = serve({ fetch, port, hostname: '127.0.0.1' });
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' || err.code === 'EACCES') resolveP(undefined);
      else reject(err);
    });
    server.once('listening', () => resolveP(server));
  });
}

async function main(): Promise<void> {
  checkNode();
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        port: { type: 'string' },
        'no-open': { type: 'boolean', default: false },
        dev: { type: 'boolean', default: false },
        root: { type: 'string', multiple: true },
        'claude-root': { type: 'string', multiple: true },
        'codex-root': { type: 'string', multiple: true },
        'cache-dir': { type: 'string' },
        reindex: { type: 'boolean', default: false },
        'reset-token': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
      strict: true,
    }));
  } catch (e) {
    console.error(`${(e as Error).message}\n\n${HELP}`);
    process.exit(2);
  }
  if (values.help) {
    console.log(HELP);
    return;
  }
  const version = readVersion();
  if (values.version) {
    console.log(version);
    return;
  }

  const basePort = values.port ? Number(values.port) : 4782;
  if (!Number.isInteger(basePort) || basePort < 1 || basePort > 65535) {
    console.error(`Invalid --port: ${values.port}`);
    process.exit(2);
  }

  // Imported lazily so --help/--version work without loading the heavy modules.
  const { adapters: registry } = await import('./adapters/index.ts');
  const { startIndexer } = await import('./index/run.ts');
  const { createApp } = await import('./server/app.ts');

  const adapters = registry as Map<SourceId, Adapter>;
  const roots = new Map<SourceId, string[]>();
  for (const a of adapters.values()) {
    const specific =
      a.id === 'claude-code' ? values['claude-root'] : a.id === 'codex' ? values['codex-root'] : undefined;
    const chosen = specific?.length ? specific : values.root?.length ? values.root : a.defaultRoots();
    roots.set(a.id, chosen.map((r) => resolve(r)));
  }
  const allowedRoots = [...new Set([...roots.values()].flat())];

  const cacheDir = resolve(values['cache-dir'] ?? defaultCacheDir());
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const dbPath = join(cacheDir, 'index.db');
  if (values.reindex) {
    for (const suffix of ['', '-wal', '-shm']) await rm(dbPath + suffix, { force: true });
  }

  const indexer = await startIndexer({ dbPath, adapters: [...adapters.values()], roots });
  const store = indexer.store;

  const token = loadOrCreateToken(cacheDir, values['reset-token']);
  const devToken = values.dev ? process.env.AGENTDESK_DEV_TOKEN : undefined;

  let server: ServerType | undefined;
  let port = basePort;
  for (let i = 0; i <= 20 && !server; i++) {
    port = basePort + i;
    if (port > 65535) break;
    const app = createApp({
      store,
      adapters,
      token,
      port,
      allowedRoots,
      dev: values.dev,
      devToken,
      version,
      roots,
    });
    server = await tryListen(port, app.fetch);
  }
  if (!server) {
    console.error(`Could not find a free port in ${basePort}-${basePort + 20}.`);
    await indexer.stop();
    process.exit(1);
  }

  const url = `http://127.0.0.1:${port}/?t=${token}`;
  console.log(`agentdesk ${version} running at:\n\n  ${url}\n`);
  if (devToken) console.log('Dev token from AGENTDESK_DEV_TOKEN is accepted.');
  if (!values['no-open']) {
    try {
      const { default: open } = await import('open');
      await open(url);
    } catch {
      console.log('Could not open a browser automatically; open the URL above.');
    }
  }

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    console.log('\nShutting down...');
    setTimeout(() => process.exit(0), 3000).unref();
    try {
      server.close();
      (server as { closeAllConnections?: () => void }).closeAllConnections?.();
      await indexer.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
