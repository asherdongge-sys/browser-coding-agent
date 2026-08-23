import type { Page } from "playwright";
import { ensureGitHubSelectedV2 } from "./github-app-selector-v2.js";

/**
 * Stable selector entry point used by the runtime compatibility layer.
 * Keep the legacy import path while routing all GitHub App selection through
 * the isolated V2 implementation.
 */
export function ensureGitHubSelected(page: Page, name = "GitHub"): Promise<boolean> {
  return ensureGitHubSelectedV2(page, name);
}
