import { readFileSync } from 'node:fs';
import type { DiscoveredFile, SessionParser } from '../../core/adapter.ts';
import type { ChatEvent, RawLine, SessionMeta } from '../../core/types.ts';
import { convertRecord, countImages, isInherited, materialize, parseJson, textOf } from './convert.ts';
import { clip, isObj, num, type Rec, str } from './util.ts';

const SOURCE = 'claude-code';
const STATE_VERSION = 1;

/** uuid -> [parent uuid | null, seqs of user/assistant/tool events carried by that uuid] */
type Node = [string | null, number[]];

interface State {
  v: number;
  seq: number;
  messageCount: number;
  imageCount: number;
  malformed: number;
  models: string[];
  startedAt?: string;
  updatedAt?: string;
  firstPrompt?: string;
  customTitle?: string;
  agentName?: string;
  summaryTitle?: string;
  costUSD?: number;
  inputTokens?: number;
  outputTokens?: number;
  gitBranch?: string;
  projectPath?: string;
  links: { kind: string; url: string; title?: string }[];
  leafUuid?: string;
  lastUuid?: string;
  nodes: Record<string, Node>;
}

function freshState(): State {
  return { v: STATE_VERSION, seq: 0, messageCount: 0, imageCount: 0, malformed: 0, models: [], links: [], nodes: {} };
}

function isValidState(s: unknown): s is State {
  return isObj(s) && s.v === STATE_VERSION && typeof s.seq === 'number' && isObj(s.nodes) && Array.isArray(s.models) && Array.isArray(s.links);
}

function readSidecar(file: DiscoveredFile): { toolUseId?: string; description?: string } {
  const p = file.extra?.metaPath;
  if (typeof p !== 'string') return {};
  try {
    const j: unknown = JSON.parse(readFileSync(p, 'utf8'));
    if (!isObj(j)) return {};
    const out: { toolUseId?: string; description?: string } = {};
    const t = str(j.toolUseId);
    const d = str(j.description);
    if (t) out.toolUseId = t;
    if (d) out.description = d;
    return out;
  } catch {
    return {};
  }
}

export class ClaudeCodeParser implements SessionParser {
  private st: State = freshState();
  private readonly sidecar: { toolUseId?: string; description?: string };
  private readonly file: DiscoveredFile;

  constructor(file: DiscoveredFile) {
    this.file = file;
    this.sidecar = readSidecar(file);
  }

  /** Number of lines skipped because they were not valid JSON objects. */
  get malformedLines(): number {
    return this.st.malformed;
  }

  push(line: RawLine): ChatEvent[] {
    const { rec, blank } = parseJson(line.text);
    if (!rec) {
      if (!blank) this.st.malformed++;
      return [];
    }
    const drafts = convertRecord(rec);
    this.observe(rec);
    const events = materialize(drafts, this.st.seq, line, isInherited(rec, this.file));
    for (const ev of events) this.account(ev);
    return events;
  }

  private account(ev: ChatEvent): void {
    const st = this.st;
    st.seq = ev.seq + 1;
    if (ev.visibility === 'conversation') st.messageCount++;
    st.imageCount += countImages(ev.blocks);
    if (ev.model && ev.model !== '<synthetic>' && !st.models.includes(ev.model)) st.models.push(ev.model);
    if (st.firstPrompt === undefined && ev.role === 'user' && ev.visibility === 'conversation') {
      const t = textOf(ev.blocks).trim();
      if (t) st.firstPrompt = clip(t, 300);
    }
    if (ev.uuid) {
      const prev = st.nodes[ev.uuid];
      const seqs = prev ? prev[1] : [];
      if (ev.role === 'user' || ev.role === 'assistant' || ev.role === 'tool') seqs.push(ev.seq);
      st.nodes[ev.uuid] = [ev.parentUuid ?? null, seqs];
      st.lastUuid = ev.uuid;
    }
  }

