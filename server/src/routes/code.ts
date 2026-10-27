import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import { asyncRoute } from "../lib/security.js";
import { scanSource } from "../agents/codePilot.js";
import { agentLlmEnabled, generateJson, generateText } from "../lib/llm.js";
import { checkProject } from "../lib/projectCheck.js";
import { WORKSPACE_ROOT } from "../orchestrator.js";
import { alertLevel, markAlertsSeen, pendingAlerts, scanAll } from "../lib/codeWatch.js";

// CodePilot's always-on alerts (local only: not offered to SDK tokens).
export const codeRouter = Router();

codeRouter.get("/code/alerts", (_req, res) => {
  res.json({ level: alertLevel(), alerts: pendingAlerts() });
});

codeRouter.post("/code/alerts/seen", (_req, res) => {
  markAlertsSeen();
  res.json({ ok: true });
});

/** The "run button": scan every code file now. */
codeRouter.post("/code/scan", (_req, res) => {
  res.json(scanAll(WORKSPACE_ROOT));
});

// --- For the VS Code extension (local only) ---

const textSchema = z.object({ file: z.string().max(300).default("untitled"), content: z.string().max(200_000) });

/** Security scan of an editor's text (the extension shows the results in the Problems panel). */
codeRouter.post("/code/scan-text", (req, res) => {
  const parsed = textSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  const findings = scanSource(parsed.data.file, parsed.data.content);
  res.json({ findings: findings.map((f) => ({ line: f.line, severity: f.rule.severity, title: f.rule.title, fix: f.rule.fix, rule: f.rule.id })) });
});

const assistSchema = z.object({
  mode: z.enum(["explain", "fix", "improve", "tests", "custom"]),
  file: z.string().max(300).default("untitled"),
  language: z.string().max(40).default(""),
  code: z.string().min(1).max(60_000),
  /** The whole file, for context when `code` is a selection. */
  context: z.string().max(120_000).optional(),
  instruction: z.string().max(2000).optional(),
});

const ASSIST_SYSTEM: Record<string, string> = {
  explain: "Explain this code clearly for a student: what it does overall, then the important parts step by step, and anything surprising or risky. Use short paragraphs and bullet points.",
  fix: "Find and fix the bugs in this code (logic errors, crashes, edge cases, security problems). Keep the style, names and structure; change only what's needed.",
  improve: "Improve this code: clearer names, simpler logic, better error handling and performance, same behaviour and public interface.",
  tests: "Write thorough unit tests for this code using the language's standard test framework (unittest for Python, node:test for JavaScript/TypeScript). Cover normal cases, edge cases and errors.",
  custom: "Change this code exactly as the user asks. Keep everything else the same.",
};

/** Explain / fix / improve / write tests for code from the editor. Code answers are checked before they're returned. */
codeRouter.post("/code/assist", asyncRoute(async (req, res) => {
  const parsed = assistSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  const { mode, file, language, code, context, instruction } = parsed.data;
  if (!agentLlmEnabled()) return res.status(503).json({ error: "ai_unavailable", message: "The AI model (Groq) isn't available. Check GROQ_API_KEY in server/.env." });
  const where = `File: ${file}${language ? ` (${language})` : ""}`;
  const ctxText = context && context !== code ? `\n\nThe whole file, for context:\n~~~~\n${context.slice(0, 60_000)}\n~~~~` : "";
  if (mode === "explain") {
    const text = await generateText(ASSIST_SYSTEM.explain, `${where}${instruction ? `\nQuestion: ${instruction}` : ""}\n\n~~~~\n${code}\n~~~~${ctxText}`, { maxTokens: 2500, maxInput: 120_000, effort: "medium" });
    return text ? res.json({ text }) : res.status(502).json({ error: "no_answer", message: "The AI didn't answer. Try again." });
  }
  const r = await generateJson<{ summary: string; code: string }>(
    `${ASSIST_SYSTEM[mode]} Return the complete resulting code in \`code\` (for "tests", the complete test file) and a one-paragraph \`summary\` of what you changed or covered.`,
    `${where}${instruction ? `\nRequest: ${instruction}` : ""}\n\n~~~~\n${code}\n~~~~${ctxText}`,
    { schema: { type: "object", properties: { summary: { type: "string" }, code: { type: "string" } }, required: ["summary", "code"] }, maxTokens: 9000, maxInput: 120_000, effort: "medium", temperature: 0.15 }
  );
  const out = typeof r?.code === "string" ? r.code.replace(/^```[\w-]*\n|\n```\s*$/g, "") : "";
  if (!out.trim()) return res.status(502).json({ error: "no_answer", message: "The AI didn't return code. Try again." });
  // Checks: the new code parses, and (for fixes/improvements) it adds no new kind of security issue.
  const ext = path.extname(file) || (/python/i.test(language) ? ".py" : /typescript/i.test(language) ? ".ts" : ".js");
  const check = await checkProject([{ path: `snippet${ext}`, content: out }], { runTests: false });
  const syntax = check.problems.filter((p) => /Syntax/.test(p.message)).map((p) => `line ${p.line ?? "?"}: ${p.message}`);
  const before = new Set(scanSource(file, code).map((f) => f.rule.id));
  const newIssues = mode === "tests" ? [] : scanSource(file, out).filter((f) => !before.has(f.rule.id)).map((f) => `line ${f.line}: ${f.rule.title}`);
  res.json({ code: out, summary: String(r!.summary ?? "").slice(0, 1500), checks: { syntax, newIssues } });
}));
