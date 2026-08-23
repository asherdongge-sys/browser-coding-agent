import "./playwright-composer-fix.js";
import { PlaywrightBrowserProvider } from "./playwright-browser-provider.js";
import { ensureGitHubSelectedV2, submitMessageAfterGitHubSelection } from "./github-app-selector-v2.js";
import type { Page } from "playwright";
type A={page:Page};type P={sendMessage(id:string,text:string):Promise<void>;agents?:Map<string,A>;__githubPatch?:boolean};
const p=PlaywrightBrowserProvider.prototype as unknown as P;const github=(s:string)=>/github|repositories|repos|pull requests|issues|commits|branches|仓库|代码仓库|拉取请求|分支|提交记录/i.test(s);
if(!p.__githubPatch){p.__githubPatch=true;const native=p.sendMessage;p.sendMessage=async function(id,text){if(!github(text))return native.call(this,id,text);const a=this.agents?.get(id);if(!a)throw new Error(`Agent ${id} not found`);if(!await ensureGitHubSelectedV2(a.page))throw new Error("GitHub App initialization failed");await submitMessageAfterGitHubSelection(a.page,text);};}
