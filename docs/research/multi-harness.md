# Research: agentdesk as a multi-harness app (drive agents, not just read them)

Researched 2026-11-17. Sources are linked inline. Most vendor docs pages are
undated; "fetched 2026-11-17" applies to those. **UNVERIFIED** marks claims
resting on secondary sources, forum posts, or something we could not confirm.
Policy in this area changed several times in 2026, so re-check section 1.1
before shipping anything.

Locally verified on this machine (2026-11-17): `claude` 2.1.308, `codex`
0.166.0, `opencode` 1.18.35, `cursor-agent` installed; flags quoted below were
checked against their `--help`.

---

## TL;DR

- **This is feasible.** It is what T3 Code, Paradev (ex-Superset), Vibe
  Kanban, Jean, Happy and Conductor already do. For each harness, spawn the
  **user's own installed, logged-in, unmodified CLI** as a child process and
  talk to it over its official structured channel:
  - **Claude Code:** the Claude Agent SDK, or `claude -p --input-format
    stream-json --output-format stream-json`.
  - **Codex:** `codex app-server` (JSON-RPC over stdio).
  - **Everyone else:** ACP.
- **Subscriptions:** they work only if **we never touch credentials**.
  - **Anthropic** allows an end user to sign in to the unmodified `claude`
    binary with their own subscription. It forbids third parties from
    "offering claude.ai login", routing requests through users' plan
    credentials, or storing/intermediating tokens.
  - **OpenAI** actively invites third-party apps to use ChatGPT plans.
  - **Google's** Gemini CLI no longer serves personal subscriptions. Its
    successor, Antigravity CLI (`agy`), speaks ACP; its policy for
    third-party use is unverified.
- **Cross-harness spawning:** ship an **agentdesk MCP server**, injected into
  every session we start, with `start_session / send_message / wait / read_result /
  list_sessions / stop`. T3 Code's Orchestrator MCP is the best reference.
- **Fit with the existing codebase:** the harnesses keep writing the JSONL
  files we already index, so durable history comes for free. We add a
  **live layer** (process manager + streaming events + approvals) on top of
  the existing `ChatEvent` model.
- **MVP order:** Claude Code (Agent SDK) → Codex (app-server) → agentdesk MCP
  for cross-spawn → ACP for the long tail.

---

## 1. Integration surfaces per harness

### 1.1 Claude Code

**Surfaces**