  /** Update metadata accumulators from the raw record (bookkeeping + timestamps). */
  private observe(rec: Rec): void {
    const st = this.st;
    const ts = str(rec.timestamp);
    if (ts) {
      if (st.startedAt === undefined || ts < st.startedAt) st.startedAt = ts;
      if (st.updatedAt === undefined || ts > st.updatedAt) st.updatedAt = ts;
    }
    const cwd = str(rec.cwd);
    if (cwd && st.projectPath === undefined) st.projectPath = cwd;
    const branch = str(rec.gitBranch);
    if (branch && branch !== 'HEAD') st.gitBranch = branch; // 'HEAD' = detached / no branch

    switch (str(rec.type)) {
      case 'custom-title': {
        const t = str(rec.customTitle)?.trim();
        if (t && t !== 'New session') st.customTitle = t;
        break;
      }
      case 'agent-name': {
        const t = str(rec.agentName)?.trim();
        if (t) st.agentName = t;
        break;
      }
      case 'summary': {
        const t = str(rec.summary)?.trim();
        if (t && st.summaryTitle === undefined) st.summaryTitle = t;
        break;
      }
      case 'last-prompt': {
        const l = str(rec.leafUuid);
        if (l) st.leafUuid = l;
        break;
      }
      case 'cost-state': {
        const c = num(rec.totalCostUSD);
        if (c !== undefined) st.costUSD = c;
        if (isObj(rec.modelUsage)) {
          let i = 0;
          let o = 0;
          for (const u of Object.values(rec.modelUsage)) {
            if (!isObj(u)) continue;
            i += num(u.inputTokens) ?? 0;
            o += num(u.outputTokens) ?? 0;
          }
          st.inputTokens = i;
          st.outputTokens = o;
        }
        break;
      }
      case 'pr-link': {
        const url = str(rec.prUrl);
        if (url && !st.links.some((l) => l.kind === 'pr' && l.url === url)) {
          const n = num(rec.prNumber);
          const repo = str(rec.prRepository);
          st.links.push({ kind: 'pr', url, ...(n !== undefined ? { title: `${repo ? `${repo}` : 'PR'}#${n}` } : {}) });
        }
        break;
      }
      case 'frame-link': {
        const url = str(rec.frameUrl);
        if (url && !st.links.some((l) => l.kind === 'artifact' && l.url === url)) {
          const title = str(rec.title);
          st.links.push({ kind: 'artifact', url, ...(title ? { title } : {}) });
        }
        break;
      }
      default:
        break;
    }
  }

  finish(): { meta: SessionMeta; offBranchSeqs: number[] } {
    const st = this.st;
    const f = this.file;
    const title = st.customTitle ?? st.agentName ?? st.summaryTitle ?? (st.firstPrompt ? clip(st.firstPrompt.split('\n')[0] ?? '', 100) : undefined);
    const meta: SessionMeta = {
      id: `${SOURCE}:${f.nativeId}`,
      sourceId: SOURCE,
      nativeId: f.nativeId,
      filePath: f.path,
      projectKey: f.projectKey,
      eventCount: st.seq,
      messageCount: st.messageCount,
      imageCount: st.imageCount,
      models: [...st.models],
      links: st.links.map((l) => ({ ...l })),
    };
    if (st.projectPath) meta.projectPath = st.projectPath;
    if (title) meta.title = title;
    if (st.firstPrompt) meta.firstPrompt = st.firstPrompt;
    if (st.startedAt) meta.startedAt = st.startedAt;
    if (st.updatedAt) meta.updatedAt = st.updatedAt;
    if (st.costUSD !== undefined) meta.costUSD = st.costUSD;
    if (st.inputTokens !== undefined) meta.inputTokens = st.inputTokens;
    if (st.outputTokens !== undefined) meta.outputTokens = st.outputTokens;
    if (st.gitBranch) meta.gitBranch = st.gitBranch;
    if (f.parentNativeId) meta.parentSessionId = `${SOURCE}:${f.parentNativeId}`;
    if (this.sidecar.toolUseId) meta.parentToolUseId = this.sidecar.toolUseId;
    if (this.sidecar.description) meta.agentDescription = this.sidecar.description;
    return { meta, offBranchSeqs: this.offBranch() };
  }

  /**
   * Active branch = ancestors of the leaf. The leaf is the last event with a
   * uuid, unless the last `last-prompt.leafUuid` is NOT an ancestor of it (then
   * the recorded leaf wins). Conservative: if the walk reaches < 50% of uuid
   * nodes the parent chain is considered unreliable and nothing is marked.
   */
  private offBranch(): number[] {
    const { nodes, lastUuid, leafUuid } = this.st;
    const total = Object.keys(nodes).length;
    if (total === 0 || lastUuid === undefined) return [];
    const walk = (from: string): Set<string> => {
      const path = new Set<string>();
      let cur: string | null = from;
      while (cur !== null && !path.has(cur)) {
        const n: Node | undefined = nodes[cur];
        if (!n) break;
        path.add(cur);
        cur = n[0];
      }
      return path;
    };
    let path = walk(lastUuid);
    if (leafUuid !== undefined && nodes[leafUuid] && !path.has(leafUuid)) path = walk(leafUuid);
    if (path.size < total * 0.5) return [];
    const out: number[] = [];
    for (const [uuid, n] of Object.entries(nodes)) {
      if (!path.has(uuid)) out.push(...n[1]);
    }
    return out.sort((a, b) => a - b);
  }

  snapshot(): unknown {
    return JSON.parse(JSON.stringify(this.st)) as State;
  }

  resume(state: unknown): void {
    this.st = isValidState(state) ? (JSON.parse(JSON.stringify(state)) as State) : freshState();
  }
}
