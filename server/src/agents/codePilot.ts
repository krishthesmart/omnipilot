import fs from "node:fs";
import path from "node:path";
import type { AgentFn } from "./base.js";
import { buildProject, editProject, isProjectRequest, projectToEdit } from "./projectBuilder.js";
import { runCommandSkill } from "./runCommand.js";
import { assertNotAborted, evidence, logAgentAction, previousTurnText, priorResults, proposedAction } from "./base.js";
import { REVIEW_INTENT } from "./registry.js";
import { agentModel, generateText, generateJson, modelLimitation } from "../lib/llm.js";
import { aiUnavailableReason } from "../lib/groq.js";
import { refusalReason, runSandboxed, runTests, sandboxEnabled, sandboxLanguage, type SandboxLanguage } from "../lib/sandbox.js";
import { MAX_PATCH_FILE_BYTES, safeWorkspacePath, savePatch, unifiedDiff } from "../lib/patches.js";

const GENERATE_INTENT = new RegExp(
  [
    // "write a function", "make a webpage", "build me a calculator app"
    String.raw`\b(write|create|generate|implement|build|make|code|program|develop|design)\b[^.?!]*\b(function|code|script|class|program|algorithm|snippet|regex|query|component|endpoint|app|application|web ?page|web ?site|site|page|html|css|calculator|game|tool|bot|api|server|cli|form|ui|landing page|dashboard|extension)s?\b`,
    // "code a calculator", "code it", "can you code ..."
    String.raw`(^|[.!?,]\s*|\b(you|please|can you|could you|now)\s+)code\s+(a|an|me|it|this|that|the|up)\b`,
  ].join("|"),
  "i"
);

/** A web page or front-end request: the answer is one complete HTML file, which can be previewed. */
export const WEB_PAGE = /\b(html|web ?page|web ?site|landing page|front[- ]?end|css|page with|browser game)\b/i;

const GENERATE_SYSTEM =
  "You are CodePilot, a careful senior engineer. Write correct, secure, idiomatic code for the user's request. " +
  "Use the language they asked for (default to Python if unstated). Handle edge cases, never hardcode secrets, never build SQL or shell commands by string concatenation. " +
  "For a web page or anything that runs in a browser, write ONE complete, self-contained HTML file (inline <style> and <script>, no external files or libraries) that works when opened directly. " +
  "Reply with one fenced code block followed by at most 3 short sentences of explanation.";

const FENCE = "```";

const GENERATE_EXAMPLE = {
  user: "Write a python function that checks if a string is a palindrome",
  assistant: [
    `${FENCE}python`,
    "def is_palindrome(text: str) -> bool:",
    '    """Return True if text reads the same forwards and backwards, ignoring case and non-alphanumerics."""',
    "    cleaned = [c.lower() for c in text if c.isalnum()]",
    "    return cleaned == cleaned[::-1]",
    FENCE,
    "Non-alphanumeric characters and case are ignored, so \"A man, a plan, a canal: Panama\" counts as a palindrome. An empty string is a palindrome.",
  ].join("\n"),
};

const TESTS_SCHEMA = {
  type: "object",
  properties: { tests: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 5 } },
  required: ["tests"],
};

const TESTS_SYSTEM = (language: SandboxLanguage) =>
  `You write unit tests. Given ${language} code, return test expressions: each is ONE ${language} boolean expression that calls the code with literal inputs and is true when the code is correct ` +
  `(e.g. ${language === "python" ? "is_palindrome(\"racecar\") == True" : "isPalindrome(\"racecar\") === true"}). Cover normal cases and at least one edge case. No print statements, no imports.`;

const REPAIR_SYSTEM =
  "You are CodePilot fixing your own code. The code below failed when run. Find the bug and return the corrected code as one fenced code block. " +
  "Keep the same function names and signatures. If a test is clearly wrong rather than the code, keep the code correct anyway.";

