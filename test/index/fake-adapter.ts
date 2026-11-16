import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { DiscoveredFile, SessionParser, SourceAdapter } from '../../src/core/adapter.ts';
import type { Block, ChatEvent, RawLine, SessionMeta } from '../../src/core/types.ts';

/**
 * Tiny JSONL format for tests. One JSON object per line:
 *  {k:'user'|'assistant'|'detail'|'meta', text, ts?, off?:true, img?:true,
 *   tool?:{id,name,input,sub?}, n?:number (emit n events from this line)}
 *  {k:'hdr', parentToolUseId, title, cwd}   (no event; meta only; cwd → projectPath)
 * Files named agent-<parent>-<x>.jsonl are sub-agent sessions of <parent>.
 */
class FakeParser implements SessionParser {
  seq = 0;
  messages = 0;
  title: string | undefined;
  first: string | undefined;
  updated: string | undefined;
  off: number[] = [];
  parentToolUseId: string | undefined;
  cwd: string | undefined;
  readonly file: DiscoveredFile;
  constructor(file: DiscoveredFile) {
    this.file = file;
  }

  push(line: RawLine): ChatEvent[] {
    let rec: any;
    try {
      rec = JSON.parse(line.text);
    } catch {
      return [];
    }
    if (rec.k === 'hdr') {
      this.parentToolUseId = rec.parentToolUseId;
      this.title = rec.title ?? this.title;
      this.cwd = rec.cwd ?? this.cwd;
      return [];
    }
    if (rec.k === 'boom') throw new Error('boom');
    const out: ChatEvent[] = [];
    const n = rec.n ?? 1;
    for (let i = 0; i < n; i++) {
      const blocks: Block[] = [];
      if (rec.text !== undefined) blocks.push({ type: 'text', text: String(rec.text) });
      if (rec.tool) blocks.push({ type: 'tool_use', id: rec.tool.id, name: rec.tool.name, input: rec.tool.input, ...(rec.tool.sub ? { subSessionId: rec.tool.sub } : {}) });
      if (rec.img) blocks.push({ type: 'image', mediaType: 'image/png', size: 3, data: 'AAAA'.repeat(500) });
      const visibility = rec.k === 'user' || rec.k === 'assistant' ? 'conversation' : rec.k === 'meta' ? 'meta' : 'detail';
      const ev: ChatEvent = {
        seq: this.seq,
        role: rec.k === 'assistant' ? 'assistant' : rec.k === 'user' ? 'user' : 'system',
        visibility,
        ...(rec.ts ? { timestamp: rec.ts } : {}),
        ...(rec.syn ? { synthetic: true } : {}),
        blocks,
        line: line.line,
        offset: line.offset,
        length: line.length,
      };
      if (rec.off) this.off.push(this.seq);
      if (visibility === 'conversation') this.messages++;
      if (rec.k === 'user' && !this.first) this.first = String(rec.text);
      this.seq++;
      out.push(ev);
    }
    if (rec.ts) this.updated = rec.ts;
    return out;
  }
  finish(): { meta: SessionMeta; offBranchSeqs: number[] } {
    const meta: SessionMeta = {
      id: `fake:${this.file.nativeId}`,
      sourceId: 'fake',
      nativeId: this.file.nativeId,
      filePath: this.file.path,
      projectKey: this.file.projectKey,
      eventCount: this.seq,
      messageCount: this.messages,
      imageCount: 0,
      models: [],
      links: [],
    };
    if (this.title) meta.title = this.title;
    if (this.first) meta.firstPrompt = this.first;
    if (this.updated) meta.updatedAt = this.updated;
    if (this.cwd) meta.projectPath = this.cwd;
    if (this.file.parentNativeId) {
      meta.parentSessionId = `fake:${this.file.parentNativeId}`;
      if (this.parentToolUseId) meta.parentToolUseId = this.parentToolUseId;
    }
    return { meta, offBranchSeqs: [...this.off] };
  }
  snapshot(): unknown {
    const { file: _f, ...rest } = this;
    return JSON.parse(JSON.stringify(rest));
  }
  resume(state: unknown): void {
    Object.assign(this, state);
  }
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  let ents;
  try {
    ents = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

export const fakeAdapter: SourceAdapter & { parserVersion: string } = {
  id: 'fake',
  displayName: 'Fake',
  parserVersion: '1',
  defaultRoots: () => [],
  async discover(root) {
    const files = await walk(root);
    return files.map((path): DiscoveredFile => {
      const name = basename(path, '.jsonl');
      const m = /^agent-(.+?)-[^-]+$/.exec(name);
      return {
        path,
        nativeId: name,
        projectKey: basename(join(path, '..')),
        ...(m ? { parentNativeId: m[1]! } : {}),
      };
    });
  },
  createParser: (file) => new FakeParser(file),
};

export const adapters = [fakeAdapter];
