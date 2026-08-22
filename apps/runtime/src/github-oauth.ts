import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Public OAuth client ID. PKCE means no client secret is required for this local/native client.
export const GITHUB_OAUTH_CLIENT_ID = "Ov23liq1GT66HkGW5Qn9";

export type GitHubConnection = { accessToken: string; login?: string; name?: string; connectedAt: number };
type OAuthState = { value: string; verifier: string; createdAt: number };
const storeDir = join(process.cwd(), ".browser-coding-agent");
const storeFile = join(storeDir, "github-oauth.json");
let state: OAuthState | undefined;

export async function getGitHubConnection(): Promise<GitHubConnection | undefined> {
  try { const raw = await readFile(storeFile, "utf8"); return raw.trim() ? JSON.parse(raw) as GitHubConnection : undefined; } catch { return undefined; }
}
export async function saveGitHubConnection(connection: GitHubConnection): Promise<void> {
  await mkdir(storeDir, { recursive: true });
  await writeFile(storeFile, JSON.stringify(connection, null, 2), { encoding: "utf8", mode: 0o600 });
  try { await chmod(storeFile, 0o600); } catch {}
}
export async function disconnectGitHub(): Promise<void> { try { await writeFile(storeFile, "", "utf8"); } catch {} }
export function githubOAuthConfigured(): boolean { return GITHUB_OAUTH_CLIENT_ID !== "REPLACE_WITH_GITHUB_OAUTH_CLIENT_ID"; }
function b64(buffer: Buffer): string { return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""); }
function verifier(): string { return b64(randomBytes(32)); }
function challenge(value: string): string { return b64(createHash("sha256").update(value).digest()); }

export function createGitHubAuthorizeUrl(callbackUrl: string): string {
  if (!githubOAuthConfigured()) throw new Error("GitHub OAuth is not configured. Set GITHUB_OAUTH_CLIENT_ID in apps/runtime/src/github-oauth.ts.");
  const value = b64(randomBytes(32)); const secret = verifier(); state = { value, verifier: secret, createdAt: Date.now() };
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", GITHUB_OAUTH_CLIENT_ID); url.searchParams.set("redirect_uri", callbackUrl);
  url.searchParams.set("scope", "read:user repo"); url.searchParams.set("state", value);
  url.searchParams.set("code_challenge", challenge(secret)); url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function completeGitHubOAuth(code: string, returnedState: string, callbackUrl: string): Promise<GitHubConnection> {
  const current = state;
  if (!current || current.value !== returnedState || Date.now() - current.createdAt > 10 * 60_000) throw new Error("Invalid or expired GitHub OAuth state");
  state = undefined;
  const response = await fetch("https://github.com/login/oauth/access_token", { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ client_id: GITHUB_OAUTH_CLIENT_ID, code, redirect_uri: callbackUrl, code_verifier: current.verifier }) });
  const body = await response.json() as any;
  if (!response.ok || body.error) throw new Error(body.error_description ?? body.error ?? `GitHub OAuth failed: ${response.status}`);
  const accessToken = String(body.access_token ?? ""); if (!accessToken) throw new Error("GitHub OAuth did not return an access token");
  const profileResponse = await fetch("https://api.github.com/user", { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${accessToken}`, "X-GitHub-Api-Version": "2022-11-28" } });
  const profile = await profileResponse.json() as any; if (!profileResponse.ok) throw new Error(profile?.message ?? "Unable to read GitHub profile");
  const connection: GitHubConnection = { accessToken, login: typeof profile.login === "string" ? profile.login : undefined, name: typeof profile.name === "string" ? profile.name : undefined, connectedAt: Date.now() };
  await saveGitHubConnection(connection); return connection;
}
export function githubOAuthCallbackUrl(port: number): string { return `http://127.0.0.1:${port}/api/github/callback`; }
export function githubOAuthStatus(port: number, connection?: GitHubConnection) { return { configured: githubOAuthConfigured(), connected: Boolean(connection), login: connection?.login, name: connection?.name, connectUrl: `/api/github/connect?port=${port}` }; }