import { AGENT_NAMES, type AgentName, type RouterPlan } from "../types.js";
import { mentionedServer } from "../lib/mcp.js";
import { namedCodeProject } from "../lib/fileIndex.js";
import { WORKSPACE_ROOT } from "../lib/workspace.js";
import { AGENT_SPECS, BUILD_SOFTWARE, REVIEW_INTENT, STRONG_TEACHING, WEB_RESEARCH } from "../agents/registry.js";

/**
 * The Router's "small, fast decision model": a deterministic keyword/intent
 * classifier. It is intentionally lightweight (sub-millisecond, no network
 * call, no external dependency) so routing never becomes the bottleneck and
 * never performs specialist work itself -- it only scores and selects.
 */
const AGENT_KEYWORDS = Object.fromEntries(AGENT_NAMES.map((a) => [a, AGENT_SPECS[a].keywords])) as Record<AgentName, RegExp[]>;

export const TEACHING_ASK = /\b(explain|teach|quiz|flashcards?|lesson|tutor|help me (learn|understand))\b/i;

/** Number of keyword patterns per agent that match `text` (used by the Coordinator per clause). */
export function keywordScores(text: string): Record<AgentName, number> {
  return Object.fromEntries(AGENT_NAMES.map((a) => [a, AGENT_KEYWORDS[a].filter((re) => re.test(text)).length])) as Record<AgentName, number>;
}

/**
 * Shared post-processing applied to any candidate agent selection (whether
 * it came from the heuristic alone, or a heuristic+model merge):
 * auto-add PromptPilot for compound requests, and never return an empty plan.
 */
/** Saving a named skill, agent or routine ("create a skill called start_my_day that ..."). */
export const SKILL_CREATE = /\b(create|make|add|save|set up|setup|build)\b[^.?!]*\b(skill|agent|routine|command|shortcut)\b[^.?!]*\b(called|named)\b/i;
/** Fixing a problem in one of the user's projects ("help me fix the motor problem in my robotics project"). */
export const PROJECT_FIX = /\b(find|open|locate)\b[^.?!]*\bmy\s+(?:[\w-]+\s+){0,3}projects?\b[^.?!]*\b(fix|debug|problem|bug|not working|broken|doesn'?t work|won'?t|error|crash)\w*\b|\b(fix|debug)\b[^.?!]*\bmy\s+(?:[\w-]+\s+){0,3}projects?\b|\b(problem|bug|error|issue)s?\s+(in|with)\s+my\s+(?:[\w-]+\s+){0,3}projects?\b/i;
/** Integrations InfraPilot manages. */
export const NAMED_INTEGRATION = /\b(slack|github|notion|google drive|gdrive|google calendar|google docs?|google sheets?|gmail|e-?mails?|inbox|mcp)\b|\b(docs|sheets|slides|drive)\.google\.com\//i;
/** Mental-math trick requests. */
export const MATH_TRICK = /\b(math|maths|mental[- ]math|multiplication|arithmetic|number) (tricks?|shortcuts?|hacks?)\b|\bmental math\b/i;

const EDIT_VERBS = /\b(add|change|update|refactor|rename|implement|improve|extend|convert|rewrite|migrate|modify|upgrade|restructure)\b[^.?!]*\b(my|the|this|our)\s+(?:[\w-]+\s+){0,3}(project|app|codebase|code ?base|repo|program|game|site|website)\b/i;

/** The name of a workspace code project the request asks to change, if any. */
export function codeProjectNamed(requestText: string): string | null {
  if (!EDIT_VERBS.test(requestText)) return null;
  try {
    const p = namedCodeProject(process.env.OMNIPILOT_WORKSPACE ?? WORKSPACE_ROOT, requestText);
    return p ? p.name : null;
  } catch {
    return null;
  }
}

const ACCOUNT_LINK = /\b(docs|drive|sheets|slides)\.google\.com\/|\bgithub\.com\/[\w.-]+\/[\w.-]+|\bnotion\.(so|site)\//i;

