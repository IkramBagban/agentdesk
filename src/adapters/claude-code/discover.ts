import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { DiscoveredFile } from '../../core/adapter.ts';

const SKIP_DIRS = new Set(['memory', 'tool-results']);

async function safeReaddir(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function discoverProject(root: string, projectDir: string): Promise<DiscoveredFile[]> {
  const out: DiscoveredFile[] = [];
  const dir = join(root, projectDir);
  const projectKey = `claude-code:${projectDir}`;
  const entries = await safeReaddir(dir);
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith('.jsonl')) {
      out.push({
        path: join(dir, e.name),
        nativeId: basename(e.name, '.jsonl'),
        projectKey,
      });
    } else if (e.isDirectory() && !SKIP_DIRS.has(e.name)) {
      const sessionId = e.name;
      const subDir = join(dir, sessionId, 'subagents');
      for (const s of await safeReaddir(subDir)) {
        if (!s.isFile() || !s.name.startsWith('agent-') || !s.name.endsWith('.jsonl')) continue;
        const agent = basename(s.name, '.jsonl');
        out.push({
          path: join(subDir, s.name),
          nativeId: `${sessionId}/${agent}`,
          projectKey,
          parentNativeId: sessionId,
          extra: { metaPath: join(subDir, `${agent}.meta.json`) },
        });
      }
    }
  }
  return out;
}

export async function discover(root: string): Promise<DiscoveredFile[]> {
  const projects = (await safeReaddir(root)).filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name));
  const lists = await Promise.all(projects.map((p) => discoverProject(root, p.name)));
  return lists.flat().sort((a, b) => (a.path < b.path ? -1 : 1));
}
