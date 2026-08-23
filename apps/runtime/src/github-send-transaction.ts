import { PlaywrightBrowserProvider } from "./playwright-browser-provider.js";
import type { Page } from "playwright";

type A={page:Page};type P={createAgent(title:string,prompt:string):Promise<unknown>;sendMessage(id:string,text:string):Promise<void>;agents?:Map<string,A>;__githubPatch?:boolean};
const p=PlaywrightBrowserProvider.prototype as unknown as P;
const nativeCreate=p.createAgent;
await import("./playwright-composer-fix.js");
const nativeSend=p.sendMessage;
const github=(s:string)=>/github|repositories|repos|pull requests|issues|commits|branches|仓库|代码仓库|拉取请求|分支|提交记录/i.test(s);
// Bypass only the composer-fix createAgent wrapper. The native provider starts
// initialization in the background; the dashboard must not wait for GitHub.
p.createAgent=async function(title,prompt){return nativeCreate.call(this,title,prompt);};
if(!p.__githubPatch){p.__githubPatch=true;p.sendMessage=async function(id,text){if(!github(text))return nativeSend.call(this,id,text);const a=this.agents?.get(id);if(!a)throw new Error(`Agent ${id} not found`);const {ensureGitHubSelectedV2,submitMessageAfterGitHubSelection}=await import("./github-app-selector-v2.js");if(!await ensureGitHubSelectedV2(a.page))throw new Error("GitHub App initialization failed");await submitMessageAfterGitHubSelection(a.page,text);};}
