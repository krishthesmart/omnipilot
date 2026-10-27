import { getConnectorInternal } from "../db.js";
import { registerExecutor, type ActionOutcome } from "./actions.js";

// What approving an integration action does. Each one uses the token the user connected (never
// shown to the model or the app), makes one API call, and reports what the provider answered.

const providerTimeoutMs = () => Number(process.env.OMNIPILOT_PROVIDER_TIMEOUT_MS ?? 10_000) || 10_000;

function tokenFor(name: string): string {
  const c = getConnectorInternal(name);
  if (c?.status !== "connected" || !c.secret_token) throw new Error(`${name} isn't connected any more. Connect it again, then approve.`);
  return c.secret_token;
}

async function call(url: string, init: RequestInit): Promise<{ status: number; data: any }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(providerTimeoutMs()) });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

export interface SlackMessage {
  channel: string;
  text: string;
}
export interface GithubIssue {
  repo: string;
  title: string;
  body: string;
}
export interface NotionAppend {
  pageId: string;
  text: string;
}

export async function postSlackMessage(p: SlackMessage): Promise<ActionOutcome> {
  const { data } = await call("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: `Bearer ${tokenFor("Slack")}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel: p.channel, text: p.text }),
  });
  if (!data.ok) {
    const hint = data.error === "not_in_channel" ? " Invite the OmniPilot app to that channel first (/invite in Slack)." : data.error === "channel_not_found" ? " Check the channel name." : "";
    return { ok: false, message: `Slack said: ${data.error ?? "unknown error"}.${hint}` };
  }
  return { ok: true, message: `Posted to ${p.channel} in Slack.` };
}

export async function createGithubIssue(p: GithubIssue): Promise<ActionOutcome> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(p.repo)) return { ok: false, message: `"${p.repo}" isn't a repository name (it should look like owner/repo).` };
  const { status, data } = await call(`https://api.github.com/repos/${p.repo}/issues`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tokenFor("GitHub")}`, "User-Agent": "OmniPilot", Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    body: JSON.stringify({ title: p.title, body: p.body }),
  });
  if (status !== 201) return { ok: false, message: `GitHub said: ${data.message ?? `HTTP ${status}`}${status === 404 ? " (check the repository name, and that your token can open issues there)" : ""}.` };
  return { ok: true, message: `Opened issue #${data.number} in ${p.repo}.`, url: data.html_url };
}

export async function appendToNotion(p: NotionAppend): Promise<ActionOutcome> {
  const paragraphs = p.text.split(/\n{2,}/).filter(Boolean).slice(0, 50);
  const { status, data } = await call(`https://api.notion.com/v1/blocks/${p.pageId}/children`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${tokenFor("Notion")}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" },
    body: JSON.stringify({
      children: paragraphs.map((t) => ({ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: t.slice(0, 2000) } }] } })),
    }),
  });
  if (status !== 200) return { ok: false, message: `Notion said: ${data.message ?? `HTTP ${status}`}${status === 404 ? " (share the page with your OmniPilot integration first)" : ""}.` };
  return { ok: true, message: `Added ${paragraphs.length} paragraph${paragraphs.length === 1 ? "" : "s"} to the Notion page.`, url: `https://www.notion.so/${p.pageId.replace(/-/g, "")}` };
}

registerExecutor("slack_message", postSlackMessage);
registerExecutor("github_issue", createGithubIssue);
registerExecutor("notion_append", appendToNotion);

// --- Reading what the user asked for (used when the AI model isn't available, and to check it) ---

const quoted = (text: string) => /["“'‘]([^"”'’]{1,2000})["”'’]/.exec(text)?.[1]?.trim();

/** "post 'standup at 10' to #general on slack" */
export function slackFromText(text: string): Partial<SlackMessage> {
  const channel = /(#[\w-]{1,80})/.exec(text)?.[1];
  const message = quoted(text) ?? /\b(?:saying|that says|message)\s*:?\s+(.+?)(?:\s+(?:to|in|on)\s+(?:#|slack)|$)/i.exec(text)?.[1]?.trim();
  return { channel, text: message };
}

/** "open a github issue in acme/site titled 'Login broken' saying the button does nothing" */
export function githubFromText(text: string): Partial<GithubIssue> {
  const repo = /\b([\w.-]+\/[\w.-]+)\b/.exec(text.replace(/https?:\/\/github\.com\//g, ""))?.[1];
  const title = /\b(?:titled|called|named|title)\s*:?\s*["“']([^"”']+)["”']/i.exec(text)?.[1] ?? quoted(text);
  const body = /\b(?:saying|body|that says|description)\s*:?\s+(.+)$/i.exec(text)?.[1]?.trim();
  return { repo, title, body: body ?? "" };
}

/** A Notion page id from a page link or a bare id. */
export function notionPageId(text: string): string | undefined {
  const hex = /([0-9a-f]{32})(?:[?#\s]|$)/i.exec(text.replace(/-/g, ""))?.[1];
  return hex ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` : undefined;
}
