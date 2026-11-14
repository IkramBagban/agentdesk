# agentdesk — spec

A local, read-only viewer for coding-agent chat history (Claude Code first,
Codex next, others later). Runs entirely on the user's machine:
`npx agentdesk` → indexes local history → serves a UI on 127.0.0.1.
No accounts, no remote server, no telemetry.

## Principles

1. **Never load everything.** Files are indexed once into a SQLite cache
   (summaries + byte offsets). The UI pages through sessions and events;
   the server reads byte ranges on demand. Images are fetched lazily by URL.
2. **Read-only.** We never write to `~/.claude`, `~/.codex`, etc. The only
   thing we write is our own cache DB.
3. **Tolerant.** Formats change between agent versions. Unknown records →
   `RawBlock`; malformed lines are skipped and counted; parsers never throw.
4. **Agent-agnostic core.** Only `src/adapters/*` knows a source's format.
   Everything else uses `src/core/types.ts`.
5. **Safe local server.** See Security.

## Layout

```
src/
  core/types.ts          normalized model (THE CONTRACT)
  core/adapter.ts        SourceAdapter / SessionParser interfaces
  adapters/claude-code/  Claude Code adapter   (~/.claude/projects)
  adapters/codex/        Codex adapter         (~/.codex/sessions, archived_sessions)
  adapters/index.ts      registry: all adapters
  index/                 SQLite cache: schema, indexer (worker thread), queries, search
  server/                Hono app: routes, security, static UI
  cli.ts                 entry: args, start indexer + server, open browser
web/                     React + Vite UI (built into dist/web)
test/fixtures/           SYNTHETIC fixtures only — never real user data
docs/
```

Runtime: Node ≥ 22.13 (uses built-in `node:sqlite` with FTS5). TypeScript,
ESM. Dev via `tsx`; published build bundles server to `dist/cli.js` and UI
to `dist/web/`.

## Claude Code format notes (adapter)

- Sessions: `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`.
- Sub-agents: `<project>/<sessionId>/subagents/agent-<id>.jsonl` + `agent-<id>.meta.json`
  (`{agentType, description, toolUseId, model}`). Link to the parent's
  `tool_use` block via `toolUseId` → set `ToolUseBlock.subSessionId`.
- Saved large tool outputs: `<project>/<sessionId>/tool-results/*`.
- Ignore `<project>/memory/` (not chats).
- Record `type`s seen: `user`, `assistant`, `attachment` (many subtypes),
  `system` (subtypes: compact_boundary, api_error, turn_duration,
  stop_hook_summary, local_command, informational, model_refusal_fallback…),
  `custom-title`, `agent-name`, `last-prompt` (has `leafUuid`), `cost-state`,
  `pr-link`, `frame-link`, `summary`, plus pure bookkeeping
  (`api-request*`, `queue-operation`, `file-history-*`, `mode`,
  `permission-mode`, `atis-latch`, `bridge-session`, `relocated`,
  `tools-used`, `artifact-*`).
- `message.content` is a string or a block array: text, thinking, tool_use,
  tool_result (content string or array of text/image/document/tool_reference),
  image (`source.type=base64`).
- Branching: records have `uuid`/`parentUuid`. Active branch = walk up from
  the leaf (last `last-prompt.leafUuid`, else the last message). Compaction
  sets `parentUuid: null` with `logicalParentUuid` — follow that too.
- `isMeta: true` user records and `<system-reminder>`/command wrappers are
  synthetic → visibility `meta`.
- Bookkeeping records produce **no events** but update SessionMeta
  (title, cost, links, models).

## Codex format notes (adapter)