export function finalizeSelection(
  requestText: string,
  selected: AgentName[],
  rationale: Record<AgentName, string>,
  scores: Record<AgentName, number>
): { selected: AgentName[]; rationale: Record<AgentName, string>; scores: Record<AgentName, number> } {
  let result = Array.from(new Set(selected));

  // Building software ("build a flashcard app", "make a snake game"): CodePilot writes it. Words like
  // "flashcard" or "game" describe the app, not a request for flashcards or a lesson.
  if (result.includes("CodePilot") && (BUILD_SOFTWARE.test(requestText) || codeProjectNamed(requestText)) && !/\b(explain|teach|lesson|tutor|help me (learn|understand))\b/i.test(requestText)) {
    for (const a of ["LearnPilot", "Helper", "MathPilot", "ScienceLab", "SchoolPilot", "PicturePilot"] as AgentName[]) {
      if (result.includes(a)) {
        result = result.filter((x) => x !== a);
        rationale[a] = "Not selected: the request is to build software, which CodePilot does.";
      }
    }
  }

  // "learn math, no AI" is the parent describing the focus task for WatcherPilot, not asking for a lesson.
  if (result.includes("WatcherPilot") && result.includes("LearnPilot") && !TEACHING_ASK.test(requestText)) {
    result = result.filter((a) => a !== "LearnPilot");
    rationale.LearnPilot = "Not selected: \"learn ...\" here describes the focus task WatcherPilot enforces, not a request to be taught.";
  }

  // Web research ("visit the official E2B site, Semgrep for code analysis...") is Helper's job with its web
  // tools: a passing mention of code or "explain" isn't a request to scan the user's code or give a lesson.
  // A link that needs the user's account (Google Docs/Sheets/Drive, GitHub, Notion) is read through
  // that integration, not by Helper's web tools (which would only see a sign-in page).
  if (ACCOUNT_LINK.test(requestText) && result.includes("InfraPilot") && result.includes("Helper")) {
    result = result.filter((a) => a !== "Helper");
    rationale.Helper = "Not selected: the link needs your account, so InfraPilot reads it through the integration.";
  }
  if (WEB_RESEARCH.test(requestText) && result.includes("Helper")) {
    const keep = (a: AgentName) =>
      a === "Helper" ||
      (a === "CodePilot" && REVIEW_INTENT.test(requestText) && /\b(my|our|this) (code|repo|project|file)/i.test(requestText)) ||
      (a === "LearnPilot" && STRONG_TEACHING.test(requestText)) ||
      (a === "InfraPilot" && /\b(connect|disconnect)\s+(slack|github|notion|google drive)|\bmcp server\b|\bschedule\b|\bworkflow\b/i.test(requestText));
    const droppable = ["CodePilot", "LearnPilot", "PromptPilot", "InfraPilot"];
    const reasons: Record<string, string> = { LearnPilot: "a lesson", CodePilot: "a request about your code", PromptPilot: "a prompt to rewrite", InfraPilot: "a request to connect an integration" };
    for (const a of result.filter((x) => !keep(x) && droppable.includes(x))) rationale[a] = `Not selected: this is web research for Helper's web tools, not ${reasons[a]}.`;
    result = result.filter((a) => keep(a) || !droppable.includes(a));
  }

  // "Create a skill called start_my_day that ... and ...": saving a skill/agent is InfraPilot's job alone;
  // the words describing what it should do aren't requests for the other specialists right now.
  if (SKILL_CREATE.test(requestText) && result.includes("InfraPilot")) {
    for (const a of result.filter((x) => x !== "InfraPilot")) rationale[a] = "Not selected: this request saves a skill or agent; its description isn't a task to run now.";
    result = ["InfraPilot"];
  }

  // "Create a workflow in Google Drive that backs up my notes": about a named integration, so it's
  // InfraPilot's alone; Helper would otherwise describe made-up steps for it.
  if (result.includes("InfraPilot") && result.includes("Helper") && NAMED_INTEGRATION.test(requestText) && !WEB_RESEARCH.test(requestText)) {
    result = result.filter((a) => a !== "Helper");
    rationale.Helper = "Not selected: this request is about an integration InfraPilot manages.";
  }

  // "Find my robotics project and help me fix the motor problem": Helper reads the project's own code
  // and diagnoses it; generic guides from other specialists would contradict that code.
  if (result.includes("Helper") && PROJECT_FIX.test(requestText) && /\bmy\b/i.test(requestText)) {
    for (const a of result.filter((x) => x !== "Helper")) rationale[a] = "Not selected: Helper diagnoses the problem from your project's own code.";
    result = ["Helper"];
  }

  // "Teach me a math trick" is MathPilot's trick library, not a LearnPilot lesson (unless a lesson or quiz is asked for).
  if (result.includes("MathPilot") && result.includes("LearnPilot") && MATH_TRICK.test(requestText) && !/\b(quiz|lesson|flashcards?|study plan|practice (problems|questions))\b/i.test(requestText)) {
    result = result.filter((a) => a !== "LearnPilot");
    rationale.LearnPilot = "Not selected: MathPilot teaches math tricks itself.";
  }

  const nonPromptSelected = result.filter((a) => a !== "PromptPilot");
  if (nonPromptSelected.length >= 3 && !result.includes("PromptPilot")) {
    result = [...result, "PromptPilot"];
    rationale.PromptPilot = `Added automatically: the request spans ${nonPromptSelected.length} specialists and benefits from decomposition into per-tool prompts.`;
    scores.PromptPilot = Math.max(scores.PromptPilot ?? 0, 1);
  }

  if (result.length === 0) {
    result = ["Helper"];
    rationale.Helper = "No specialist matched; defaulting to Helper as the safest read-only fallback.";
    scores.Helper = Math.max(scores.Helper ?? 0, 0.1);
  }

  return { selected: result, rationale, scores };
}

