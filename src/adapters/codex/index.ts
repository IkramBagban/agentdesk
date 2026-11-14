import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DiscoveredFile, SourceAdapter, ParseLine } from '../../core/adapter.ts';
import { createParser, parseLine } from './parser.ts';

const FILE_RE = /^rollout-.*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

async function walk(dir: string, out: DiscoveredFile[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      await walk(p, out);
    } else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
      const m = FILE_RE.exec(e.name);
      const nativeId = m?.[1] ?? e.name.replace(/^rollout-/, '').replace(/\.jsonl$/, '');
      // cwd is only known from session_meta inside the file (discover does no
      // file reads); the parser's finish() meta carries the real projectKey.
      out.push({ path: p, nativeId, projectKey: 'codex:unknown' });
    }
  }
}

export const codexAdapter: SourceAdapter & { parseLine: ParseLine } = {
  id: 'codex',
  displayName: 'Codex',
  parserVersion: '2',
  defaultRoots() {
    const home = codexHome();
    return [join(home, 'sessions'), join(home, 'archived_sessions')];
  },
  async discover(root: string) {
    const out: DiscoveredFile[] = [];
    await walk(root, out);
    out.sort((a, b) => a.path.localeCompare(b.path));
    return out;
  },
  createParser,
  parseLine,
};
