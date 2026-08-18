# Browser Coding Agent

Browser-based autonomous coding agent inspired by local Codex-style development workflows.

## Vision

Turn the browser into a coding workspace where an AI agent can inspect a local project, plan changes, edit files, run tests, diagnose failures, review diffs, and—only with explicit permission—perform Git operations.

## MVP architecture

```text
Chrome Extension
      │ WebSocket / JSON-RPC-style messages
      ▼
Local Agent Runtime
      ├── Agent Core
      ├── Tool Registry
      ├── Permission Manager
      └── Workspace Manager
             │
       ┌─────┼─────┐
       ▼     ▼     ▼
   Filesystem Shell Git
```

## Monorepo layout

- `apps/extension` — Chrome Extension UI and browser integration
- `apps/runtime` — local Node.js/TypeScript runtime
- `packages/protocol` — shared transport and RPC message types
- `packages/agent-core` — planning and agent loop
- `packages/tools` — filesystem, terminal, Git and workspace tools
- `packages/permissions` — capability and approval policy
- `packages/shared` — shared utilities and domain types
- `agents` — reusable agent personas
- `skills` — engineering skills and instructions
- `workflows` — feature, bugfix and review workflows
- `docs` — architecture and protocol documentation

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
fs.delete
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

Early architecture / bootstrap stage.
