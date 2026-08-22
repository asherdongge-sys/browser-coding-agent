import { createServer } from "node:http";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export type GitHubConnection = {
  accessToken: string;
  login?: string;
  name?: string;
  connectedAt: number;
};

type OAuthState = { value: string; createdAt: number };

const storeDir = join(process.cwd(), ".browser-coding-agent");
const storeFile = join(storeDir, "github-oauth.json");
let state: OAuthState | undefined;

export async function getGitHubConnection(): Promise<GitHubConnection | undefined> {
  try {
    const raw = await readFile(storeFile, "utf8");
    return JSON.parse(raw) as GitHubConnection;
  } catch {
    return undefined;
  }
}

export async function saveGitHubConnection(connection: GitHubConnection): Promise<void> {
  await mkdir(storeDir, { recursive: true });
  await writeFile(storeFile, JSON.stringify(connection, null, 2), { encoding: "utf8", mode: 0o600 });
  try { await chmod(storeFile, 0o600); } catch { /* Windows does not use POSIX permissions. */ }
}

export async function disconnectGitHub(): Promise<void> {
  try { await writeFile(storeFile, "", "utf8"); } catch { /* already disconnected */ }
}

export function githubOAuthConfigured(): boolean {
  return Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
}

export function createGitHubAuthorizeUrl(callbackUrl: string): string {
  if (!githubOAuthConfigured()) throw new Error("GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are required for GitHub OAuth");
  const value = randomBytes(24).toString("hex");
  state = { value, createdAt: Date.now() };
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", process.env.GITHUB_CLIENT_ID!);
  url.searchParams.set("redirect_uri", callbackUrl);
  url.searchParams.set("scope", "read:user repo");
  url.searchParams.set("state", value);
  return url.toString();
}

async function githubOAuthFetch(path: string, init?: RequestInit): Promise<any> {
  const response = await fetch(`https://github.com/login/oauth/${path}`, {
    ...init,
    headers: { Accept: "application/json", ...(init?.headers ?? {}) },
  });
  const body = await response.json() as any;
  if (!response.ok || body.error) throw new Error(body.error_description ?? body.error ?? `GitHub OAuth failed: ${response.status}`);
  return body;
}

export async function completeGitHubOAuth(code: string, returnedState: string): Promise<GitHubConnection> {
  if (!state || state.value !== returnedState || Date.now() - state.createdAt > 10 * 60_000) throw new Error("Invalid or expired GitHub OAuth state");
  state = undefined;
  const tokenResponse = await githubOAuthFetch("access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: process.env.GITHUB_CLIENT_ID, client_secret: process.env.GITHUB_CLIENT_SECRET, code, state: returnedState }),
  });
  const accessToken = String(tokenResponse.access_token ?? "");
  if (!accessToken) throw new Error("GitHub OAuth did not return an access token");
  const profileResponse = await fetch("https://api.github.com/user", { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${accessToken}`, "X-GitHub-Api-Version": "2022-11-28" } });
  const profile = await profileResponse.json() as any;
  if (!profileResponse.ok) throw new Error(profile?.message ?? "Unable to read GitHub profile");
  const connection: GitHubConnection = { accessToken, login: typeof profile.login === "string" ? profile.login : undefined, name: typeof profile.name === "string" ? profile.name : undefined, connectedAt: Date.now() };
  await saveGitHubConnection(connection);
  return connection;
}

export function githubOAuthCallbackUrl(port: number): string {
  return process.env.GITHUB_OAUTH_CALLBACK_URL ?? `http://127.0.0.1:${port}/api/github/callback`;
}

export function githubOAuthStatus(port: number, connection?: GitHubConnection) {
  return { configured: githubOAuthConfigured(), connected: Boolean(connection), login: connection?.login, name: connection?.name, connectUrl: githubOAuthConfigured() ? `/api/github/connect?port=${port}` : undefined };
}

export function startGitHubOAuthCallbackServer(port: number): Promise<ReturnType<typeof createServer>> {
  return Promise.reject(new Error("Use the runtime HTTP server for GitHub OAuth routes"));
}
