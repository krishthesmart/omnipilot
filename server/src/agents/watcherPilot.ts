import type { AgentFn } from "./base.js";
import { assertNotAborted, evidence, logAgentAction } from "./base.js";
import { DEFAULT_POLICY, classifyPage, getPolicy, hasPin, parseFocusRequest, type WatcherPolicy } from "../lib/watcher.js";

// WatcherPilot in chat: turns "learn math and no AI for 1 hour" into a focus
// session for the parent to confirm, answers "is YouTube blocked?", and reports
// status. It never applies or lifts rules itself -- a child could type the same
// message -- changes go through the Watcher panel behind the parent's PIN.

const URL_OR_SITE = /\b((?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?)/gi;
const SITE_NAMES: Record<string, string> = {
  youtube: "https://youtube.com",
  chatgpt: "https://chatgpt.com",
  gemini: "https://gemini.google.com",
  claude: "https://claude.ai",
  "khan academy": "https://khanacademy.org",
  roblox: "https://roblox.com",
  tiktok: "https://tiktok.com",
  desmos: "https://desmos.com",
  photomath: "https://photomath.com",
  wikipedia: "https://wikipedia.org",
};

const SETUP_INTENT = /\b(learn|study|practice|focus|homework time|no ai|block (all )?ai|only (allow|let)|screen time|stay on task|parental|goguardian)\b/i;
const LIFT_INTENT = /\b(turn off|disable|stop|unblock|remove|pause|end)\b.*\b(block|watcher|focus|filter|restriction)/i;
const CHECK_INTENT = /\b(is|are|can|will|would)\b.*\b(allowed|blocked|open|use|visit|go on)\b|\ballowed\b|\bblocked\b/i;

function describe(policy: Partial<WatcherPolicy>): string[] {
  const p = { ...DEFAULT_POLICY, ...policy };
  return [
    `**Task:** ${p.task || "(not set)"}${p.subject ? ` (subject: ${p.subject})` : ""}`,
    `**AI tools & answer solvers:** ${p.blockAI ? "blocked (ChatGPT, Gemini, Claude, Copilot, Photomath, Mathway, Brainly…)" : "allowed"}`,
    `**AI browser extensions:** ${p.blockAIExtensions ? "switched off during the session" : "left alone"}`,
    `**Other sites:** ${p.onTaskOnly ? `only pages that fit the task (${p.subject ?? "task"} sites, and pages whose content is about it)` : "allowed"}`,
    `**Ends:** ${p.until ? new Date(p.until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "when a parent turns it off"}`,
  ];
}

export const watcherPilotAgent: AgentFn = async (input, ctx) => {
  assertNotAborted(ctx);
  const text = input.requestText;
  const current = getPolicy();

  if (LIFT_INTENT.test(text)) {
    logAgentAction(input.runId, "WatcherPilot", "lift_request", {}, "pin_required");
    return {
      status: "success",
      findings: [
        "Only a parent can change or stop a focus session: use the button below and enter the parent PIN.",
        ...(current.active ? [`A session is running: "${current.task}".`] : ["No focus session is running right now."]),
      ],
      evidence: [],
      confidence: 0.9,
      limitations: ["Changes always require the parent PIN, so a child can't lift the rules from chat."],
      proposedActions: [],
      attachments: [{ type: "watcher-manage", task: current.active ? current.task ?? null : null }],
    };
  }

  // "Is YouTube allowed?" -- answer against the current (or just-described) rules.
  const sites = [
    ...Array.from(text.matchAll(URL_OR_SITE), (m) => (m[1].startsWith("http") ? m[1] : `https://${m[1]}`)),
    ...Object.entries(SITE_NAMES).filter(([name]) => new RegExp(`\\b${name}\\b`, "i").test(text)).map(([, url]) => url),
  ];
  if (CHECK_INTENT.test(text) && sites.length && !SETUP_INTENT.test(text)) {
    const checks = await Promise.all(sites.slice(0, 5).map(async (url) => ({ url, d: await classifyPage(current, url) })));
    assertNotAborted(ctx);
    logAgentAction(input.runId, "WatcherPilot", "check_sites", { sites: sites.length }, "completed");
    return {
      status: "success",
      findings: [
        current.active ? `Current session: "${current.task}".` : "No focus session is running, so nothing is blocked right now.",
        ...checks.map(({ url, d }) => `- **${new URL(url).hostname.replace(/^www\./, "")}**: ${d.decision === "block" ? "🚫 blocked" : "✅ allowed"} (${d.reason})`),
      ],
      evidence: checks.map(({ url, d }) => evidence(`watcher:${d.category}`, `${url} -> ${d.decision}`)),
      confidence: 0.85,
      limitations: ["Pages not on a known list are judged by their title when opened, so the result for a specific page can differ."],
      proposedActions: [],
    };
  }

  if (SETUP_INTENT.test(text)) {
    const proposed = { ...DEFAULT_POLICY, ...parseFocusRequest(text), active: true };
    const examples = ["https://chatgpt.com", "https://photomath.com", "https://youtube.com/watch?v=gaming", "https://roblox.com", "https://khanacademy.org/math"];
    const blockedExamples = (await Promise.all(examples.map(async (u) => ((await classifyPage(proposed, u, u.includes("gaming") ? "Minecraft let's play" : "")).decision === "block" ? new URL(u).hostname : null))))
      .filter((h): h is string => h !== null);
    assertNotAborted(ctx);
    logAgentAction(input.runId, "WatcherPilot", "propose_session", { task: proposed.task, subject: proposed.subject, until: proposed.until }, "awaiting_parent_pin");
    return {
      status: "success",
      findings: [
        "Here's the focus session I'll set up. **A parent needs to confirm it with their PIN** (button below).",
        ...describe(proposed),
        `For example, these would be blocked: ${blockedExamples.join(", ")}.`,
        hasPin() ? "" : "First time? You'll choose a 4–8 digit parent PIN when you confirm.",
        "Blocking happens in the browser through the **OmniPilot Watcher** extension (see the Watcher panel for the one-time install).",
      ].filter(Boolean),
      evidence: [evidence("watcher-policy", JSON.stringify({ task: proposed.task, subject: proposed.subject }))],
      confidence: 0.85,
      limitations: [
        "Blocking covers browsers with the OmniPilot Watcher extension installed. To stop it being removed or bypassed with a private window, a parent can lock it with Chrome's managed policies (see the Watcher panel).",
      ],
      proposedActions: [],
      attachments: [{ type: "watcher-setup", policy: proposed, blockedExamples }],
    };
  }

  logAgentAction(input.runId, "WatcherPilot", "status", { active: current.active }, "completed");
  return {
    status: "success",
    findings: current.active ? ["A focus session is running:", ...describe(current)] : ["No focus session is running. Tell me the task, e.g. \"learn math, no AI, for 1 hour\"."],
    evidence: [],
    confidence: 0.9,
    limitations: [],
    proposedActions: [],
  };
};
