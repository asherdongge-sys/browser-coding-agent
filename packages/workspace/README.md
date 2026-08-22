# Workspace

`@browser-coding-agent/workspace` is the workspace/file safety boundary for coding agents.

The package intentionally separates agent intent from storage backends:

```text
Agent Runtime
    -> Workspace
        -> WorkspaceBackend
            -> LocalWorkspace (MVP)
            -> future: GitWorkspace / GitHubWorkspace / RemoteWorkspace
```

## MVP guarantees

- Workspace-relative path validation prevents path traversal outside the selected root.
- Reads return a SHA-256 snapshot so later writes can use optimistic concurrency checks.
- `applyEdits()` applies exact, non-overlapping replacements and verifies every old-text precondition before changing the file.
- Writes are atomic through a temporary file followed by rename.
- A stale `expectedSha256` fails instead of silently overwriting another change.
- Search is bounded to common generated/dependency directories and files up to 1 MiB.

The public `WorkspaceBackend` interface is the extension point for future storage providers. The agent should depend on `Workspace` rather than a concrete filesystem or GitHub API.
