import type { AgentFn } from "./base.js";
import { assertNotAborted, evidence, logAgentAction, proposedAction } from "./base.js";
import { listConnectors } from "../db.js";
import { infraSkills } from "./infraSkills.js";
import { mailSkill } from "./mail.js";
import { driveSkill } from "./drive.js";
import { linkSkill } from "./links.js";
import { mcpSkill } from "./mcpSkill.js";
import { saveAction, type ActionKind } from "../lib/actions.js";
import { githubFromText, notionPageId, slackFromText } from "../lib/integrationActions.js";
import { agentLlmEnabled, generateJson } from "../lib/llm.js";
import type { AgentInput, ProposedAction } from "../types.js";

const KNOWN_CONNECTOR_PATTERNS = [
  { name: "Slack", pattern: /\bslack\b/i },
  { name: "GitHub", pattern: /\bgithub\b/i },
  { name: "Notion", pattern: /\bnotion\b/i },
  { name: "Google Drive", pattern: /\b(google drive|gdrive)\b/i },
  { name: "Google Calendar", pattern: /\b(google calendar|gcal)\b/i },
];

const WRITE_INTENT = /\b(create|set up|setup|schedule|automate|enable|connect|install|deploy|post|send|message|tell|open|file|add|append|write)\b/i;
const CONNECT_ONLY = /^\W*(please\s+)?(connect|set ?up|link|add)\s+(my\s+)?(slack|github|notion|google drive|gdrive)\W*$/i;

/** What each service can do when approved, and how to read the details from the request. */
const WRITES: Record<string, { kind: ActionKind; intent: RegExp; schema: object; system: string }> = {
  Slack: {
    kind: "slack_message",
    intent: /\b(post|send|message|tell|announce|share|write)\b/i,
    schema: { type: "object", properties: { channel: { type: "string" }, text: { type: "string" } }, required: ["channel", "text"] },
    system: "Extract the Slack message the user wants to post. `channel` is the channel name with # (e.g. #general) or a person's @handle. `text` is the exact message, written out if they described it.",
  },
  GitHub: {
    kind: "github_issue",
    intent: /\b(issue|bug report|ticket)\b/i,
    schema: { type: "object", properties: { repo: { type: "string" }, title: { type: "string" }, body: { type: "string" } }, required: ["repo", "title", "body"] },
    system: "Extract the GitHub issue the user wants to open. `repo` is owner/name. Write a clear title and a helpful body (steps, expected vs actual) from what they said.",
  },
  Notion: {
    kind: "notion_append",
    intent: /\b(add|append|write|note|save|put)\b/i,
    schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    system: "Extract the text the user wants added to their Notion page, written out in full (keep their wording; separate paragraphs with blank lines).",
  },
};

