import type { SessionParser, DiscoveredFile, ParseLine } from '../../core/adapter.ts';
import type { Block, ChatEvent, RawLine, SessionMeta } from '../../core/types.ts';
import { convertRecord, draftText, isObj, parseJsonLine, type Draft, type Rec } from './convert.ts';

interface State {
  seq: number;
  nativeId?: string;
  cwd?: string;
  startedAt?: string;
  updatedAt?: string;
  models: string[];
  inputTokens?: number;
  outputTokens?: number;
  gitBranch?: string;
  parentNativeId?: string;
  firstPrompt?: string;
  eventCount: number;
  messageCount: number;
  imageCount: number;
  errors: number;
}

function newState(): State {
  return { seq: 0, models: [], eventCount: 0, messageCount: 0, imageCount: 0, errors: 0 };
}

function toEvent(d: Draft, seq: number, line: RawLine): ChatEvent {
  return {
    seq,
    ...(d.uuid ? { uuid: d.uuid } : {}),
    role: d.role,
    visibility: d.visibility,
    ...(d.timestamp ? { timestamp: d.timestamp } : {}),
    ...(d.synthetic ? { synthetic: true } : {}),
    blocks: d.blocks,
    line: line.line,
    offset: line.offset,
    length: line.length,
  };
}

function countImages(blocks: Block[]): number {
  let n = 0;
  for (const b of blocks) {
    if (b.type === 'image') n++;
    else if (b.type === 'tool_result') n += countImages(b.content);
  }
  return n;
}

function addModel(st: State, m: unknown): void {
  if (typeof m === 'string' && m && !st.models.includes(m)) st.models.push(m);
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function usage(st: State, u: unknown): void {
  if (!isObj(u)) return;
  const i = num(u.input_tokens);
  const o = num(u.output_tokens);
  if (i !== undefined) st.inputTokens = i;
  if (o !== undefined) st.outputTokens = o;
}

/** Update session-level metadata from a record. */
function observe(st: State, rec: Rec): void {
  if (typeof rec.timestamp === 'string') {
    st.startedAt ??= rec.timestamp;
    st.updatedAt = rec.timestamp;
  }
  const p = rec.payload;
  if (!isObj(p)) return;
  switch (rec.type) {
    case 'session_meta': {
      if (typeof p.id === 'string') st.nativeId ??= p.id;
      else if (typeof p.session_id === 'string') st.nativeId ??= p.session_id;
      if (typeof p.cwd === 'string') st.cwd ??= p.cwd;
      if (typeof p.timestamp === 'string') st.startedAt = p.timestamp;
      addModel(st, p.model);
      if (isObj(p.git) && typeof p.git.branch === 'string' && p.git.branch && p.git.branch !== 'HEAD') {
        st.gitBranch ??= p.git.branch;
      }
      const src = p.source;
      if (isObj(src)) {
        const sub = isObj(src.subagent) ? src.subagent : undefined;
        const spawn = sub && isObj(sub.thread_spawn) ? sub.thread_spawn : undefined;
        const parent = spawn?.parent_thread_id ?? p.parent_thread_id ?? p.forked_from_id;
        if (typeof parent === 'string') st.parentNativeId ??= parent;
      }
      break;
    }
    case 'turn_context':
      if (typeof p.cwd === 'string') st.cwd ??= p.cwd;
      addModel(st, p.model);
      break;
    case 'token_usage_record':
      usage(st, p.thread_token_usage);
      break;
    case 'event_msg':
      if (p.type === 'token_count' && isObj(p.info)) usage(st, p.info.total_token_usage);
      else if (p.type === 'thread_settings_applied' && isObj(p.thread_settings)) {
        addModel(st, p.thread_settings.model);
        if (typeof p.thread_settings.cwd === 'string') st.cwd ??= p.thread_settings.cwd;
      }
      break;
  }
}

function processLine(line: RawLine, firstSeq: number, st?: State): ChatEvent[] {
  const rec = parseJsonLine(line.text);
  if (!rec) {
    if (st && line.text.trim()) st.errors++;
    return [];
  }
  if (st) observe(st, rec);
  let drafts: Draft[];
  try {
    drafts = convertRecord(rec);
  } catch {
    if (st) st.errors++;
    return [];
  }
  const events = drafts.map((d, i) => toEvent(d, firstSeq + i, line));
  if (st) {
    for (const d of drafts) {
      st.eventCount++;
      if (d.visibility === 'conversation') st.messageCount++;
      st.imageCount += countImages(d.blocks);
      if (!st.firstPrompt && d.role === 'user' && d.visibility === 'conversation') {
        const t = promptText(draftText(d));
        if (t) st.firstPrompt = t;
      }
    }
    st.seq = firstSeq + events.length;
  }
  return events;
}

function promptText(raw: string): string {
  let t = raw;
  const i = t.indexOf('## My request:');
  if (i >= 0) t = t.slice(i + '## My request:'.length);
  t = t.trim();
  return t.length > 500 ? t.slice(0, 500) : t;
}

function titleFrom(prompt: string | undefined): string | undefined {
  if (!prompt) return undefined;
  const first = prompt.split('\n').find((l) => l.trim()) ?? prompt;
  const t = first.trim();
  return t.length > 120 ? `${t.slice(0, 117)}...` : t;
}

export const parseLine: ParseLine = (line, firstSeq, _file) => processLine(line, firstSeq);

export function createParser(file: DiscoveredFile): SessionParser {
  let st = newState();
  return {
    push(line: RawLine): ChatEvent[] {
      return processLine(line, st.seq, st);
    },
    finish() {
      const nativeId = st.nativeId ?? file.nativeId;
      const cwd = st.cwd;
      const meta: SessionMeta = {
        id: `codex:${nativeId}`,
        sourceId: 'codex',
        nativeId,
        filePath: file.path,
        ...(cwd ? { projectPath: cwd } : {}),
        projectKey: cwd ? `codex:${cwd}` : file.projectKey,
        ...(st.firstPrompt ? { title: titleFrom(st.firstPrompt), firstPrompt: st.firstPrompt } : {}),
        ...(st.startedAt ? { startedAt: st.startedAt } : {}),
        ...(st.updatedAt ? { updatedAt: st.updatedAt } : {}),
        eventCount: st.eventCount,
        messageCount: st.messageCount,
        imageCount: st.imageCount,
        models: [...st.models],
        ...(st.inputTokens !== undefined ? { inputTokens: st.inputTokens } : {}),
        ...(st.outputTokens !== undefined ? { outputTokens: st.outputTokens } : {}),
        ...(st.gitBranch ? { gitBranch: st.gitBranch } : {}),
        ...(st.parentNativeId
          ? { parentSessionId: `codex:${st.parentNativeId}` }
          : file.parentNativeId
            ? { parentSessionId: `codex:${file.parentNativeId}` }
            : {}),
        links: [],
      };
      return { meta, offBranchSeqs: [] };
    },
    snapshot(): unknown {
      return JSON.parse(JSON.stringify(st)) as State;
    },
    resume(state: unknown): void {
      if (!isObj(state)) return;
      const s = state as unknown as Partial<State>;
      const base = newState();
      st = { ...base, ...s, models: Array.isArray(s.models) ? [...s.models] : [] };
    },
  };
}