/** Code pasted into the message: a fenced block, or what follows a colon when it looks like code. */
export function pastedCode(text: string): string | undefined {
  const fenced = /```[\w+-]*\n?([\s\S]*?)```/.exec(text);
  if (fenced?.[1].trim()) return fenced[1].trim();
  const after = text.slice(text.indexOf(":") + 1).trim();
  if (text.includes(":") && after.length > 12 && /[;{}()=]/.test(after) && /\b(const|let|var|function|def|import|return|select|insert|eval|exec|query|class|if|for)\b|=>|\$\{/i.test(after)) return after;
  return undefined;
}

function extractCodeBlock(text: string): { tag: string; code: string } {
  const m = text.match(/```([\w+-]*)\n([\s\S]*?)```/);
  return m ? { tag: m[1], code: m[2].trim() } : { tag: "", code: text.trim() };
}

/** Like extractCodeBlock, but only accepts an actual fenced block (a repair that replies in prose isn't code). */
function fencedCode(text: string): string | null {
  const m = text.match(/```[\w+-]*\n([\s\S]*?)```/);
  return m && m[1].trim() ? m[1].trim() : null;
}

/** Explanation text outside the code fence (kept from the first draft). */
function proseOutsideFence(text: string): string {
  return text.replace(/```[\w+-]*\n[\s\S]*?```/g, "").trim();
}

/** Top-level functions/classes the code defines -- the names tests may call. */
function definedNames(language: SandboxLanguage, code: string): string[] {
  const re =
    language === "python"
      ? /^(?:def|class)\s+([A-Za-z_]\w*)/gm
      : /^(?:export\s+)?(?:(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function|[A-Za-z_$][\w$]*\s*=>)|class\s+([A-Za-z_$][\w$]*))/gm;
  return Array.from(code.matchAll(re), (m) => m[1] ?? m[2] ?? m[3]).filter(Boolean);
}

/** Edit distance, for repairing near-miss names (small models "autocorrect" nth_prime to ninth_prime). */
function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

/** Rewrites calls to undefined names that are within 2 edits of a defined one; drops tests that still call nothing defined. */
function normalizeTest(test: string, defined: string[]): string | null {
  const fixed = test.replace(/\b([A-Za-z_$][\w$]*)\s*\(/g, (call, name: string) => {
    if (defined.includes(name)) return call;
    const near = defined.find((d) => editDistance(d, name) <= 2);
    return near ? call.replace(name, near) : call;
  });
  return defined.some((name) => new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\s*\\(`).test(fixed)) ? fixed : null;
}

/**
 * Self-consistent test generation: three samples at different temperatures. Tests
 * that a majority of samples agree on are kept (a sample that misremembers expected
 * values gets outvoted); if too few agree, the de-duplicated union is used.
 */
async function generateTests(language: SandboxLanguage, code: string, defined: string[], signal: AbortSignal): Promise<string[]> {
  if (defined.length === 0) return [];
  const prompt = `${FENCE}${language}\n${code}\n${FENCE}\n\nCall these exact names: ${defined.join(", ")}`;
  const samples = await Promise.all(
    [0.1, 0.5, 0.8].map((temperature) =>
      generateJson<{ tests: string[] }>(TESTS_SYSTEM(language), prompt, { signal, schema: TESTS_SCHEMA, temperature, maxTokens: 300 })
    )
  );
  const norm = (t: string) => t.replace(/\s+/g, "").replace(/'/g, '"');
  const counts = new Map<string, { test: string; n: number }>();
  for (const sample of samples) {
    const seen = new Set<string>();
    for (const raw of sample?.tests ?? []) {
      if (typeof raw !== "string" || !raw.trim() || raw.includes("\n") || refusalReason(language, raw)) continue;
      // A bare predicate call (no comparison) doesn't say what result it expects.
      if (!/==|!=|<|>|\bnot\b|\bis\b|\bin\b|!/.test(raw)) continue;
      const test = normalizeTest(raw.trim(), defined);
      if (!test || seen.has(norm(test))) continue;
      seen.add(norm(test));
      const entry = counts.get(norm(test)) ?? { test, n: 0 };
      entry.n++;
      counts.set(norm(test), entry);
    }
  }
  const all = [...counts.values()];
  const agreed = all.filter((e) => e.n >= 2).map((e) => e.test);
  return (agreed.length >= 2 ? agreed : all.sort((a, b) => b.n - a.n).map((e) => e.test)).slice(0, 6);
}

interface Verification {
  code: string;
  /** Explanation that came with this version of the code (it may be a repair or a fresh sample). */
  prose: string;
  status: "passed" | "failed" | "not_run";
  detail: string;
  repairs: number;
}

/**
 * Generate -> test -> repair -> resample: runs the generated code against
 * model-written tests in the sandbox; on failure, feeds the failures back for up to
 * two repairs, then (best-of-N) samples up to two fresh solutions and keeps
 * whichever passes the most tests. Execution feedback is the single biggest
 * quality lever for a small model.
 */
async function verifyCode(
  language: SandboxLanguage | null,
  code: string,
  prose: string,
  signal: AbortSignal,
  regenerate: () => Promise<string | null>
): Promise<Verification> {
  if (!language) return { code, prose, status: "not_run", detail: "Not executed: only Python and JavaScript can be run.", repairs: 0 };
  if (!sandboxEnabled()) return { code, prose, status: "not_run", detail: "Not executed: code execution is disabled (CODE_VERIFY=off).", repairs: 0 };
  const refusal = refusalReason(language, code);
  if (refusal) return { code, prose, status: "not_run", detail: `Not executed: the code ${refusal}.`, repairs: 0 };

  const defined = definedNames(language, code);
  const tests = await generateTests(language, code, defined, signal);

  if (tests.length === 0) {
    const run = await runSandboxed(language, code);
    return run.ok
      ? { code, prose, status: "passed", detail: "Verified: the code runs without errors (no usable tests could be generated).", repairs: 0 }
      : { code, prose, status: "failed", detail: `The code failed to run:\n${FENCE}\n${run.output}\n${FENCE}`, repairs: 0 };
  }

  // Keep the best version seen: a repair must pass more tests to replace it.
  let best = { code, prose, report: await runTests(language, code, tests) };
  let repairs = 0;
  while (best.report.passed < tests.length && repairs < 2) {
    repairs++;
    const problem = best.report.ran ? best.report.failures.join("\n") : best.report.output;
    const repaired = await generateText(
      REPAIR_SYSTEM,
      `${FENCE}${language}\n${best.code}\n${FENCE}\n\nTests:\n${tests.join("\n")}\n\nFailures:\n${problem}`,
      { signal, temperature: 0.2, maxTokens: 700 }
    );
    const next = repaired ? fencedCode(repaired) : null;
    if (!next || refusalReason(language, next)) continue;
    const report = await runTests(language, next, tests);
    if (report.passed > best.report.passed) best = { code: next, prose: best.prose, report };
  }

  // Best-of-N: small models fix their own bugs poorly but often get it right on a fresh try.
  let resamples = 0;
  while (best.report.passed < tests.length && resamples < 2) {
    resamples++;
    const fresh = await regenerate();
    const next = fresh ? fencedCode(fresh) : null;
    if (!next || refusalReason(language, next) || !defined.every((name) => definedNames(language, next).includes(name))) continue;
    const report = await runTests(language, next, tests);
    if (report.passed > best.report.passed) best = { code: next, prose: fresh ? proseOutsideFence(fresh) : best.prose, report };
  }
  repairs += resamples;

  const { report } = best;
  const testList = tests.map((t) => `\`${t}\``).join(", ");
  if (report.passed === tests.length) {
    return { code: best.code, prose: best.prose, status: "passed", detail: `Verified: ran ${tests.length} tests (${testList}) and all passed${repairs ? ` (after ${repairs} repair/resample attempt(s))` : ""}.`, repairs };
  }
  if (!report.ran) {
    return { code: best.code, prose: best.prose, status: "failed", detail: `The code failed to run:\n${FENCE}\n${report.output.split("\n").slice(-8).join("\n")}\n${FENCE}`, repairs };
  }
  // Mostly passing: the failing test is as likely to be wrong as the code (both come from the same small model).
  return {
    code: best.code,
    prose: best.prose,
    status: report.passed >= tests.length / 2 ? "passed" : "failed",
    detail: `Ran ${tests.length} tests: ${report.passed} passed, ${report.failures.length} failed -- ${report.failures.map((f) => `\`${f}\``).join("; ")}. A failing test may itself be wrong; check that case by hand.`,
    repairs,
  };
}

export type Severity = "critical" | "high" | "medium" | "low";

export interface Rule {
  id: string;
  severity: Severity;
  confidence: number;
  pattern: RegExp;
  title: string;
  fix: string;
}

const RULES: Rule[] = [
  {
    id: "sql-injection",
    severity: "critical",
    confidence: 0.9,
    pattern: /("|')\s*\+\s*\w+.*\b(SELECT|INSERT|UPDATE|DELETE)\b|\b(SELECT|INSERT|UPDATE|DELETE)\b[^\n]*\+\s*\w+/i,
    title: "Possible SQL injection via string concatenation",
    fix: "Use parameterized queries / a query builder (e.g. `db.query('... WHERE id = ?', [id])`) instead of concatenating user input into SQL.",
  },
  {
    id: "command-injection",
    severity: "critical",
    confidence: 0.85,
    pattern: /\bexec(Sync)?\s*\(\s*(["'`][^"'`]*["'`]\s*\+|`[^`]*\$\{)/,
    title: "Possible command injection via child_process.exec with concatenated input",
    fix: "Use `execFile`/`spawn` with an argument array instead of a shell string, and validate/allowlist any user-supplied values.",
  },
  {
    id: "hardcoded-secret",
    severity: "high",
    confidence: 0.75,
    pattern: /\b(api[_-]?key|secret|token|password)\b\s*[:=]\s*["'`][A-Za-z0-9_\-\.]{8,}["'`]/i,
    title: "Hardcoded credential-looking literal",
    fix: "Move the value to an environment variable / secrets manager and rotate the exposed credential.",
  },
  {
    id: "xss-unescaped-response",
    severity: "high",
    confidence: 0.7,
    pattern: /res\.send\(\s*["'`][^)]*\+\s*\w+/,
    title: "Possible reflected XSS: unescaped input concatenated into an HTML response",
    fix: "Escape the value (e.g. a templating engine with auto-escaping, or a library such as `escape-html`) before writing it into HTML.",
  },
  {
    id: "insecure-cookie",
    severity: "medium",
    confidence: 0.65,
    pattern: /\.cookie\([^)]*httpOnly\s*:\s*false/,
    title: "Session cookie set without httpOnly",
    fix: "Set `httpOnly: true` (and `secure: true`, `sameSite: 'lax'` or stricter) on session cookies to reduce XSS-driven session theft.",
  },
  {
    id: "eval-usage",
    severity: "high",
    confidence: 0.8,
    pattern: /\beval\s*\(/,
    title: "Use of eval()",
    fix: "Avoid `eval`; parse/validate structured input instead, or use a safe expression evaluator.",
  },
  {
    id: "unhandled-error-throw",
    severity: "low",
    confidence: 0.5,
    pattern: /if\s*\(\s*err\s*\)\s*throw\s+err/,
    title: "Database/callback error rethrown without handling",
    fix: "Handle the error explicitly (log + return a safe response) instead of throwing inside an async callback, which can crash the process.",
  },
];

const FIX_SYSTEM =
  "You fix security issues in a source file. Fix ONLY the listed issues, the safest standard way (parameterized queries, escaping output, secrets from environment variables, httpOnly/secure cookies, handled errors). " +
  "Keep everything else exactly the same: names, structure, formatting and comments. Return the complete fixed file in `code` and a one-sentence `summary` of what changed.";
const FIX_SCHEMA = { type: "object", properties: { summary: { type: "string" }, code: { type: "string" } }, required: ["summary", "code"] };

/** A fix for one workspace file, if the model's version really removes issues and adds none. */
async function writeFix(file: string, issues: Finding[], ctx: Parameters<AgentFn>[1]) {
  const target = safeWorkspacePath(ctx.workspaceRoot, file);
  if (!target) return null;
  const original = fs.readFileSync(target, "utf8");
  if (Buffer.byteLength(original) > MAX_PATCH_FILE_BYTES) return null;
  const list = issues.map((i) => `- line ${i.line}: ${i.rule.title} (${i.rule.severity}). Fix: ${i.rule.fix}`).join("\n");
  const r = await generateJson<{ summary: string; code: string }>(FIX_SYSTEM, `File: ${file}\nIssues:\n${list}\n\n${FENCE}\n${original}\n${FENCE}`, {
    signal: ctx.signal,
    schema: FIX_SCHEMA,
    temperature: 0.1,
    maxTokens: Math.min(6000, 600 + Math.ceil(original.length / 2.5)),
  });
  const code = typeof r?.code === "string" ? r.code.replace(/^```[\w-]*\n|\n```\s*$/g, "") : "";
  if (!code.trim() || code === original || code.length < original.length * 0.5 || code.length > original.length * 2.5) return null;
  // Check the fix with the same scanner: fewer issues, and no kind of issue that wasn't there before.
  const after = scanSource(file, code);
  const beforeRules = new Set(issues.map((i) => i.rule.id));
  if (after.length >= issues.length || after.some((f) => !beforeRules.has(f.rule.id))) return null;
  return { original, code: code.endsWith("\n") || !original.endsWith("\n") ? code : `${code}\n`, summary: String(r!.summary).slice(0, 200), diff: unifiedDiff(file, original, code), before: issues.length, resolved: issues.length - after.length };
}

/** Fixes for up to three workspace files with issues. */
async function writeFixes(findings: Finding[], ctx: Parameters<AgentFn>[1]) {
  const byFile = new Map<string, Finding[]>();
  for (const f of findings) if (!f.file.startsWith("<")) byFile.set(f.file, [...(byFile.get(f.file) ?? []), f]);
  const out = new Map<string, Awaited<ReturnType<typeof writeFix>>>();
  for (const [file, issues] of [...byFile].slice(0, 3)) {
    assertNotAborted(ctx);
    out.set(file, await writeFix(file, issues, ctx));
  }
  return out;
}

export interface Finding {
  file: string;
  line: number;
  rule: Rule;
  snippet: string;
}

export function scanSource(file: string, content: string): Finding[] {
  const found: Finding[] = [];
  const lines = content.split("\n");
  lines.forEach((line, idx) => {
    for (const rule of RULES) {
      if (rule.pattern.test(line)) {
        found.push({ file, line: idx + 1, rule, snippet: line.trim().slice(0, 240) });
      }
    }
  });
  return found;
}

export function listCodeFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const stack = [root];
  const exts = new Set([".js", ".ts", ".jsx", ".tsx", ".py", ".go"]);
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (exts.has(path.extname(entry.name))) out.push(full);
    }
  }
  return out;
}

const CODE_EXTS = new Set([".js", ".ts", ".jsx", ".tsx", ".py", ".go"]);

/** Code files inside the workspace that an upstream Helper result pointed at (evidence sources are "file:line"). */
function helperFiles(input: Parameters<AgentFn>[0], workspaceRoot: string): string[] {
  const root = path.resolve(workspaceRoot);
  const files = new Set<string>();
  for (const prior of priorResults(input).filter((p) => p.agent === "Helper")) {
    for (const ev of prior.evidence) {
      const full = path.resolve(root, ev.source.replace(/:\d+$/, ""));
      if (full.startsWith(root + path.sep) && CODE_EXTS.has(path.extname(full)) && fs.existsSync(full)) files.add(full);
    }
  }
  return Array.from(files);
}

export const severityRank: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1 };

/** "alert me only for critical issues", "turn off code alerts", "what are my code alert settings?" */
export const ALERT_SETTINGS = /\b(code |security |codepilot )?alerts?\b[^.?!]*\b(only|off|on|stop|settings?|level|critical|high|medium|low|every|all)\b|\b(turn (off|on)|stop|mute|pause|resume)\b[^.?!]*\b(code |security )?alerts?\b|\balert me\b/i;

async function alertSettings(input: Parameters<AgentFn>[0]) {
  const { alertLevel, setAlertLevel, pendingAlerts } = await import("../lib/codeWatch.js");
  const t = input.requestText.toLowerCase();
  let level = alertLevel();
  const turnOn = /\b(turn|switch)\b[^.?!]*\bon\b|\b(resume|enable|unmute|start)\b/.test(t);
  if (!turnOn && /\b(turn|switch)\b[^.?!]*\boff\b|\b(stop|mute|pause|disable|silence)\b|\bno (code )?alerts\b/.test(t)) level = "off";
  else if (/\bcritical\b/.test(t) && !/\bhigh\b/.test(t)) level = "critical";
  else if (/\bhigh\b/.test(t)) level = "high";
  else if (/\bmedium\b/.test(t)) level = "medium";
  else if (/\b(low|every|all|any)\b/.test(t)) level = "low";
  else if (turnOn && level === "off") level = "medium";
  const changed = level !== alertLevel();
  if (changed) setAlertLevel(level);
  logAgentAction(input.runId, "CodePilot", "alert_settings", { level }, changed ? "changed" : "unchanged");
  const describe = level === "off" ? "off" : level === "low" ? "on for every new issue" : `on for ${level === "critical" ? "critical" : `${level} and more serious`} issues`;
  return {
    status: "success" as const,
    findings: [
      `Code alerts are ${describe}. CodePilot watches your workspace's code folder and checks a file as soon as it changes; new issues show up in the sidebar${level === "off" ? " (when alerts are on)" : ""}. ${pendingAlerts().length ? `There are ${pendingAlerts().length} new issue(s) waiting.` : ""}`.trim(),
    ],
    evidence: [evidence("codepilot-watch", `alert level: ${level}`)],
    confidence: 0.95,
    limitations: [],
    proposedActions: [],
  };
}

export const codePilotAgent: AgentFn = async (input, ctx) => {
  assertNotAborted(ctx);
  if (ALERT_SETTINGS.test(input.requestText)) return alertSettings(input);

  const explicitCode = typeof input.context.code === "string" ? (input.context.code as string) : pastedCode(input.requestText);
  const wantsLearnMode = /learn mode/i.test(input.requestText) || input.context.learnMode === true;

  // Running tests or a command (here when safe, otherwise in an E2B cloud sandbox).
  const ran = await runCommandSkill(input, ctx);
  if (ran) return ran;

  // Large-scale work: a change across an existing project, or a whole new multi-file project.
  if (!explicitCode && !REVIEW_INTENT.test(input.requestText)) {
    const project = projectToEdit(input.requestText, ctx.workspaceRoot);
    if (project) return editProject(input, ctx, project);
    if (isProjectRequest(input.requestText)) return buildProject(input, ctx);
  }

  if (!explicitCode && GENERATE_INTENT.test(input.requestText) && !REVIEW_INTENT.test(input.requestText)) {
    const prompt = input.requestText + previousTurnText(input);
    // A whole web page is much longer than a function.
    const webPage = WEB_PAGE.test(input.requestText);
    const maxTokens = webPage ? 2200 : 900;
    const generated = await generateText(GENERATE_SYSTEM, prompt, {
      signal: ctx.signal,
      examples: [GENERATE_EXAMPLE],
      maxTokens,
      temperature: 0.2,
    });
    assertNotAborted(ctx);
    if (generated) {
      const { tag, code } = extractCodeBlock(generated);
      const language = sandboxLanguage(tag, input.requestText);
      const regenerate = () =>
        generateText(GENERATE_SYSTEM, prompt, { signal: ctx.signal, examples: [GENERATE_EXAMPLE], maxTokens, temperature: 0.8 });
      const verification = await verifyCode(language, code, proseOutsideFence(generated), ctx.signal, regenerate);
      assertNotAborted(ctx);
      const issues = scanSource("<generated code>", verification.code);
      logAgentAction(
        input.runId,
        "CodePilot",
        "generate_code",
        { model: agentModel(), language, verification: verification.status, repairs: verification.repairs, scanIssues: issues.length },
        "completed"
      );
      const prose = verification.prose;
      // A finished HTML page gets a live preview (shown in a sandboxed frame in the app).
      const html = /^html?$/i.test(tag) || /^\s*<!doctype html|^\s*<html[\s>]/i.test(verification.code) ? verification.code : null;
      return {
        status: issues.length || verification.status === "failed" ? "partial_success" : "success",
        findings: [
          `${FENCE}${tag || language || ""}\n${verification.code}\n${FENCE}${prose ? `\n\n${prose}` : ""}`,
          verification.detail,
          issues.length
            ? `Security scan flagged ${issues.length} issue(s): ${issues.map((i) => `${i.rule.title} (line ${i.line})`).join("; ")}. Review before using.`
            : `Security scan: passed (${RULES.length} rules).`,
        ],
        evidence: [
          evidence(`ai-model:${agentModel()}`, "Code written by the AI model."),
          ...(verification.status === "passed" ? [evidence("sandbox-run", verification.detail)] : []),
        ],
        confidence: verification.status === "passed" && !issues.length ? 0.8 : verification.status === "failed" ? 0.35 : 0.55,
        limitations: [
          modelLimitation(),
          verification.status === "passed"
            ? "Tests were written by the same model, so passing them is strong but not complete evidence of correctness."
            : html
              ? "The page wasn't run automatically; try it in the preview, or save it as an .html file and open it."
              : "The code was not fully verified by execution; test it before relying on it.",
        ],
        proposedActions: [],
        ...(html ? { attachments: [{ type: "html-preview" as const, title: input.requestText.slice(0, 80), html }] } : {}),
      };
    }
    logAgentAction(input.runId, "CodePilot", "generate_code", { model: agentModel() }, "local_model_unavailable");
    return {
      status: "partial_success",
      findings: [aiUnavailableReason() ? `Code generation needs the AI model: ${aiUnavailableReason()}` : "Code generation needs the AI model (Groq), which didn't respond. Check GROQ_API_KEY in server/.env and your internet connection, then try again, or paste existing code for a security scan."],
      evidence: [],
      confidence: 0.1,
      limitations: ["Without the AI model CodePilot can only scan existing code; it does not write new code."],
      proposedActions: [],
    };
  }

  // Neither "write" nor "review": CodePilot has no code task here (e.g. "explain how it works").
  // It passes along the code from the previous turn, if any, for the agent that's teaching it.
  const original = typeof input.context.originalRequest === "string" ? input.context.originalRequest : "";
  if (!explicitCode && !REVIEW_INTENT.test(`${input.requestText}\n${original}`) && priorResults(input).length === 0) {
    const prev = input.context.previousTurn as { answer?: string } | undefined;
    const earlierCode = prev?.answer?.match(/```[\w+-]*\n[\s\S]*?```/)?.[0];
    logAgentAction(input.runId, "CodePilot", "no_code_task", { passedEarlierCode: Boolean(earlierCode) }, "skipped_scan");
    return {
      status: "success",
      role: "support",
      findings: [earlierCode ? `Code from earlier in the conversation:\n${earlierCode}` : "No code to write or review in this request."],
      evidence: [],
      confidence: 0.5,
      limitations: [],
      proposedActions: [],
    };
  }

  let findings: Finding[] = [];
  let scannedDescription: string;

  if (explicitCode) {
    findings = scanSource("<submitted snippet>", explicitCode);
    scannedDescription = "the submitted code snippet";
    logAgentAction(input.runId, "CodePilot", "scan_code", { source: "inline_snippet", chars: explicitCode.length }, "completed");
  } else if (helperFiles(input, ctx.workspaceRoot).length > 0) {
    // Helper ran first and located relevant code files: scan exactly those.
    const files = helperFiles(input, ctx.workspaceRoot);
    for (const file of files) {
      assertNotAborted(ctx);
      findings.push(...scanSource(path.relative(ctx.workspaceRoot, file).split(path.sep).join("/"), fs.readFileSync(file, "utf8")));
    }
    scannedDescription = `${files.length} code file(s) Helper located (${files.map((f) => path.relative(ctx.workspaceRoot, f).split(path.sep).join("/")).join(", ")})`;
    logAgentAction(input.runId, "CodePilot", "scan_code", { source: "helper_results", filesScanned: files.length }, "completed");
  } else {
    const codeRoot = path.join(ctx.workspaceRoot, "code");
    const files = listCodeFiles(codeRoot);
    for (const file of files) {
      assertNotAborted(ctx);
      const rel = path.relative(ctx.workspaceRoot, file).split(path.sep).join("/");
      findings.push(...scanSource(rel, fs.readFileSync(file, "utf8")));
    }
    scannedDescription = `${files.length} approved code file(s) in the workspace`;
    logAgentAction(input.runId, "CodePilot", "scan_code", { source: "workspace", filesScanned: files.length }, "completed");
  }

  if (findings.length === 0) {
    return {
      status: "success",
      findings: [`Scanned ${scannedDescription}; no issues matched the supported rule set (${RULES.length} rules).`],
      evidence: [],
      confidence: 0.5,
      limitations: ["Static scan only covers a fixed rule set (injection, secrets, XSS, eval, cookie flags); it is not a full SAST tool."],
      proposedActions: [],
    };
  }

  findings.sort((a, b) => severityRank[b.rule.severity] - severityRank[a.rule.severity]);

  const byRule = new Map<string, Finding[]>();
  for (const f of findings) {
    byRule.set(f.rule.id, [...(byRule.get(f.rule.id) ?? []), f]);
  }

  const resultFindings: string[] = [
    `Scanned ${scannedDescription} and found ${findings.length} issue(s) across ${byRule.size} rule(s).`,
  ];
  const proposedActions = [];
  for (const [, group] of byRule) {
    const rule = group[0].rule;
    const locations = group.map((g) => `${g.file}:${g.line}`).join(", ");
    resultFindings.push(
      `[${rule.severity.toUpperCase()}] ${rule.title} — found at ${locations}. Suggested fix: ${rule.fix}`
    );
  }

  // Ready-to-apply fixes for workspace files: written by the AI model, kept only if a rescan shows
  // fewer issues and no new kinds, shown as a diff, and applied to the file only when approved.
  const fixed = explicitCode ? new Map<string, Awaited<ReturnType<typeof writeFix>>>() : await writeFixes(findings, ctx);
  for (const [file, fix] of fixed) {
    if (!fix) continue;
    const worst = findings.filter((f) => f.file === file).some((f) => f.rule.severity === "critical" || f.rule.severity === "high");
    const action = { ...proposedAction(`Apply CodePilot's fix to ${file}: ${fix.summary}`, worst ? "high" : "medium"), preview: fix.diff.slice(0, 8000) };
    savePatch({ id: action.id, file, original: fix.original, fixed: fix.code, summary: fix.summary });
    proposedActions.push(action);
    resultFindings.push(`**Fix ready for ${file}** (resolves ${fix.resolved} of ${fix.before} issue${fix.before === 1 ? "" : "s"}): review the change below and approve it to update the file. You can undo it afterwards.`);
  }
  // Issues without a ready fix are still listed as actions to take by hand.
  for (const [, group] of byRule) {
    const rule = group[0].rule;
    const open = group.filter((g) => !fixed.get(g.file));
    if (open.length === 0) continue;
    // A to-do for the user, not something OmniPilot can carry out: no approval button.
    proposedActions.push(proposedAction(`Fix "${rule.title}" at ${open.map((g) => `${g.file}:${g.line}`).join(", ")}`, rule.severity === "critical" || rule.severity === "high" ? "high" : "medium", false));
  }
  if (fixed.size) logAgentAction(input.runId, "CodePilot", "write_fixes", { files: [...fixed.keys()], ready: [...fixed.values()].filter(Boolean).length }, "completed");

  if (wantsLearnMode) {
    resultFindings.push(
      "Learn Mode: each finding above is a teachable pattern — ask me to walk through why a specific rule fires and how the fix prevents it, and I will explain it step by step."
    );
  }

  const avgConfidence = findings.reduce((s, f) => s + f.rule.confidence, 0) / findings.length;

  return {
    status: "success",
    findings: resultFindings,
    evidence: findings.map((f) => evidence(`${f.file}:${f.line}`, `[${f.rule.id}] ${f.snippet}`)),
    confidence: Math.round(avgConfidence * 100) / 100,
    limitations: [
      "Static, regex/pattern-based scan only — not a full compiler-aware SAST tool and cannot prove the absence of other issues.",
      "Confidence reflects pattern-match certainty, not a guarantee of exploitability in this specific runtime.",
    ],
    proposedActions,
  };
};