- Sessions: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` and
  `~/.codex/archived_sessions/`. Records `{timestamp, type, payload}`.
- `session_meta` (id, cwd, …), `response_item` (message with role
  user/assistant/developer, reasoning (often encrypted → redacted thinking),
  function_call / custom_tool_call / *_output), `event_msg` (task_started,
  token_count, item_completed, task_complete…), `turn_context`, `world_state`.
- `developer` messages and injected instructions → `meta`.
- Project key = `session_meta.cwd`.

## Index (SQLite, `node:sqlite`)

Cache location: `$AGENTDESK_CACHE` or `~/Library/Caches/agentdesk`
(mac), `$XDG_CACHE_HOME/agentdesk` or `~/.cache/agentdesk` (linux),
`%LOCALAPPDATA%\agentdesk` (windows). File `index.db`. WAL mode.
Contains a `schema_version`; on mismatch the DB is deleted and rebuilt.

Tables (indicative):
- `files(path PK, source_id, size, mtime_ms, indexed_size, indexed_lines, tail_hash, sidecar_mtime, parser_state JSON, parser_version, error_count, error)`
- `sessions(id PK, source_id, native_id, file_path, project_key, project_path, title, first_prompt, started_at, updated_at, event_count, message_count, image_count, models JSON, cost_usd, input_tokens, output_tokens, git_branch, parent_session_id, parent_tool_use_id, agent_description, links JSON)`
- `events(id, session_id, seq, line, line_first_seq, offset, length, role, visibility, synthetic, ts, off_branch, preview, dkey)`
  — `preview` only for conversation events (outline, snippet fallback);
  `dkey` = 64-bit hash of (source, record uuid, index within line), used to
  collapse copies of the same record across forked/resumed sessions.
- `tool_links(session_id, tool_use_id, sub_session_id)`
- `events_fts` — **contentless** FTS5 (`content=''`, `contentless_delete=1`),
  rowid = `events.id`. Meta events are not indexed. Text capped per event
  (16 KB conversation, 6 KB detail); base64-looking strings skipped. The
  server rebuilds snippets from the source event (`src/index/snippet.ts`).

Project keys are agent-agnostic: `path:<normalized abs path>` when the
working directory is known (Claude Code and Codex in the same folder share
a project), `nofolder:` for Claude desktop scratch workspaces, otherwise the
adapter's own key. Two files with the same session id get distinct ids
(`id~<pathhash8>` for the later one).

Search ranking: bm25 × boost (human prompt 3.0, other conversation 2.5,
tool output 1.0); one hit per `dkey`, preferring the on-branch copy, then
the most recently updated session. Query length capped at 500 chars.

Incremental rules per file:
- unchanged size+mtime → skip
- grown and parser_version same → resume parser from `parser_state`, read from `indexed_size`
- prefix changed (tail hash mismatch) or sidecar (`.meta.json`) changed → full re-index
- otherwise → delete that file's rows and re-index fully
- file deleted → delete its rows

Indexing runs in a `worker_thread` (restarted up to 3 times with backoff if it crashes); the main thread serves requests from
whatever is indexed so far and pushes progress over SSE. A file watcher
(`fs.watch` recursive, debounced) re-queues changed files.

## HTTP API

All under `/api`, JSON unless noted. Pagination via `cursor` (opaque) + `limit`.

| Method & path | Returns |
|---|---|
| `GET /api/status` | `{version, sources:[{id,displayName,roots,sessionCount}], index:{state:'idle'|'indexing', done, total}}` |
| `GET /api/projects?source=` | `ProjectMeta[]` sorted by updatedAt desc |
| `GET /api/sessions?source=&project=&q=&cursor=&limit=50&includeSub=0` | `{items: SessionMeta[], nextCursor?}` sorted updatedAt desc. `q` filters title/firstPrompt |
| `GET /api/sessions/:id` | `SessionMeta & {subSessions: SessionMeta[]}` |
| `GET /api/sessions/:id/events?from=0&limit=100&view=conversation\|all&dir=forward\|backward` | `{items: ChatEvent[], nextFrom?, prevFrom?, total}` — `view=conversation` returns visibility conversation+detail; `all` adds meta. Binary stripped → `blobPath`; text blocks > 20 KB truncated (`truncated`). `file_ref.exists` filled in. |
| `GET /api/sessions/:id/events/:seq` | single full `ChatEvent` (no truncation, still no base64) |
| `GET /api/sessions/:id/blob?seq=&path=` | raw bytes with correct Content-Type, `Cache-Control: private, max-age=31536000, immutable` |
| `GET /api/file?path=` | text of a referenced file (tool outputs etc.), only if inside an allowed root; max 5 MB |
| `GET /api/sessions/:id/outline` | human prompts `[{seq, preview, timestamp, offBranch}]` for the outline spine |
| `GET /api/search?q=&source=&project=&cursor=&limit=30` | `{items:[{sessionId, seq, snippet, sessionTitle, projectKey, projectPath, role, timestamp}], nextCursor?}` — snippet is HTML-escaped except `<mark>` |
| `GET /api/sessions/:id/export.md` | Markdown export (text/markdown, attachment) |
| `GET /api/stream` | SSE: `index-progress`, `session-updated {id}` |

Session ids contain `:` — URL-encode them.

## Security

- Bind `127.0.0.1` only (configurable port, default 4782, falls back to free port).
- Random 32-byte token, persisted in `<cache>/token` (0600, cache dir 0700) so
  the browser keeps working across restarts; `--reset-token` rotates it.
  Browser opens `/?t=<token>`; server sets cookie `agentdesk_token_<port>`
  (HttpOnly, SameSite=Strict, Path=/, Max-Age 400 days) and redirects to `/`.
  Every `/api` request requires the cookie (or `Authorization: Bearer`);
  failures return 401 JSON `{error:'unauthorized'}`.
- Reject requests whose `Host` header isn't `127.0.0.1:<port>` / `localhost:<port>`
  (DNS-rebinding defence). No CORS headers.
- CSP on the HTML: `default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'`.
- Chat content is untrusted: UI renders Markdown without raw HTML; never `dangerouslySetInnerHTML` except FTS snippets that the server has escaped.
- `/api/file` resolves real paths and must stay within the adapter roots
  (text only, ≤ 5 MB). Blobs are served inline only for png, jpeg, gif, webp,
  avif, bmp, svg and pdf, always with `Content-Security-Policy: sandbox`;
  anything else is an `application/octet-stream` attachment. Image files a
  chat references outside the roots are served only if their real path has a
  raster-image extension and is ≤ 25 MB.

## UI

- Left: source switch + projects + session list (infinite scroll, search box).
- Center: conversation, virtualized (`@tanstack/react-virtual`), bidirectional
  paging, jump-to-seq from search results. View toggle: Conversation / Everything.
- Tool calls rendered as compact collapsible rows (name + one-line summary),
  results collapsed; sub-agent runs expandable inline (loads that session's events).
- Images: lazy `<img loading=lazy>` to blob URL with fixed aspect placeholder; lightbox.
- Right/top: session info (cost, tokens, models, branch, links, file path).
- Light/dark, keyboard nav (j/k, /, Esc).
