import { access, mkdir } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export type ChromeLauncherOptions = {
  executablePath?: string;
  profileDir?: string;
  cdpPort?: number;
  cdpUrl?: string;
  url?: string;
};

export type ChromeLaunchHandle = {
  endpoint: string;
  profileDir: string;
  spawned: boolean;
  process?: ChildProcess;
};

const DEFAULT_CDP_PORT = 9222;
const DEFAULT_URL = "https://chatgpt.com/";

function normalizeExecutable(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

async function firstExisting(paths: string[]): Promise<string | undefined> {
  for (const path of paths) {
    try {
      await access(path);
      return path;
    } catch {
      // Try the next known location.
    }
  }
  return undefined;
}

export async function resolveChromeExecutable(explicit?: string): Promise<string> {
  const configured = normalizeExecutable(explicit) ?? normalizeExecutable(process.env.BROWSER_EXECUTABLE);
  if (configured) return configured;

  if (platform() === "win32") {
    const local = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const found = await firstExisting([
      join(local, "Google", "Chrome", "Application", "chrome.exe"),
      join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
      join(local, "Chromium", "Application", "chrome.exe"),
    ]);
    if (found) return found;
  }

  if (platform() === "darwin") {
    const found = await firstExisting([
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      join(homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ]);
    if (found) return found;
  }

  if (platform() === "linux") {
    const found = await firstExisting([
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    ]);
    if (found) return found;
  }

  throw new Error("Chrome executable not found. Set BROWSER_EXECUTABLE to your installed Chrome path.");
}

async function cdpIsReady(endpoint: string): Promise<boolean> {
  try {
    const response = await fetch(`${endpoint.replace(/\\/$/, "")}/json/version`, { signal: AbortSignal.timeout(1200) });
    return response.ok;
  } catch {
    return false;
  }
}

export async function ensureChromeWithCdp(options: ChromeLauncherOptions = {}): Promise<ChromeLaunchHandle> {
  const port = options.cdpPort ?? Number(process.env.BROWSER_CDP_PORT ?? DEFAULT_CDP_PORT);
  const endpoint = options.cdpUrl ?? process.env.BROWSER_CDP_URL ?? `http://127.0.0.1:${port}`;
  const profileDir = options.profileDir ?? process.env.BROWSER_CODING_AGENT_PROFILE ?? join(process.cwd(), ".browser-coding-agent", "chrome-profile");

  if (await cdpIsReady(endpoint)) {
    return { endpoint, profileDir, spawned: false };
  }

  const executablePath = await resolveChromeExecutable(options.executablePath);
  await mkdir(profileDir, { recursive: true });

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble",
    options.url ?? DEFAULT_URL,
  ];

  const child = spawn(executablePath, args, {
    detached: false,
    windowsHide: false,
    stdio: "ignore",
  });

  child.once("error", (error) => {
    console.error("[BrowserCodingAgent] Chrome process failed:", error);
  });
  child.once("exit", (code, signal) => {
    if (code !== 0 && code !== null) {
      console.error(`[BrowserCodingAgent] Chrome exited unexpectedly (code=${code}, signal=${signal ?? "none"})`);
    }
  });

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await cdpIsReady(endpoint)) {
      return { endpoint, profileDir, spawned: true, process: child };
    }
    if (child.exitCode !== null) {
      throw new Error(`Chrome exited before the DevTools endpoint became ready (code=${child.exitCode})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  try { child.kill(); } catch { /* best effort */ }
  throw new Error(`Timed out waiting for Chrome DevTools at ${endpoint}`);
}
