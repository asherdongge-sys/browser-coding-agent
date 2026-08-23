import { PlaywrightBrowserProvider } from "./playwright-browser-provider.js";
import { ensureGitHubSelectedV2, submitMessageAfterGitHubSelection } from "./github-app-selector-v2.js";
import type { Page } from "playwright";

type Agent = { page: Page };
type Provider = { sendMessage(id: string, text: string): Promise<void>; agents?: Map<string, Agent> };

const provider = PlaywrightBrowserProvider.prototype as unknown as Provider & { __githubSendPatched?: boolean };
if (!provider.__githubSendPatched) {
  provider.__githubSendPatched = true;
  const nativeSendMessage = provider.sendMessage;
  provider.sendMessage = async function sendMessage(id, text) {
    if (!/\bgithub\b|\brepositories?\b|\brepos?\b|\bpull requests?\b|\bissues?\b|\bcommits?\b|\bbranches?\b|仓库|代码仓库|GitHub|拉取请求|分支|提交记录/i.test(text)) {
      return nativeSendMessage.call(this, id, text);
    }
    const agent = this.agents?.get(id);
    if (!agent) throw new Error(`Agent ${id} not found`);
    if (!await ensureGitHubSelectedV2(agent.page, "GitHub")) throw new Error("GitHub App initialization failed");
    await submitMessageAfterGitHubSelection(agent.page, text);
  };
}