/**
 * The Router's keyword/intent classifier: deterministic, sub-millisecond, no
 * network call. Used standalone when the AI model isn't available, and as the
 * recall safety-net half of the hybrid router (see router/localModel.ts and
 * router/route.ts) so an obviously keyword-matching agent is never dropped
 * just because the AI model's judgement missed it.
 */
const HISTORIC_SCRIPT = /[\u1680-\u169F\u16A0-\u16FF\u{10000}-\u{100FF}\u{10300}-\u{1032F}\u{10380}-\u{103DF}\u{10900}-\u{1091F}\u{12000}-\u{123FF}\u{13000}-\u{1342F}]/gu;

export function decideAgents(requestText: string): RouterPlan {
  const scores: Record<AgentName, number> = {} as any;
  const rationale: Record<AgentName, string> = {} as any;

  for (const agent of AGENT_NAMES) {
    const matches = AGENT_KEYWORDS[agent].filter((re) => re.test(requestText));
    scores[agent] = matches.length;
    rationale[agent] = matches.length
      ? `Matched ${matches.length} keyword pattern(s) for ${agent}.`
      : `No keyword pattern for ${agent} matched this request.`;
  }

  // Text written in a historic script (not modern Greek, which people also just write in) goes to
  // ScriptScholar. Kept out of the shared keyword list: Python's re can't express these characters
  // the same way as JavaScript.
  if ((requestText.match(HISTORIC_SCRIPT) ?? []).length >= 4) {
    scores.ScriptScholar += 1;
    rationale.ScriptScholar = "The request contains text in a historic script (Phoenician, runes, Ogham, Linear B, hieroglyphs, cuneiform...).";
  }

  // Changing one of the user's own code projects ("add a score screen to my flashcard project"):
  // CodePilot, even when the project's name sounds like another agent's subject.
  const project = codeProjectNamed(requestText);
  if (project) {
    scores.CodePilot = Math.max(scores.CodePilot ?? 0, 2);
    rationale.CodePilot = `The request changes the user's code project "${project}".`;
  }

  // Naming one of the user's MCP servers ("ask my files server for...") is an InfraPilot job.
  const server = mentionedServer(requestText);
  if (server && !scores.InfraPilot) {
    scores.InfraPilot = 1;
    rationale.InfraPilot = `The request names the MCP server "${server}".`;
  }

  const candidate = AGENT_NAMES.filter((a) => scores[a] > 0);
  const { selected, rationale: finalRationale, scores: finalScores } = finalizeSelection(requestText, candidate, rationale, scores);

  return { selectedAgents: selected, rationale: finalRationale, scores: finalScores, routingMode: "heuristic-only" };
}
