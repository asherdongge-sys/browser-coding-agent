import type { Page } from "playwright";
import { ensureGitHubSelected } from "./github-app-selector.js";

// GitHub selection is a single-flight operation per ChatGPT page. This is
// deliberately kept outside the provider so agent creation, resume, and the
// runtime-level initialization cannot inject @GitHub more than once.
const inFlight = new WeakMap<Page, Promise<boolean>>();
const results = new WeakMap<Page, boolean>();

export function ensureGitHubSelectedV2(page: Page, appName = "GitHub"): Promise<boolean> {
  const cached = results.get(page);
  if (cached !== undefined) return Promise.resolve(cached);

  const running = inFlight.get(page);
  if (running) return running;

  const promise = ensureGitHubSelected(page, appName)
    .then((selected) => {
      results.set(page, selected);
      return selected;
    })
    .catch(() => {
      results.set(page, false);
      return false;
    })
    .finally(() => {
      inFlight.delete(page);
    });

  inFlight.set(page, promise);
  return promise;
}