| Surface | What it is | Notes |
|---|---|---|
| **Claude Agent SDK** (TS `@anthropic-ai/claude-agent-sdk`, Python) | A library that "runs the Claude Code binary". The npm package ships a platform binary; `pathToClaudeCodeExecutable` points it at the user's installed `claude` | Streaming input (`prompt: AsyncIterable<SDKUserMessage>`), required for `interrupt()`, `setPermissionMode()` and `setModel()`. Also: a `canUseTool` permission callback, in-process hooks, in-process MCP (`createSdkMcpServer` + `tool()`), `agents` (subagents), and `resume` / `forkSession` / `resumeSessionAt` / `persistSession`. The V2 `createSession()` preview was removed in TS 0.3.142. [overview](https://code.claude.com/docs/en/agent-sdk/overview), [TS ref](https://code.claude.com/docs/en/agent-sdk/typescript) |
| **CLI headless** `claude -p --input-format stream-json --output-format stream-json --verbose [--include-partial-messages]` | The same loop as the SDK, without the library | Locally confirmed: `--permission-prompts host\|none`, `--permission-prompt-tool`, `--mcp-config`, `--session-id <uuid>`, `--resume`, `--fork-session`, `--replay-user-messages`, `--agents`. Since v2.1.302, `-p` starts in Manual permission mode. [headless docs](https://code.claude.com/docs/en/headless) |
| **Hooks** | Shell or in-process callbacks on tool and lifecycle events | Useful for `PermissionRequest` and for status/notifications |
| **MCP** | `--mcp-config` / SDK `mcpServers` | This is how we inject the agentdesk tools |
| **ACP** | Zed's adapter `claude-agent-acp` (formerly `@zed-industries/claude-code-acp`), which wraps the Agent SDK | [Zed blog](https://zed.dev/blog/claude-code-via-acp) |
| **Remote Control** (`--remote-control`) | Anthropic's own remote surface | Needs a full `/login`. No public third-party protocol is documented |

- **Transcripts:** the SDK and `-p` write the same
  `~/.claude/projects/<encoded-cwd>/*.jsonl` files as the interactive CLI
  ([sessions](https://code.claude.com/docs/en/agent-sdk/sessions)). Our
  existing adapter indexes them unchanged.
- **Trap: `--bare`.** It "never reads OAuth credentials", and the docs say it
  will become the default for `-p` in a future release. We must pin
  behaviour and test that the subscription login is still used.

**Auth and policy (critical)**

Technically, subscription auth works with the SDK and with `-p`:
- the `/login` credential (Keychain or `~/.claude/.credentials.json`)
- `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`

If `ANTHROPIC_API_KEY` is set, it overrides the subscription silently.
Precedence is cloud provider > `ANTHROPIC_AUTH_TOKEN` > `ANTHROPIC_API_KEY` >
`apiKeyHelper` > OAuth token env > `/login`
([auth docs](https://code.claude.com/docs/en/authentication)).

What the policy says, from the
[legal & compliance page](https://code.claude.com/docs/en/legal-and-compliance)
(the controlling text, fetched 2026-11-17):

- **Who OAuth is for:** subscription OAuth is "intended exclusively for
  purchasers of" those plans, for "ordinary use of Claude Code and other
  native Anthropic applications".
- **Developers,** including Agent SDK developers, "should use API key
  authentication".
- **Prohibited for third parties:**
  - to "offer Claude.ai login into their own applications"
  - to "route requests through Free, Pro, Max, or Ultra plan credentials on
    behalf of their users"
  - to "collect, store, or intermediate Claude.ai credentials or session
    tokens"
- **Sign-in** "must complete through Anthropic's own flow".
- **Carve-out:** the rule does not "prevent an end user from signing in to the
  unmodified Claude Code binary with their own Claude subscription".
- **Conditions on products that run Claude Code:** don't modify the binary or
  remove its login methods; don't resell or intermediate usage; each end user
  authenticates with their own credentials.
- **Advertised limits** "assume ordinary, individual usage".
- **Enforcement** may happen "without prior notice".

The Agent SDK overview carries a related note: "Unless previously approved,
Anthropic does not allow third party developers to offer claude.ai login or
rate limits for their products, including agents built on the Claude Agent
SDK."

**Timeline** (the policy has moved a lot; partly from press):
- **Jan 2026:** Anthropic blocks clients spoofing Claude Code; some accounts
  banned.
- **Feb 19–20, 2026:** OpenCode removes Claude Pro/Max OAuth after "legal
  requests" ([The Register](https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access)).
- **Feb 18, 2026:** Thariq (Anthropic) calls the docs change a "clean up" and
  says Agent SDK use with Max is unchanged
  ([The New Stack](https://thenewstack.io/anthropic-agent-sdk-confusion/);
  exact wording **UNVERIFIED**).
- **Apr 2026:** third-party agents (OpenClaw) cut off from subscriptions.
  Reinstated in May with a separate "Agent SDK credit" planned from June 15
  ([VentureBeat](https://venturebeat.com/ai/anthropic-reinstates-openclaw-and-third-party-agent-usage-on-claude-subscriptions-with-a-catch/),
  [The Register](https://www.theregister.com/ai-ml/2026/05/14/anthropic-tosses-agents-into-the-api-billing-pool/5240748)).
- **June 15, 2026:** that credit change is paused. The help centre says "Claude
  Agent SDK, `claude -p`, and third-party app usage still draw from your
  subscription limits"
  ([support](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)).
  A Nov 12 article about Zed implies a separate credit again (**UNVERIFIED**;
  treat the current billing state as in flux).
- **Oct 7, 2026:** Max/Ultra/Team plans gain monthly API credits, usable only
  through an API key from a linked Console org
  ([support](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-ultra-and-team-plans)).

**What this means for agentdesk**

| | Pattern |
|---|---|
| ✅ Permitted (carve-out) | The user installs the official `claude`, runs `claude /login` themselves (Anthropic's flow, our app never sees the token), and agentdesk spawns that unmodified binary on the user's own machine for that user. Usage counts against their own plan. |
| ❌ Prohibited | Our own "Sign in with Claude" button or OAuth flow. Reading, copying or storing the token (Keychain, `.credentials.json`, capturing `setup-token` output). Calling the Messages API with subscription tokens. Spoofing the client. One login serving several people. Hosted/cloud relays of a user's subscription. Branding as "Claude Code". |
| ⚠️ Ambiguous | **Bundling the Agent SDK's own binary vs. pointing at the user's `claude`:** pointing at the user's installed binary is the closer fit to the carve-out text, so prefer `pathToClaudeCodeExecutable`. **Heavy parallel automation** (many concurrent sessions, agents spawning agents) may exceed "ordinary, individual usage". **The SDK-overview sentence** sits awkwardly next to the binary carve-out. |

**Limits:** Max is a 5-hour window plus a weekly cap shared between claude.ai
and Claude Code. Parallel sessions draw from the same pool; no absolute numbers
are published
([Max plan](https://support.claude.com/en/articles/11049741-what-is-the-max-plan)).
Show remaining usage in our UI if the stream exposes it.

### 1.2 Codex (OpenAI)

**Surfaces**

| Surface | Notes |
|---|---|
| **`codex app-server`** (stdio JSON-RPC, JSONL; WebSocket is "experimental and unsupported") | Powers the VS Code extension and is the **recommended surface for product integrations** ([docs](https://learn.chatgpt.com/docs/app-server)). Model: Thread → Turn → Item. Methods include `thread/start`, `turn/start`, `turn/steer`, `turn/interrupt`. Server→client approvals: `item/commandExecution/requestApproval` (accept / acceptForSession / decline / cancel / execpolicy amendment), `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `mcpServer/elicitation/request`. Also `account/login/start` (apiKey / chatgpt / deviceCode), `account/rateLimits/read`. **Typed:** `codex app-server generate-ts --out DIR` and `generate-json-schema` (locally confirmed). Many methods sit behind `experimentalApi`, so pin versions. Locally, 0.166 also has `codex app-server daemon …` (a shared local daemon) and `codex agents` (browse sessions on that daemon). |
| `codex exec --json` | JSONL events: `thread.started`, `turn.*`, `item.*`. Resume with `codex exec resume <id>`. Simpler, but no mid-turn approvals ([docs](https://learn.chatgpt.com/docs/non-interactive-mode)) |
| **Codex SDK** (TS `@openai/codex-sdk`, Python `openai-codex`) | TS spawns the CLI over JSONL. Python drives app-server and bundles a pinned CLI ([TS](https://github.com/openai/codex/tree/main/sdk/typescript), [docs](https://learn.chatgpt.com/docs/codex-sdk)). Whether TS uses exec or app-server underneath is **UNVERIFIED**. |
| `codex mcp-server` | **Removed.** Docs point to app-server; it is absent from local 0.166 `--help` ([docs](https://developers.openai.com/ja-JP/docs/mcp-server)). The removal version is **UNVERIFIED**. |
| ACP | Via the `codex-acp` adapter (lags upstream) |

- **Auth:** ChatGPT sign-in or an API key, stored in `~/.codex/auth.json` or
  the keyring ([auth](https://learn.chatgpt.com/docs/auth)). app-server can run
  the ChatGPT login flow itself (Codex owns and refreshes the token), so
  agentdesk can offer "Sign in" by calling `account/login/start`. Our code still
  never sees the token.
- **Policy: permissive.**
  - "Sign in with ChatGPT" plan usage (launched DevDay 2026-09-29) is offered
    to open-source partners and selected private clients. Listed partners
    include Amp, Warp, Conductor, OpenCode and T3 Code
    ([SIWC](https://learn.chatgpt.com/docs/sign-in-with-chatgpt.md),
    [open-source flow](https://developers.openai.com/siwc/token-sharing-open-source)).
  - That programme covers apps calling models directly. Spawning the user's own
    `codex` binary is the intended use of app-server.
  - app-server docs say its auth has "never been permitted for commercial or
    hosted services". A local, user-run app is fine.
- **Transcripts:** threads persist as rollout JSONL under `~/.codex/sessions`,
  which our Codex adapter already reads.
- ⚠️ **Watch:** local 0.166 has `codex migrate-rollouts` ("migrate legacy local
  sessions to paginated thread history"). The on-disk format may be changing,
  which would affect our existing Codex adapter. Investigate separately.

### 1.3 Others

| Harness | Structured surface | ACP | Subscription login | Notes |
|---|---|---|---|---|
| **Gemini CLI** | `-p --output-format json\|stream-json` ([headless](https://geminicli.com/docs/cli/headless/)) | Native `gemini --acp` ([acp](https://geminicli.com/docs/cli/acp-mode/)) | **No longer for personal AI Pro/Ultra or free accounts since 2026-06-18**; API key or Code Assist enterprise only | Superseded by Antigravity CLI ([Google blog 2026-05-19](https://developers.googleblog.com/en/an-important-update-transitioning-gemini-cli-to-antigravity-cli/)) |
| **Antigravity CLI** (`agy`) | `-p`, json / stream-json ([headless](https://antigravity.google/docs/cli/headless.md)) | Native `agy acp` ([acp](https://antigravity.google/docs/cli/acp.md)) | Google sign-in | Third-party orchestration policy **UNVERIFIED**: one non-staff forum reply says it is OK ([thread](https://discuss.ai.google.dev/t/is-orchestrating-the-official-antigravity-cli-from-a-local-multi-agent-coding-application-allowed/181088)) |
| **opencode** | `opencode serve`: HTTP + OpenAPI 3.1 + SSE `/event`, generated SDK ([server](https://opencode.ai/docs/server/)) | Native `opencode acp` | ChatGPT Plus/Pro, Copilot, OpenCode Go. **No Claude Pro/Max** (removed after Anthropic legal requests) | Its own agent; it does not wrap Claude Code |
| **Amp** | `amp -x --stream-json [--stream-json-input]`, `@ampcode/sdk` ([docs](https://ampcode.com/docs/cli/streaming-json)) | Community adapters only | Amp account (can draw on a ChatGPT plan via SIWC) | |
| **Cursor CLI** (`agent`, formerly `cursor-agent`) | `-p --output-format json\|stream-json [--stream-partial-output]` ([headless](https://cursor.com/docs/cli/headless)) | Native `agent acp` ([acp](https://cursor.com/docs/cli/acp)) | Cursor login or `CURSOR_API_KEY` | Without `--force`, gated actions are rejected in `-p`. ACP gaps: no list/resume, and MCP passed via `session/new` doesn't work (**UNVERIFIED**, forum) |
| **Aider** | `--message`; Python `Coder.create` unsupported ([scripting](https://aider.chat/docs/scripting.html)) | No | API keys only | Low priority |

### 1.4 ACP (Agent Client Protocol) as a common layer

**What it is:** JSON-RPC 2.0 over stdio between a client and an agent
subprocess; originated at Zed. The current schema is v1.32.x, with a v2 alpha
track ([schema](https://agentclientprotocol.com/protocol/schema),
[releases](https://github.com/agentclientprotocol/agent-client-protocol/releases)).

- **Agent methods:** `initialize`, `authenticate`, `session/new`,
  `session/prompt`, `session/cancel`, `session/set_mode`. Optional:
  `session/load`, `list`, `resume`, `close`. Fork is unstable.
- **Client methods (what we would implement):** `session/request_permission`,
  `fs/*`, `terminal/*`, `elicitation/*`.
- **Streaming:** `session/update` carries message chunks, tool calls, plan,
  modes and commands.
- **MCP servers** are passed in `session/new`, which suits injecting our
  orchestration MCP.

**Who speaks it** ([agents](https://agentclientprotocol.com/overview/agents),
[clients](https://agentclientprotocol.com/overview/clients)):
- **Natively:** Gemini, Antigravity, opencode, Cursor, Goose, Copilot
  (preview), Cline, Junie, Kiro, Qwen Code, Mistral Vibe, OpenHands, Factory
  Droid and others.
- **Via adapters:** Claude (`claude-agent-acp`) and Codex (`codex-acp`).
- **Clients:** Zed, JetBrains, Neovim, Emacs and VS Code extensions.

**Verdict: use ACP for breadth, not for the two harnesses that matter most.**
ACP gives a uniform prompt / stream / permission / terminal / fs loop for a
long tail of agents. What we would lose by using it for Claude or Codex:
- resume/list/fork are optional and implemented unevenly
- little usage or rate-limit data
- login stays per-harness and out of band
- vendor features don't map: Codex `turn/steer`, execpolicy amendments, rate
  limits; Claude `forkSession`, `resumeSessionAt`, hooks, SDK MCP
- adapters lag upstream releases
- subagent display is only as rich as each agent's `tool_call` updates

Native for Claude Code and Codex, ACP for the rest, is what T3 Code, Paradev,
Vibe Kanban and Jean converged on.

---

## 2. How existing products do it

From product docs and, for open-source ones, a grep of their source.

| Product | Integration | User's subscription | Worktrees / parallel | Agent spawns agent / cross-harness | OSS |
|---|---|---|---|---|---|
| **T3 Code** (pingdotgg/t3code) | Claude: Agent SDK. Codex: `codex app-server` with generated schema (`packages/effect-codex-app-server`). ACP registry for others; OpenCode, Cursor | Yes (`CodexChatGptAuth.ts`; checks `CLAUDE_CODE_OAUTH_TOKEN`) | Worktree MCP tools (`t3_worktree_handoff/list`) | **Yes, cross-provider.** Orchestrator MCP: `t3_thread_launch` (target `providerInstanceId` + `model`, `mode: "wait"`), `_send`, `_wait`, `_read`, `_interrupt`, `_transfer`. Delegated runs may only narrow permissions | MIT, local server (browser/phone) |
| **Paradev** (formerly Superset; renamed around Oct 2026) | Terminal panes (node-pty + tmux daemon) **and** a chat runtime: Agent SDK `query()`, `codex app-server --stdio`, ACP | Yes ("your own subscriptions") | Worktree per task, SSH hosts | MCP `agents_create`, `workspaces_create`, `terminals_create/send/read`; also a CLI + skill (`superset:orchestrate`) ([docs](https://docs.paradev.com/orchestration)) | MIT now (earlier ELv2) |
| **Conductor** | Bundled or system Claude Code (Agent SDK per Anthropic); also Codex, OpenCode, Cursor ([harnesses](https://www.conductor.build/docs/reference/harnesses/claude-code)) | Yes; warns that an `ANTHROPIC_API_KEY` env var overrides the subscription | Worktree per workspace; cloud microVMs | Agent tools `CreateWorkspace`, `CreateSession` ([skill](https://www.conductor.build/.well-known/agent-skills/conductor/SKILL.md)) | Closed, Mac |
| **Vibe Kanban** | Claude via `stream-json` in/out; Codex via app-server protocol types; ACP for others (Rust) | Yes | `worktree-manager` crate | MCP: `create_session`, `run_session_prompt`, `list_sessions`, … (34 tools) | Apache-2.0 |
| **Jean** (coollabsio) | Claude `stream-json`; Codex app-server; ACP | Yes ("your own CLI installations") | Worktree per task | Renders Codex `spawn_agent` events; no cross tool | Apache-2.0 |
| **Happy** (slopus) | Claude "local" (real CLI in a terminal) or "remote" (Agent SDK); Codex app-server; ACP | Yes | — (mobile remote) | — | MIT |
| **Emdash** | ACP (`claude-agent-acp`, `codex-acp`) plus node-pty TUI runtime | Yes | Parallel worktrees | Passes MCP into ACP sessions | Apache-2.0 |
| **Sculptor** (Imbue) | Claude CLI `stream-json`; generic tmux "terminal agent" | Yes | Worktrees; Docker experimental | — | MIT |
| **Crystal → Nimbalyst** | `claude -p stream-json` inside node-pty; `codex exec --json` | Yes | Worktree per session | — | MIT (Crystal now redirects) |
| **Claude Squad** | tmux + PTY, any CLI | Yes | Worktree per instance | — | AGPL-3.0 |
| **Terragon** | Cloud daemon; Claude `stream-json`, `codex exec --json` | Took user tokens into the cloud (**UNVERIFIED**); exactly the pattern Anthropic now forbids | Cloud sandboxes | — | Shut down; terragon-oss Apache-2.0 |
| **Zed** | ACP external agents ([docs](https://zed.dev/docs/ai/external-agents)) | Claude via `/login`; Codex manages its own auth | Threads | — | GPL (**UNVERIFIED**) |
| **Warp** | Runs the CLIs as plain terminal panes, plus plugins for status ([docs](https://docs.warp.dev/agent-platform/cli-agents/overview.md)) | Yes | Tabs; Oz cloud orchestration | Via Oz (**UNVERIFIED**) | Closed |
| **Cline / Roo** | Cline "Claude Code" provider spawns local `claude` per message ([docs](https://docs.cline.bot/provider-config/claude-code.md)); both have a ChatGPT-OAuth "OpenAI Codex" provider | Yes | No | No | Apache-2.0 |
| **OpenAI codex-plugin-cc** | A Claude Code plugin wrapping the local `codex app-server`: **Claude Code delegates to Codex** (`/codex:rescue`, review) ([write-up](https://codex.danielvaughan.com/2026/04/12/codex-plugin-cc-cross-provider-bridge/)) | ChatGPT or key | — | Yes (Claude → Codex) | OSS (license **UNVERIFIED**) |
| **agentapi** (Coder) | Screen-scraped a terminal emulator | — | — | HTTP API | **Archived**: screen-scraping didn't hold up |

**Lessons**

1. **One structured channel per harness is the consensus.**
   - Claude: Agent SDK or raw `stream-json`.
   - Codex: `app-server`. `exec --json` is the older choice; `mcp-server` is
     gone.
   - Long tail: ACP.
2. **The serious apps also keep a raw PTY terminal** next to the chat. It is
   the escape hatch for interactive TUIs, `/login`, and unknown CLIs.
   Screen-scraping as the *main* channel failed (agentapi).
3. **Use the user's installed CLI and never touch tokens.** Warn when
   `ANTHROPIC_API_KEY` is set (Conductor does).
4. **Copy T3 Code's Orchestrator MCP shape** for cross-harness work.
5. **Expose orchestration twice:** MCP tools plus an `agentdesk` CLI and skill
   (Paradev does both). The CLI route works in any harness, even one whose MCP
   injection is broken.
6. **Record/replay fixtures against real CLIs** (T3, Paradev, Sculptor),
   because the stream schemas change often. Generate Codex types from
   app-server.
7. **Worktree-per-task is table stakes, and churn is high:** Crystal →
   Nimbalyst, Superset → Paradev, Terragon and agentapi shut down. Being local,
   open source and on the user's own subscriptions is now the norm, not a moat.
   agentdesk's angle could be **history depth**: unified search and index
   across all harnesses, including sessions started outside agentdesk. Nobody
   above does this well.

---

## 3. Cross-harness orchestration design

### 3.1 Process model

```
web UI ──HTTP/SSE(or WS)── agentdesk server (Node, 127.0.0.1)
                              │
                              ├─ SessionManager  (live sessions, state machine)
                              │    ├─ ClaudeDriver  → Agent SDK query() → user's `claude`
                              │    ├─ CodexDriver   → `codex app-server` (stdio JSON-RPC)
                              │    └─ AcpDriver     → `<agent> acp` (stdio JSON-RPC)
                              ├─ ApprovalBroker  (pending permission requests → UI)
                              ├─ WorktreeManager (git worktree add/remove, setup scripts)
                              ├─ Orchestrator MCP (streamable HTTP on localhost, per-session token)
                              └─ existing indexer (tails ~/.claude, ~/.codex JSONL → SQLite)
```

**The driver interface** sits beside `SourceAdapter` (`src/core/adapter.ts`).
Adapters stay pure parsers; drivers own processes.

```ts
interface HarnessDriver {
  id: SourceId;                       // 'claude-code' | 'codex' | 'acp:<agent>'
  detect(): Promise<{ installed: boolean; version?: string; loggedIn?: boolean; authKind?: 'subscription'|'apiKey'|'unknown' }>;
  start(opts: { cwd: string; model?: string; prompt: Block[]; resumeNativeId?: string;
                mcpServers: McpServerSpec[]; permissionMode: PermissionMode; parent?: LiveSessionRef }): Promise<LiveSession>;
}
interface LiveSession {
  nativeId: string;                   // = the id in the JSONL the harness writes
  events: AsyncIterable<LiveEvent>;   // normalized deltas + ChatEvent-shaped blocks + status
  send(prompt: Block[]): Promise<void>;
  interrupt(): Promise<void>;
  respond(approvalId: string, decision: ApprovalDecision): void;
  setModel?(m: string): Promise<void>;
  stop(): Promise<void>;
}
```

### 3.2 Event model: live and durable

- **Durable:** the harnesses write the same JSONL whether driven by us or not.
  The existing indexer stays the source of truth for history, search and
  replay. `ChatEvent` keeps `line`/`offset`, which only exist once a record is
  on disk.
- **Live:** the driver emits `LiveEvent`s, streamed to the UI over SSE:
  - text/thinking deltas
  - tool-call start/progress/end
  - approval requests
  - status (`running` / `waiting_approval` / `idle` / `error`)
  - usage and rate limits

  They reuse the `Block` types from `src/core/types.ts`, mapped from the
  stream (SDK messages and app-server items map almost 1:1 onto our blocks).
- **Reconciliation:** key both by `nativeId` (Claude `session_id` / Codex
  thread id = the file stem the adapter already uses). The UI renders indexed
  events, then a live tail. When the indexer catches up past a live item
  (match on record uuid where the stream carries one, else turn boundaries),
  the live item is dropped. Pass `--session-id` / `thread/start` so we know the
  file before the first byte lands.
- **Indexer:** watch the files of live sessions with a short debounce. The
  incremental append path and `snapshot`/`resume` already exist.
- **Session tree:** sessions we start get a `session_overlays` row
  (`parent_native_id`, `spawn_kind='spawned'`, plus a new
  `harness`/`launched_by='agentdesk'`). The existing nested tree then shows
  **cross-harness parentage**, such as a Codex child under a Claude parent,
  which neither vendor's own files can express.

### 3.3 Orchestrator MCP ("agentdesk" tools)

Inject into every session we start: Claude via SDK `mcpServers` /
`--mcp-config`, Codex via `-c mcp_servers.agentdesk=…` or app-server config,
ACP via `session/new.mcpServers`. Serve it from the agentdesk process as
streamable HTTP on 127.0.0.1, with a **per-session bearer token**. The token
identifies the caller, which sets the parent link and lets us enforce policy.

| Tool | Args | Returns |
|---|---|---|
| `list_harnesses` | — | installed harnesses, models, login state (no secrets) |
| `start_session` | `harness`, `model?`, `prompt`, `cwd?` (default caller's), `worktree?: 'new'\|'same'\|path`, `permission?` (≤ caller's), `wait?: {timeoutSec}` | `session_id`, and the final result if `wait` |
| `send_message` | `session_id`, `prompt`, `wait?` | ack / result |
| `wait` | `session_ids[]`, `timeoutSec`, `any\|all` | statuses + final messages |
| `read_result` | `session_id`, `mode: 'final'\|'summary'\|'transcript'`, `sinceSeq?` | last assistant message, or a paged transcript from the index |
| `list_sessions` | `scope: 'children'\|'project'\|'all'`, `status?` | ids, titles, harness, status |
| `stop` / `interrupt` | `session_id` | — |

- **Rules:**
  - A child's permissions can only be **narrower** than its parent's (T3 Code
    does this).
  - Cap depth and fan-out, for example depth 3 and 4 concurrent children per
    parent, configurable. This protects the user's subscription limits and
    stays within "ordinary usage".
  - Require a final structured report from workers (status
    completed/blocked + summary).
- **Also ship an `agentdesk` CLI** (`agentdesk session start --harness codex
  …`) plus a skill/AGENTS.md snippet, for harnesses where MCP injection is flaky
  (Cursor ACP).
- **Example: Claude starts a Codex review.** Claude calls
  `start_session({harness:'codex', model:'gpt-…', prompt:'review diff', worktree:'same', wait:{timeoutSec:900}})`.
  CodexDriver spawns `codex app-server` and runs `thread/start` + `turn/start`.
  Approvals surface in our UI. On `turn/completed`, the tool returns the final
  message to Claude. The UI shows the Codex session nested under the Claude one.

### 3.4 Approvals

Every harness asks "may I run X?" in its own way. All of them go into one
`ApprovalBroker` queue, shown in the UI per session and globally (badge,
desktop notification):

| Harness | Approval mechanism |
|---|---|
| Claude | SDK `canUseTool(tool, input)`. Resolve the promise when the user clicks. `PermissionRequest` hook as fallback |
| Codex | app-server `item/*/requestApproval`. Reply with accept / acceptForSession / decline |
| ACP | `session/request_permission`. Reply with the chosen option |

- **Orchestrated children:** their approvals bubble to the **user**, not to
  the parent agent, by default. An option can let a parent auto-approve
  within its own allowed scope.
- **Timeout:** an unanswered approval holds the session in
  `waiting_approval`. A parent `wait` returns status `blocked:
  waiting_approval`.

### 3.5 Worktrees

- `WorktreeManager`: `git worktree add <repo>/.agentdesk/worktrees/<slug>`
  (or a sibling dir), on branch `agentdesk/<slug>`.
- Optional setup script per repo (copy `.env`, install deps).
- Archive/cleanup with a retention cap.
- Children default to the **parent's cwd** for read-only tasks (review) and a
  **new worktree** for writing tasks.
- The existing project grouping by `path:` already maps worktrees back to the
  repo via `projectPath` overlays.

---

## 4. Recommendation

### Architecture

Keep the single local Node process (Hono + `node:sqlite`). Add:

- `src/drivers/` with `claude-code` (Agent SDK, `pathToClaudeCodeExecutable` =
  the user's `claude`), `codex` (app-server client with **generated TS types
  pinned per Codex version**) and later `acp` (generic client;
  `@agentclientprotocol/sdk`).
- `src/live/`: SessionManager, ApprovalBroker, WorktreeManager.
- `src/mcp/`: the orchestrator MCP server.
- An SSE endpoint for live events; POST endpoints for send / interrupt /
  approve.
- A UI composer plus approval cards plus a live tail on the existing chat
  view.
- An embedded terminal (xterm.js + node-pty) as a **later** escape hatch for
  `/login` and interactive TUIs. Not MVP; the login can be a "run this command"
  instruction at first.

### MVP order

1. **Claude Code live sessions.**
   - Detect `claude` and its login state without reading credentials (e.g.
     `claude auth status`, or a cheap SDK init and the reported
     `apiKeySource`).
   - Start/resume in a cwd; stream; approvals via `canUseTool`;
     interrupt/stop.
   - Warn if `ANTHROPIC_API_KEY` is set.
   - Live tail reconciled with the indexer.
2. **Codex via app-server.** Same features, plus rate-limit display. Login
   button via `account/login/start` (Codex owns the token).
3. **Orchestrator MCP + agentdesk CLI:** `start_session` / `wait` /
   `read_result` across both harnesses, nested tree, worktrees.
4. **ACP driver** for opencode, Cursor, Antigravity, Gemini (API key), Goose,
   etc.
5. Embedded PTY terminal; per-repo setup scripts; usage dashboard.

### Risks

| Risk | Mitigation |
|---|---|
| **Anthropic ToS / enforcement**: policy changed about 4 times in 2026; heavy automation may be read as non-"ordinary" use | Never handle tokens; spawn the unmodified user binary; offer an API-key mode; document clearly; cap fan-out; don't brand as Claude Code. **Consider asking Anthropic for written approval** before promoting subscription use publicly. |
| `--bare` becoming the default for `-p`, or the SDK bundling changes | Use the SDK with an explicit executable path; a CI canary that asserts subscription auth is used |
| Protocol churn (app-server experimental APIs, stream-json fields, ACP v2, Codex rollout migration) | Pin and detect versions; generated types; record/replay fixtures from real CLIs; tolerant parsing (already a principle) |
| Codex on-disk format change (`migrate-rollouts`) | Check the new format and update `src/adapters/codex` |
| Windows: spawning `.cmd` shims, path quoting, node-pty build, worktree paths, Keychain vs file creds | `cross-spawn`; test on a Windows runner; PTY optional |
| Runaway costs and limits from recursive spawning | Depth/fan-out caps, a global concurrency limit, usage display, kill-all |
| Security: a local server that can now **execute code** via agents | Keep the 127.0.0.1 + host/origin checks; add CSRF tokens for mutating routes; per-session MCP tokens; no remote exposure by default |
| Crowded market (T3 Code, Paradev, Conductor, Vibe Kanban) | Lead with what we have: cross-harness history, search and nested trees, including sessions started outside the app |

### Open questions for the user

1. **Claude auth stance:** ship subscription use (user's own `claude`, never
   touching tokens) as the default, API key optional? Or ask Anthropic for
   approval first?
2. **Read-only principle:** the SPEC says "never write to `~/.claude`,
   `~/.codex`". Driving harnesses makes them write there, which is fine, but
   agentdesk itself would now run code and create worktrees and branches.
   Update the principles?
3. **Where approvals go for agent-spawned children:** always the human, or may
   a parent approve within its own scope?
4. **Embedded terminal in v1, or later?**
5. **Default isolation for spawned sessions:** same cwd, or a new worktree?
6. **Remote/mobile access:** stay strictly localhost for now? Remote access
   raises the ToS and security stakes.
7. **Which harnesses after Claude and Codex?** opencode and Cursor (ACP) are
   cheapest. Gemini personal subscriptions no longer work; Antigravity's policy
   is unclear.
