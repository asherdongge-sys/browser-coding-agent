# Browser Coding Agent

Browser-based autonomous coding agent inspired by local Codex-style development workflows.

## Current milestone: local workspace tools

The runtime can now select a local workspace and expose safe filesystem operations over WebSocket JSON-RPC.

```text
Chrome Extension / CLI client
          │ WebSocket
          ▼
127.0.0.1:4317
          │
          ├── workspace.select
          ├── workspace.info
          ├── tools.list
          └── tool.call
                │
                ├── fs.list
                ├── fs.read
                ├── fs.search
                └── fs.write (approval required)
```

## Quick test

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm dev:runtime
```

In another terminal:

```bash
npx wscat -c ws://127.0.0.1:4317
```

Select this repository as the workspace:

```json
{"jsonrpc":"2.0","id":1,"method":"workspace.select","params":{"path":"E:/web/browser-coding-agent"}}
```

List files:

```json
{"jsonrpc":"2.0","id":2,"method":"tool.call","params":{"call":{"tool":"fs.list","arguments":{"path":"."}}}}
```

Read a file:

```json
{"jsonrpc":"2.0","id":3,"method":"tool.call","params":{"call":{"tool":"fs.read","arguments":{"path":"README.md"}}}}
```

`fs.write`, terminal, and Git operations are intentionally permission-gated. The runtime binds to `127.0.0.1` and filesystem paths are constrained to the selected workspace.

## Vision

Turn the browser into a coding workspace where an AI agent can inspect a local project, plan changes, edit files, run tests, diagnose failures, review diffs, and—only with explicit permission—perform Git operations.

## Monorepo layout

- `apps/extension` — Chrome Extension UI and browser integration
- `apps/runtime` — local Node.js/TypeScript runtime
- `packages/protocol` — shared transport and RPC message types
- `packages/agent-core` — planning and agent loop
- `packages/tools` — filesystem, terminal, Git and workspace tools
- `packages/permissions` — capability and approval policy
- `packages/shared` — shared utilities and domain types

## Engineering principles

- Least privilege by default
- Explicit user approval for risky actions
- Workspace-bound filesystem access
- Typed protocols and tool contracts
- Small composable tools instead of a monolithic executor
- Verify changes with tests and diffs
- Keep the MVP simple; add multi-agent orchestration only after the single-agent loop is reliable

## Initial tool surface

```text
fs.list
fs.read
fs.write
fs.search
terminal.exec
terminal.kill
git.status
git.diff
git.log
git.commit
workspace.info
workspace.select
agent.start
agent.cancel
agent.status
```

## Status

Local workspace filesystem milestone in progress.