/** A concrete, approvable action for a connected service, or a question about what's missing. */
async function writeAction(service: string, input: AgentInput, signal: AbortSignal): Promise<{ action?: ProposedAction; missing?: string }> {
  const w = WRITES[service];
  const text = input.requestText;
  const ai = agentLlmEnabled() ? await generateJson<Record<string, string>>(w.system, text, { signal, schema: w.schema as Record<string, unknown>, temperature: 0.2, maxTokens: 800, effort: "low" }) : null;
  if (service === "Slack") {
    const rx = slackFromText(text);
    const channel = rx.channel ?? ai?.channel;
    const message = ai?.text || rx.text;
    if (!channel || !/^[#@]?[\w.-]+$/.test(channel)) return { missing: "Which Slack channel should it go to? (for example #general)" };
    if (!message) return { missing: "What should the message say? Put it in quotes." };
    const params = { channel: channel.startsWith("#") || channel.startsWith("@") ? channel : `#${channel}`, text: message };
    return { action: stash(w.kind, params, `Post to ${params.channel} in Slack`, "medium", `Channel: ${params.channel}\n\n${message}`) };
  }
  if (service === "GitHub") {
    const rx = githubFromText(text);
    const repo = rx.repo ?? ai?.repo;
    const title = ai?.title || rx.title;
    if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return { missing: "Which repository? Give it as owner/name (for example octocat/hello-world)." };
    if (!title) return { missing: "What should the issue be titled?" };
    const params = { repo, title, body: ai?.body || rx.body || "" };
    return { action: stash(w.kind, params, `Open a GitHub issue in ${repo}: "${title}"`, "medium", `Repository: ${repo}\nTitle: ${title}\n\n${params.body}`) };
  }
  const pageId = notionPageId(text);
  const content = ai?.text || /["“]([^"”]+)["”]/.exec(text)?.[1];
  if (!pageId) return { missing: "Which Notion page? Paste its link (and share the page with your OmniPilot integration in Notion)." };
  if (!content) return { missing: "What should I add to the page? Put it in quotes." };
  return { action: stash(w.kind, { pageId, text: content }, "Add text to your Notion page", "medium", content) };
}

function stash(kind: ActionKind, params: Record<string, unknown>, description: string, risk: "medium" | "high", preview: string): ProposedAction {
  const action = { ...proposedAction(description, risk), preview };
  saveAction(action.id, kind, params);
  return action;
}

export const infraPilotAgent: AgentFn = async (input, ctx) => {
  assertNotAborted(ctx);
  // Skills, custom agents, routines and the calendar.
  const handled = await infraSkills(input);
  if (handled) return handled;
  // Gmail (read-only + approved drafts) and MCP servers.
  const mail = await mailSkill(input, ctx.signal);
  if (mail) return mail;
  const drive = await driveSkill(input, ctx.signal);
  if (drive) return drive;
  const link = await linkSkill(input, ctx.signal);
  if (link) return link;
  const mcp = await mcpSkill(input, ctx.signal);
  if (mcp) return mcp;
  const connectors = listConnectors();
  logAgentAction(input.runId, "InfraPilot", "list_connectors", {}, `found ${connectors.length}`);

  const mentionedKnown = KNOWN_CONNECTOR_PATTERNS.filter((c) => c.pattern.test(input.requestText));
  const wantsWrite = WRITE_INTENT.test(input.requestText);
  const mentionsWorkflow = /\bworkflow|schedule|skill|custom agent\b/i.test(input.requestText);

  if (mentionedKnown.length > 0) {
    const findings: string[] = [];
    const ev = [];
    const actions = [];
    let anyMissing = false;

    for (const m of mentionedKnown) {
      const record = connectors.find((c: any) => c.name === m.name);
      const connected = record?.status === "connected";
      if (!connected) anyMissing = true;
      findings.push(
        connected
          ? `${m.name} is connected${record?.account_label ? ` as ${record.account_label}` : ""} and approved for use.`
          : `${m.name} is not connected yet. Use the **Connect** button on its card above${record?.verification === "token" ? " and paste an access token for your account" : ""}; nothing can use ${m.name} until you do.`
      );
      ev.push(
        evidence(
          `connector:${m.name}`,
          JSON.stringify({
            name: m.name,
            status: connected ? "connected" : "not_connected",
            kind: record?.kind,
            verification: record?.verification,
            accountLabel: record?.account_label,
          })
        )
      );
      if (connected && wantsWrite && WRITES[m.name] && WRITES[m.name].intent.test(input.requestText) && !CONNECT_ONLY.test(input.requestText)) {
        // A real action, shown with exactly what will be sent; it runs only when approved.
        const { action, missing } = await writeAction(m.name, input, ctx.signal);
        if (action) {
          actions.push(action);
          findings.push(`Ready: approve it below and it's done (it uses your connected ${m.name} account).`);
        } else if (missing) findings.push(missing);
      } else if (connected && wantsWrite && !CONNECT_ONLY.test(input.requestText)) {
        findings.push(
          `What should I do in ${m.name}? I can ${m.name === "Slack" ? "post a message to a channel" : m.name === "GitHub" ? "open an issue in a repository" : m.name === "Notion" ? "add text to a page" : "read it"}.`
        );
      }
    }

    logAgentAction(input.runId, "InfraPilot", "check_connector_status", { requested: mentionedKnown.map((m) => m.name) }, anyMissing ? "needs_connection" : "ok");

    return {
      status: anyMissing ? "needs_connection" : actions.length ? "needs_approval" : "success",
      findings,
      evidence: ev,
      confidence: 0.9,
      limitations: anyMissing
        ? ["Nothing can use a service until you connect it yourself with the Connect button on its card."]
        : actions.length
          ? ["Nothing is sent until you approve it."]
          : [],
      proposedActions: actions,
    };
  }

  if (mentionsWorkflow) {
    logAgentAction(input.runId, "InfraPilot", "list_connectors", { connected: connectors.filter((c: any) => c.status === "connected").length }, "summary");
    return {
      status: "success",
      findings: [
        `${connectors.filter((c: any) => c.status === "connected").length} of ${connectors.length} known integrations are currently connected.`,
        "No specific integration was named in the request, so no connector-specific action was taken.",
        "Custom AI agents, skills, and schedules can only be created against a connected integration or purely-internal (no external call) workflow.",
      ],
      evidence: connectors.map((c: any) => evidence(`connector:${c.name}`, JSON.stringify(c))),
      confidence: 0.6,
      limitations: ["This is a status summary, not a created workflow — ask for a specific integration to proceed."],
      proposedActions: [],
    };
  }

  return {
    status: "success",
    findings: ["No integration, MCP server, schedule, or workflow action was identified as needed for this request."],
    evidence: [],
    confidence: 0.5,
    limitations: ["InfraPilot only acts when the request references an integration, workflow, schedule, custom agent, or MCP server."],
    proposedActions: [],
  };
};
