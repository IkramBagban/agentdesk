# agentdesk

Read every conversation you've had with your coding agents (Claude Code and
Codex, with more to come) in a fast, private viewer that runs on your own
computer.

```bash
npx agentdesk
```

It finds your history, indexes it, and opens the viewer in your browser.

## What you get

- **Every chat, grouped by project.** This includes runs from helper agents,
  which open from the tool call that started them.
- **The whole conversation.** Your prompts, the agent's replies, its thinking,
  every tool call with its result, and images you pasted or that tools
  produced.
- **Search across everything**, with matches highlighted. Clicking a match
  jumps to the exact spot.
- **A clean default view.** Background context the agent app adds is hidden
  until you switch to "Everything".
- **Live updates.** Chats that are still running update as you read.
- **Markdown export** of any chat.

## Private by design

- Your chats never leave your computer. There is no account, no server of
  ours and no analytics.
- Your history is opened read-only. The only thing written is a search index
  in your cache folder, which you can delete at any time.
- The viewer listens only on `127.0.0.1`. It uses a private link (shown in
  your terminal) so other websites and apps on your machine can't read your
  chats.

## Requirements

Node.js 22.13 or newer. If you use Claude Code, you already have Node.

## Where it looks

| Agent | Location |
|---|---|
| Claude Code | `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR/projects`) |
| Codex | `~/.codex/sessions` and `~/.codex/archived_sessions` (or under `$CODEX_HOME`) |

The search index lives in `~/Library/Caches/agentdesk` on macOS,
`~/.cache/agentdesk` on Linux, and `%LOCALAPPDATA%\agentdesk` on
Windows.

## Options

```
--port <n>          Port to listen on (default 4782; tries the next 20 if busy)
--no-open           Do not open the browser
--root <path>       Scan this folder instead of the default locations (repeatable)
--claude-root <p>   Use this folder for Claude Code history (repeatable)
--codex-root <p>    Use this folder for Codex history (repeatable)
--cache-dir <path>  Where to keep the search index
--reindex           Rebuild the search index from scratch
```

To open an old backup of your history, run it with `--claude-root /path/to/backup/projects`.

## Development

```bash
pnpm install
pnpm test           # unit tests
pnpm typecheck
pnpm build          # builds dist/cli.js, dist/worker.js and dist/web
node dist/cli.js
```

For live UI development, run `AGENTDESK_DEV_TOKEN=dev-token pnpm dev`, which starts
the server on port 4782 and Vite on port 5173.

How it works, and how to add support for another agent, is in
[docs/SPEC.md](docs/SPEC.md). Each agent is one adapter in `src/adapters/`
that turns its files into a shared format.

## License

MIT
