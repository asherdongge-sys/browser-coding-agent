import type { Page } from "playwright";
import type { BrowserToolCall, BrowserToolResult } from "./browser-provider.js";

export type BrowserTaskEventSink = (kind: "call" | "result", call: BrowserToolCall, result?: BrowserToolResult) => void;

export class BrowserTaskExecutor {
  constructor(private readonly page: Page, private readonly onEvent: BrowserTaskEventSink) {}

  async run(goal: string): Promise<string> {
    const normalized = goal.trim();
    if (!normalized) throw new Error("Agent goal must not be empty");
    const plan = this.plan(normalized);
    if (!plan.length) throw new Error("暂时无法把这个目标转换成浏览器操作。当前版本支持：打开 URL、搜索关键词、点击页面元素、输入文字、按键、滚动、读取页面和提取元素文本。");
    const results: string[] = [];
    for (const call of plan) {
      this.onEvent("call", call);
      const result = await this.execute(call);
      this.onEvent("result", call, result);
      if (!result.ok) throw new Error(result.error ?? `Browser tool failed: ${call.tool}`);
      if (result.result !== undefined) results.push(this.stringifyResult(result.result));
    }
    return results.filter(Boolean).join("\n\n") || "浏览器任务已完成。";
  }

  private plan(goal: string): BrowserToolCall[] {
    const calls: BrowserToolCall[] = [];
    const url = goal.match(/https?:\/\/[^\s，。]+/i)?.[0];
    if (url) calls.push({ tool: "browser.navigate", arguments: { url } });

    const search = goal.match(/(?:搜索|搜一下|search(?: for)?|google|谷歌|百度)\s*[“\"]?([^”\"，。]+)[”\"]?/i);
    if (search) {
      const query = search[1]?.trim();
      if (query) {
        if (!url && /google|谷歌/i.test(goal)) calls.push({ tool: "browser.navigate", arguments: { url: "https://www.google.com/" } });
        else if (!url && /百度/i.test(goal)) calls.push({ tool: "browser.navigate", arguments: { url: "https://www.baidu.com/" } });
        calls.push({ tool: "browser.type", arguments: { text: query } });
        calls.push({ tool: "browser.press", arguments: { key: "Enter" } });
        calls.push({ tool: "browser.wait", arguments: { ms: 1200 } });
      }
    }

    const clickMatches = [...goal.matchAll(/(?:点击|单击|click)\s*[“\"]?([^”\"，。]+)[”\"]?/gi)];
    for (const match of clickMatches) {
      const text = match[1]?.trim();
      if (text) calls.push({ tool: "browser.click", arguments: { text } });
    }

    const typeMatch = goal.match(/(?:输入|填写|type|enter)\s*[“\"]([^”\"]+)[”\"]/i);
    if (typeMatch?.[1]) calls.push({ tool: "browser.type", arguments: { text: typeMatch[1] } });

    const scrollMatch = goal.match(/(?:滚动|scroll)(?:到|向)?\s*(上|下|top|bottom)?/i);
    if (scrollMatch) {
      const directionToken = scrollMatch[1] ?? "down";
      calls.push({ tool: "browser.scroll", arguments: { direction: /上|top/i.test(directionToken) ? "up" : /bottom/i.test(directionToken) ? "bottom" : "down" } });
    }

    if (/(?:读取|查看|阅读|read|inspect).*(?:页面|网页|page)/i.test(goal) || /页面内容|网页内容/i.test(goal)) calls.push({ tool: "browser.read_page", arguments: {} });

    const extractMatch = goal.match(/(?:提取|extract)\s*[“\"]?([^”\"，。]+)[”\"]?/i);
    if (extractMatch?.[1]) calls.push({ tool: "browser.extract", arguments: { selector: extractMatch[1].trim() } });

    if (!calls.length && /^打开\s+/i.test(goal)) {
      const target = goal.replace(/^打开\s+/i, "").trim();
      if (/^https?:\/\//i.test(target)) calls.push({ tool: "browser.navigate", arguments: { url: target } });
    }
    return calls;
  }

  private async execute(call: BrowserToolCall): Promise<BrowserToolResult> {
    try {
      switch (call.tool) {
        case "browser.navigate": {
          const url = String(call.arguments.url ?? "").trim();
          if (!/^https?:\/\//i.test(url)) return { ok: false, error: "browser.navigate requires an http(s) URL" };
          await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
          return { ok: true, result: { url: this.page.url() } };
        }
        case "browser.click": {
          const text = String(call.arguments.text ?? "").trim();
          if (!text) return { ok: false, error: "browser.click requires text" };
          const candidates = [
            this.page.getByRole("button", { name: text, exact: false }).last(),
            this.page.getByRole("link", { name: text, exact: false }).last(),
            this.page.getByText(text, { exact: false }).last(),
          ];
          for (const candidate of candidates) {
            if (await candidate.count() && await candidate.isVisible().catch(() => false)) {
              await candidate.click({ timeout: 10000 });
              return { ok: true, result: { clicked: text } };
            }
          }
          return { ok: false, error: `Could not find a visible element matching: ${text}` };
        }
        case "browser.type": {
          const text = String(call.arguments.text ?? "");
          const selector = typeof call.arguments.selector === "string" ? call.arguments.selector : undefined;
          const target = selector
            ? this.page.locator(selector).last()
            : this.page.locator("input:visible, textarea:visible, [contenteditable='true']:visible, [role='textbox']:visible").last();
          await target.waitFor({ state: "visible", timeout: 10000 });
          await target.fill(text, { timeout: 10000 });
          return { ok: true, result: { typed: text } };
        }
        case "browser.press": {
          const key = String(call.arguments.key ?? "Enter");
          const target = this.page.locator("input:visible, textarea:visible, [contenteditable='true']:visible, [role='textbox']:visible").last();
          await target.waitFor({ state: "visible", timeout: 10000 });
          await target.press(key, { timeout: 10000 });
          return { ok: true, result: { key } };
        }
        case "browser.scroll": {
          const direction = String(call.arguments.direction ?? "down");
          await this.page.evaluate((value) => {
            if (value === "top") window.scrollTo({ top: 0, behavior: "smooth" });
            else if (value === "bottom") window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
            else window.scrollBy({ top: value === "up" ? -window.innerHeight * 0.8 : window.innerHeight * 0.8, behavior: "smooth" });
          }, direction);
          return { ok: true, result: { direction } };
        }
        case "browser.read_page": {
          const text = await this.page.locator("body").innerText({ timeout: 10000 });
          return { ok: true, result: text.slice(0, 12000) };
        }
        case "browser.extract": {
          const selector = String(call.arguments.selector ?? "").trim();
          if (!selector) return { ok: false, error: "browser.extract requires a CSS selector" };
          const text = await this.page.locator(selector).allInnerTexts();
          return { ok: true, result: text.slice(0, 100).join("\n") };
        }
        case "browser.wait": {
          const ms = Math.max(0, Math.min(Number(call.arguments.ms ?? 500), 10000));
          await this.page.waitForTimeout(ms);
          return { ok: true, result: { waitedMs: ms } };
        }
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private stringifyResult(value: unknown): string {
    if (typeof value === "string") return value;
    try { return JSON.stringify(value); } catch { return String(value); }
  }
}
