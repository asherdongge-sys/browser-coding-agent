# Browser Provider Modes

The runtime now supports two browser backends behind the same `BrowserProvider` interface.

## Extension mode (default)

```powershell
pnpm dev:runtime
```

The dashboard forwards Agent operations to the connected Chrome Extension Bridge. This preserves the current working flow.

## Playwright mode

Install dependencies first so `pnpm-lock.yaml` is regenerated:

```powershell
pnpm install
```

Then start the runtime with:

```powershell
$env:BROWSER_PROVIDER="playwright"
pnpm dev:runtime
```

On the first run Playwright launches a persistent Chromium profile at `.browser-coding-agent/chromium`. Log into ChatGPT in that browser once. The profile is reused on later runtime restarts, so the ChatGPT session can be restored without the extension.

Useful environment variables:

- `BROWSER_PROVIDER=playwright` — select the managed Chromium backend.
- `BROWSER_CODING_AGENT_PROFILE` — override the persistent profile directory.
- `BROWSER_CODING_AGENT_HEADLESS=1` — run Chromium headlessly (not recommended for the first login).

The web dashboard is still served by the runtime at `http://127.0.0.1:4317/` and displays the active browser backend.