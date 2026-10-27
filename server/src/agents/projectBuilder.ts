import fs from "node:fs";
import path from "node:path";
import type { AgentInput, Attachment, ProposedAction } from "../types.js";
import type { AgentContext, AgentFn } from "./base.js";
import { assertNotAborted, evidence, logAgentAction, proposedAction } from "./base.js";
import { agentLlmEnabled, agentModel, generateJson, generateText } from "../lib/llm.js";
import { aiUnavailableReason } from "../lib/groq.js";
import { checkProject, describeCheck, type CheckReport, type ProjectFile } from "../lib/projectCheck.js";
import { savePatchSet, unifiedDiff } from "../lib/patches.js";
import { workspaceIndex } from "../lib/fileIndex.js";
import { scanSource } from "./codePilot.js";

type Result = Awaited<ReturnType<AgentFn>>;

// CodePilot's large-scale coding: whole projects, and changes across an existing codebase.
//
// New project ("build a flashcard app in Python with tests"):
//   plan the files and what each one provides -> write them in dependency order (each file sees
//   the files it uses, so names and signatures match) -> check the whole project (every file
//   parses, imports match, the project's own tests run in a sandbox) -> repair what failed, up to
//   three rounds -> offer it as one change set to create under workspace/projects/, with a file
//   browser and (for web projects) a live preview. Nothing is written until the user approves.
//
// Existing project ("add a high-score table to my snake game project"):
//   read the project -> plan which files change -> rewrite small files whole and edit big files
//   with exact find/replace blocks -> check the whole project with the changes -> repair -> offer
//   the change set as diffs, applied all-or-nothing on approval (and undoable).

const BUILD_VERB = String.raw`\b(build|create|make|scaffold|generate|write|develop|code|set up|start)\b`;
const EXPLICIT_PROJECT = new RegExp(`${BUILD_VERB}[^.?!]*\\b(project|multi[- ]?file|full[- ]?stack|codebase|several files|multiple files|backend|rest api|api server|web server|cli tool|command[- ]line (tool|app)|library|package|with (unit )?tests)\\b`, "i");
const APP_LIKE = new RegExp(`${BUILD_VERB}[^.?!]*\\b(app|application|game|website|web app|system|dashboard|tracker|manager|bot|simulator|platform|tool)\\b`, "i");
const SINGLE_FILE = /\b(function|snippet|regex|one[- ]liner|single (file|page)|web ?page|landing page|html page|browser game|script that)\b/i;

export const EDIT_PROJECT =
  /\b(add|change|update|refactor|rename|implement|improve|extend|convert|rewrite|migrate|modify|upgrade|restructure|split)\b[^.?!]*\b(my|the|this|our)\s+(?:[\w-]+\s+){0,3}(project|app|codebase|code ?base|repo|program|game|site|website)\b/i;

/** "build a todo app with tests" (a project), not "write a function" or "make a calculator web page". */
export function isProjectRequest(text: string): boolean {
  if (EXPLICIT_PROJECT.test(text)) return true;
  return APP_LIKE.test(text) && !SINGLE_FILE.test(text);
}

/** Changing an existing workspace project (one the file index recognises). */
export function projectToEdit(text: string, workspaceRoot: string) {
  if (!EDIT_PROJECT.test(text)) return null;
  try {
    return workspaceIndex(workspaceRoot).matchProjects(text)[0] ?? null;
  } catch {
    return null;
  }
}

const MAX_FILES = 24;
const FENCE_RE = /^~~~~(file|edit) ([^\n]+)\n([\s\S]*?)\n~~~~[ \t]*$/gm;

interface PlanFile {
  path: string;
  purpose: string;
  provides: string;
  uses: string[];
}
interface Plan {
  name: string;
  summary: string;
  language: string;
  run: string;
  test: string;
  files: PlanFile[];
}

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    summary: { type: "string" },
    language: { type: "string", enum: ["python", "javascript", "typescript", "web"] },
    run: { type: "string" },
    test: { type: "string" },
    files: {
      type: "array",
      items: {
        type: "object",
        properties: { path: { type: "string" }, purpose: { type: "string" }, provides: { type: "string" }, uses: { type: "array", items: { type: "string" } } },
        required: ["path", "purpose", "provides", "uses"],
      },
    },
  },
  required: ["name", "summary", "language", "run", "test", "files"],
};

const PLAN_SYSTEM = `You are a senior software architect planning a complete, working project that a student can run immediately.
Rules:
- Use only the language's standard library unless the user names a framework or library. Plain web projects are HTML + CSS + JavaScript with no build step.
- Web projects: load scripts with classic <script src> tags in dependency order (no import/export), so index.html works when double-clicked. Put game/app logic in its own file and end it with: if (typeof module !== "undefined") module.exports = { ...the logic functions };  so tests can require it. Test files are named *.test.cjs and use node:test + node:assert with require(). No package.json for plain web projects.
- Python: a package folder for the logic, a main.py entry point, and tests in tests/test_*.py using unittest (import the package from the project root).
- JavaScript (Node): ES modules ("type": "module" in package.json), tests as *.test.js with node:test.
- Separate concerns: logic, data/storage, interface. Small focused files (under ~250 lines each), at most ${MAX_FILES} files including a README.md (what it is, how to run, how to test).
- Write real tests for the logic (several meaningful cases each), not placeholders. Tests that touch files use a temporary folder that cleans itself up (Python: tempfile.TemporaryDirectory(); Node: fs.mkdtempSync(path.join(os.tmpdir(), "t-"))) and never delete files directly (no os.remove/os.unlink/shutil/fs.rmSync). No network, no subprocesses.
- For each file give its path, its purpose, exactly what it provides (function/class names with parameters and return values; for HTML the element ids; for CSS the main classes), and which other project files it uses.
- name: short kebab-case folder name. run/test: the exact shell commands, run from the project folder.`;

const FILE_SYSTEM = `You write ONE file of a multi-file project, complete and production quality: no placeholders, no "TODO", no omitted parts.
Tests: use a self-cleaning temporary folder for any files (tempfile.TemporaryDirectory() / fs.mkdtempSync in os.tmpdir()), never delete files directly, no network or subprocesses.
Match the plan exactly: use the exact names, parameters and return values the plan and the files you depend on define. Handle errors and edge cases. Comment only where it helps.
Reply with only the file inside one block that starts with a line "~~~~file <path>" and ends with a line "~~~~".`;

const REPAIR_SYSTEM = `You fix a multi-file project so it passes its checks and tests. You see the problems, the test output and the relevant files.
Fix the real cause (the code under test is usually what's wrong, but fix a test if the test itself contradicts the plan). Keep everything that works.
For each file you change, reply with the COMPLETE new file in a block that starts with "~~~~file <path>" and ends with "~~~~". Change only files that need it.`;

const EDIT_PLAN_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    changes: { type: "array", items: { type: "object", properties: { path: { type: "string" }, action: { type: "string", enum: ["modify", "create"] }, what: { type: "string" } }, required: ["path", "action", "what"] } },
  },
  required: ["summary", "changes"],
};

const EDIT_SYSTEM = `You change an existing codebase as requested, like a careful senior engineer: keep its style, structure and names, change only what's needed, and keep existing behaviour working (update or add tests for what you change).
For a NEW file or a small file, reply with the complete file: "~~~~file <path>" ... "~~~~".
For a LARGE existing file, reply with exact edits instead:
~~~~edit <path>
<<<<<<< FIND
(exact existing lines, copied character for character, enough to be unique)
=======
(replacement lines)
>>>>>>> REPLACE
~~~~
(several FIND/REPLACE pairs may go in one edit block).`;

/** Every "~~~~file path" / "~~~~edit path" block in a reply. */
export function parseBlocks(text: string): { kind: "file" | "edit"; path: string; body: string }[] {
  return [...text.matchAll(FENCE_RE)].map((m) => ({ kind: m[1] as "file" | "edit", path: cleanPath(m[2]), body: m[1] === "file" ? unwrapFence(m[3], m[2]) : m[3] }));
}

/** A file body the model wrapped in an extra ```lang fence (inside our block): take the code out. */
function unwrapFence(body: string, file: string): string {
  if (/\.(md|markdown)$/i.test(file.trim())) return body;
  const m = /^\s*```[\w+.-]*[ \t]*\n([\s\S]*?)\n```[ \t]*\s*$/.exec(body);
  return m ? m[1] : body;
}

/**
 * The file's content from a reply, whatever fence the model used: our "~~~~file" block (even
 * without its closing line), else the largest ``` block, else the whole reply.
 */
export function extractFile(reply: string, file: string): string | null {
  const blocks = parseBlocks(reply).filter((b) => b.kind === "file");
  const exact = blocks.find((b) => b.path === file) ?? blocks[0];
  if (exact) return exact.body;
  const open = /^~~~~file[^\n]*\n([\s\S]*)$/m.exec(reply);
  if (open) return unwrapFence(open[1].replace(/\n~~~~\s*$/, ""), file);
  if (/\.(md|markdown)$/i.test(file)) return reply.trim() ? reply.replace(/^\s*```(markdown|md)?\n|\n```\s*$/g, "") : null;
  const fences = [...reply.matchAll(/```[\w+.-]*[ \t]*\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  if (fences.length) return fences.sort((a, b) => b.length - a.length)[0];
  return reply.trim() ? reply : null;
}

const cleanPath = (p: string) => p.trim().replace(/^["'`]|["'`]$/g, "").replace(/^\.\//, "").replace(/\\/g, "/");

/** A safe relative path inside the project (no absolute paths, no "..", no hidden folders). */
export function safeRel(p: string): string | null {
  const c = cleanPath(p);
  if (!c || c.startsWith("/") || /^[a-z]:/i.test(c) || c.split("/").some((part) => part === ".." || part === "" || part.startsWith(".")) || c.length > 160) return null;
  return c;
}

/** Applies FIND/REPLACE pairs; each FIND must match exactly once. */
export function applyEdits(original: string, body: string): { text: string; failed: string[] } {
  let text = original;
  const failed: string[] = [];
  for (const m of body.matchAll(/<<<<<<< FIND\n([\s\S]*?)\n=======\n([\s\S]*?)\n?>>>>>>> REPLACE/g)) {
    const [find, replace] = [m[1], m[2]];
    const at = text.indexOf(find);
    if (at < 0 || text.indexOf(find, at + 1) >= 0) {
      failed.push(find.split("\n")[0].slice(0, 80));
      continue;
    }
    text = text.slice(0, at) + replace + text.slice(at + find.length);
  }
  return { text, failed };
}

/** Files grouped so each group only uses files from earlier groups (writing order). */
export function writeOrder(files: PlanFile[]): PlanFile[][] {
  const paths = new Set(files.map((f) => f.path));
  const done = new Set<string>();
  const levels: PlanFile[][] = [];
  let left = [...files];
  while (left.length) {
    const ready = left.filter((f) => f.uses.filter((u) => paths.has(u) && u !== f.path).every((u) => done.has(u)));
    const level = ready.length ? ready : left; // a cycle: write the rest together
    levels.push(level);
    for (const f of level) done.add(f.path);
    left = left.filter((f) => !level.includes(f));
  }
  return levels;
}

const lang = (p: string) => ({ ".py": "python", ".js": "javascript", ".cjs": "javascript", ".mjs": "javascript", ".ts": "typescript", ".tsx": "tsx", ".jsx": "jsx", ".html": "html", ".css": "css", ".json": "json", ".md": "markdown" })[path.extname(p).toLowerCase()] ?? "text";

function treeText(files: { path: string; content: string }[]): string {
  return files.map((f) => `${f.path} (${f.content.split("\n").length} lines)`).join("\n");
}

/** index.html with its local CSS and scripts inlined, for the sandboxed live preview. */
export function inlineWebPreview(files: ProjectFile[]): string | null {
  const index = files.find((f) => /(^|\/)index\.html$/i.test(f.path));
  if (!index) return null;
  const dir = path.posix.dirname(index.path);
  const get = (ref: string) => files.find((f) => f.path === path.posix.normalize(path.posix.join(dir, ref)).replace(/^\//, ""));
  if (files.some((f) => /\.m?js$/.test(f.path) && /^\s*(import|export)\s/m.test(f.content))) return null; // ES modules can't be inlined safely
  return index.content
    .replace(/<link[^>]*href=["']([^"':]+\.css)["'][^>]*>/gi, (m, ref) => (get(ref) ? `<style>\n${get(ref)!.content}\n</style>` : m))
    .replace(/<script([^>]*)src=["']([^"':]+\.js)["']([^>]*)>\s*<\/script>/gi, (m, _a, ref) => (get(ref) ? `<script>\n${get(ref)!.content.replace(/<\/script/gi, "<\\/script")}\n</script>` : m));
}

/** A file's outline: its size and the lines that define things (functions, classes, exports, ids). */
export function outline(file: string, content: string): string {
  const defs = content
    .split("\n")
    .filter((l) => /^\s*(async\s+)?(def|class)\s+\w|^\s*(export\s+)?(default\s+)?(async\s+)?(function\*?|class|interface|type|enum)\s+\w|^\s*(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s*)?(\(|function|\w+\s*=>)|module\.exports|^\s*[A-Z_]{3,}\s*=|\sid=["'][\w-]+["']/.test(l))
    .slice(0, 25)
    .map((l) => `    ${l.trim().slice(0, 140)}`);
  return `- ${file} (${content.split("\n").length} lines)${defs.length ? `\n${defs.join("\n")}` : ""}`;
}

function progress(input: AgentInput, message: string, details: Record<string, unknown> = {}) {
  logAgentAction(input.runId, "CodePilot", "build_progress", { message, ...details }, message);
}

const ask = (system: string, user: string, ctx: AgentContext, maxTokens: number, temperature = 0.2) =>
  generateText(system, user, { signal: ctx.signal, maxTokens, temperature, maxInput: 60_000, patientMs: 90_000, preferBestMs: 45_000, effort: "medium" });

/** Rounds of check -> repair. Returns the final files and report. */
async function checkAndRepair(input: AgentInput, ctx: AgentContext, files: Map<string, string>, context: string, deadline: number): Promise<{ report: CheckReport; repairs: number }> {
  let report = await checkProject([...files].map(([p, content]) => ({ path: p, content })));
  let repairs = 0;
  // A repair is kept only if it leaves fewer problems + failing tests; otherwise the better version stays.
  // Tests the sandbox refused to run (they delete files, use the network...) count as a problem to fix.
  const refused = (r: CheckReport) => Boolean(r.tests.why && /\buses `/.test(r.tests.why));
  const badness = (r: CheckReport) => r.problems.length * 2 + r.tests.failed + (refused(r) ? 1 : 0);
  for (let round = 1; round <= 3 && (report.problems.length || report.tests.failed || refused(report)) && Date.now() < deadline - 40_000; round++) {
    assertNotAborted(ctx);
    progress(input, `Fixing ${report.problems.length ? `${report.problems.length} problem(s)` : report.tests.failed ? `${report.tests.failed} failing test(s)` : "tests so they can run safely"} (round ${round})…`);
    // The files involved: those with problems, plus (for failing tests) the tests and what they use.
    const involved = new Set(report.problems.map((p) => p.file));
    const refusedFile = refused(report) ? /^(\S+) uses/.exec(report.tests.why!)?.[1] : undefined;
    if (refusedFile && files.has(refusedFile)) involved.add(refusedFile);
    if (report.tests.failed) for (const p of files.keys()) if (/test/i.test(p) || report.tests.output.includes(path.basename(p, path.extname(p)))) involved.add(p);
    if (!involved.size) for (const p of files.keys()) if (!/\.(md|json|css)$/.test(p)) involved.add(p);
    // Full text of the files involved (within a token budget), an outline of the rest.
    let budget = 30_000;
    const full = [...involved].filter((p) => files.has(p)).filter((p) => (budget -= files.get(p)!.length) >= 0);
    const shown = [
      ...full.map((p) => `~~~~file ${p}\n${files.get(p)}\n~~~~`),
      `Outline of the other files:\n${[...files].filter(([p]) => !full.includes(p)).map(([p, c]) => outline(p, c)).join("\n")}`,
    ].join("\n\n");
    const problems = report.problems.map((p) => `- ${p.file}${p.line ? `:${p.line}` : ""}: ${p.message}`).join("\n");
    const reply = await ask(
      REPAIR_SYSTEM,
      `${context}\n\nAll files: ${[...files.keys()].join(", ")}\n\nProblems:\n${problems || "(none)"}${refusedFile ? `\n- ${report.tests.why}. Rewrite it to use a self-cleaning temporary folder (tempfile.TemporaryDirectory() / fs.mkdtempSync in os.tmpdir()) with no direct file deletion, network or subprocesses, so the tests can run.` : ""}\n\nTest output:\n${report.tests.ran ? report.tests.output.slice(-4000) : "(not run)"}\n\nFiles:\n${shown}`,
      ctx,
      9000,
      0.15
    );
    const blocks = reply ? parseBlocks(reply).filter((b) => b.kind === "file" && safeRel(b.path) && b.body.trim()) : [];
    if (!blocks.length) break;
    const before = new Map(files);
    for (const b of blocks) files.set(safeRel(b.path)!, b.body.endsWith("\n") ? b.body : `${b.body}\n`);
    const next = await checkProject([...files].map(([p, content]) => ({ path: p, content })));
    if (badness(next) < badness(report) || (next.tests.ran && !report.tests.ran && next.problems.length <= report.problems.length)) {
      report = next;
      repairs++;
    } else {
      files.clear();
      for (const [p, c] of before) files.set(p, c);
    }
  }
  return { report, repairs };
}

function securityNotes(files: Map<string, string>): string[] {
  return [...files].flatMap(([p, c]) => scanSource(p, c).map((f) => `${p}:${f.line} ${f.rule.title}`)).slice(0, 6);
}

function freeFolder(workspaceRoot: string, name: string): string {
  const slug = (name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "project").slice(0, 40);
  for (let i = 1; i < 50; i++) {
    const rel = `projects/${slug}${i > 1 ? `-${i}` : ""}`;
    if (!fs.existsSync(path.join(workspaceRoot, rel))) return rel;
  }
  return `projects/${slug}-${Date.now()}`;
}

const noModel = (): Result => ({
  status: "partial_success",
  findings: [aiUnavailableReason() ?? "Building or changing a project needs the AI model (Groq), which didn't respond. Check GROQ_API_KEY in server/.env and your connection, then try again."],
  evidence: [],
  confidence: 0.1,
  limitations: [],
  proposedActions: [],
});

/** Builds a new multi-file project. */
export async function buildProject(input: AgentInput, ctx: AgentContext, budgetMs = 330_000): Promise<Result> {
  if (!agentLlmEnabled()) return noModel();
  const deadline = Date.now() + budgetMs;
  const request = input.requestText;
  progress(input, "Planning the project…");
  const plan = await generateJson<Plan>(PLAN_SYSTEM, request, { signal: ctx.signal, schema: PLAN_SCHEMA, temperature: 0.2, maxTokens: 4000, effort: "medium", patientMs: 60_000, preferBestMs: 45_000 });
  assertNotAborted(ctx);
  if (!plan?.files?.length) return noModel();
  const planned = plan.files
    .map((f) => ({ ...f, path: safeRel(f.path) ?? "" }))
    .filter((f, i, all) => f.path && all.findIndex((g) => g.path === f.path) === i)
    .slice(0, MAX_FILES)
    .map((f) => ({ ...f, uses: (f.uses ?? []).map((u) => safeRel(u) ?? "").filter(Boolean) }));
  const planText = `Project: ${plan.name} -- ${plan.summary}\nLanguage: ${plan.language}. Run: ${plan.run}. Test: ${plan.test}\nFiles:\n${planned.map((f) => `- ${f.path}: ${f.purpose}. Provides: ${f.provides}${f.uses.length ? `. Uses: ${f.uses.join(", ")}` : ""}`).join("\n")}`;
  logAgentAction(input.runId, "CodePilot", "project_plan", { name: plan.name, files: planned.length, language: plan.language }, "planned");

  // Write in dependency order; files in the same group are written in parallel.
  const files = new Map<string, string>();
  const levels = writeOrder(planned);
  let written = 0;
  for (const level of levels) {
    assertNotAborted(ctx);
    progress(input, `Writing ${level.map((f) => f.path).slice(0, 3).join(", ")}${level.length > 3 ? ` and ${level.length - 3} more` : ""} (${written}/${planned.length} done)…`);
    await Promise.all(
      level.map(async (f) => {
        // Files it uses: in full while they fit a token budget, as outlines after that.
        let room = 18_000;
        const deps = f.uses
          .filter((u) => files.has(u))
          .map((u) => ((room -= files.get(u)!.length) >= 0 ? `~~~~file ${u}\n${files.get(u)}\n~~~~` : outline(u, files.get(u)!)))
          .join("\n\n");
        const reply = await ask(FILE_SYSTEM, `User's request: ${request}\n\n${planText}\n\nFiles it uses (already written):\n${deps || "(none)"}\n\nNow write: ${f.path}\nPurpose: ${f.purpose}\nIt must provide: ${f.provides}`, ctx, f.path.endsWith(".md") ? 1500 : 6000);
        const body = reply ? extractFile(reply, f.path) : null;
        // An empty file is fine when the model meant it (a Python package's __init__.py).
        if (body !== null) files.set(f.path, body.endsWith("\n") || !body ? body : `${body}\n`);
      })
    );
    written += level.length;
  }
  assertNotAborted(ctx);
  const missing = planned.filter((f) => !files.has(f.path)).map((f) => f.path);
  if (files.size === 0) return noModel();

  progress(input, "Checking the project (syntax, imports, tests)…");
  const { report, repairs } = await checkAndRepair(input, ctx, files, `User's request: ${request}\n\n${planText}`, deadline);
  assertNotAborted(ctx);

  const folder = freeFolder(ctx.workspaceRoot, plan.name);
  const projectFiles = [...files].map(([p, content]) => ({ path: p, content }));
  const action: ProposedAction = {
    ...proposedAction(`Create the project "${plan.name}" (${files.size} files) in ${folder}/`, "medium"),
    preview: `New folder: ${folder}/\n\n${treeText(projectFiles)}\n\nChecks: ${describeCheck(report)}`,
  };
  savePatchSet(action.id, `New project ${plan.name}`, projectFiles.map((f) => ({ file: `${folder}/${f.path}`, original: "", fixed: f.content, isNew: true })));
  const security = securityNotes(files);
  logAgentAction(input.runId, "CodePilot", "build_project", { name: plan.name, files: files.size, problems: report.problems.length, testsPassed: report.tests.passed, testsFailed: report.tests.failed, repairs, model: agentModel() }, "completed");

  const preview = plan.language === "web" ? inlineWebPreview(projectFiles) : null;
  const attachments: Attachment[] = [
    { type: "code-project", title: plan.name, folder, files: projectFiles.map((f) => ({ ...f, language: lang(f.path) })), checks: describeCheck(report), run: plan.run, test: plan.test },
    ...(preview ? [{ type: "html-preview" as const, title: plan.name, html: preview }] : []),
  ];
  const good = !report.problems.length && (!report.tests.ran || !report.tests.failed);
  return {
    status: good && !missing.length ? "needs_approval" : "partial_success",
    findings: [
      `**${plan.name}**: ${plan.summary}`,
      `${files.size} files, written in ${levels.length} dependency-ordered step${levels.length === 1 ? "" : "s"}${repairs ? ` and repaired ${repairs} time${repairs === 1 ? "" : "s"} after checking` : ""}:\n~~~text\n${treeText(projectFiles)}\n~~~`,
      `**Checks:** ${describeCheck(report)}`,
      `**Run it:** \`${plan.run}\`${plan.test ? ` · **Test it:** \`${plan.test}\`` : ""}`,
      `Browse every file below${preview ? " and try the live preview" : ""}. Approve to create it in your workspace at \`${folder}/\` (you can undo it).`,
      ...(missing.length ? [`These planned files couldn't be written: ${missing.join(", ")}.`] : []),
      ...(security.length ? [`Security scan flagged: ${security.join("; ")}.`] : []),
    ],
    evidence: [evidence(`ai-model:${agentModel()}`, "Code written by the AI model."), ...(report.tests.ran ? [evidence("project-tests", `${report.tests.passed} passed, ${report.tests.failed} failed`)] : [])],
    confidence: good ? (report.tests.ran ? 0.85 : 0.65) : 0.4,
    limitations: [
      report.tests.ran ? "The tests were written by the same AI, so passing them is strong but not complete evidence." : "The project's tests weren't run automatically; run them yourself after creating it.",
    ],
    proposedActions: [action],
    attachments,
  };
}

/** Changes an existing project across files. */
export async function editProject(input: AgentInput, ctx: AgentContext, project: { folder: string; name: string; files: string[] }, budgetMs = 330_000): Promise<Result> {
  if (!agentLlmEnabled()) return noModel();
  const deadline = Date.now() + budgetMs;
  const root = ctx.workspaceRoot;
  progress(input, `Reading ${project.name}…`);
  // The project's text files (skipping very large ones), most relevant first.
  const index = workspaceIndex(root);
  const relevant = new Set(index.search(input.requestText, 20).map((h) => h.file));
  const paths = project.files.filter((f) => !/(^|\/)(node_modules|dist|build|__pycache__)\//.test(f)).sort((a, b) => Number(relevant.has(b)) - Number(relevant.has(a)));
  const original = new Map<string, string>();
  let total = 0;
  for (const p of paths) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(root, p), "utf8");
    } catch {
      continue;
    }
    if (total + text.length > 90_000) continue;
    original.set(p, text);
    total += text.length;
  }
  const rel = (p: string) => path.posix.relative(project.folder, p);
  // The AI sees an outline of every file (its functions/classes) and the full text only of the
  // files it works on: far fewer tokens, which matters on Groq's free tier.
  const outlineText = [...original].map(([p, c]) => outline(rel(p), c)).join("\n");
  const fullOf = (paths: string[], cap: number) => {
    let used = 0;
    return paths
      .filter((p) => original.has(`${project.folder}/${p}`))
      .map((p) => {
        const c = original.get(`${project.folder}/${p}`)!;
        if (used + c.length > cap) return "";
        used += c.length;
        return `~~~~file ${p}\n${c}\n~~~~`;
      })
      .filter(Boolean)
      .join("\n\n");
  };
  const mostRelevant = [...original.keys()].map(rel).slice(0, 3);

  progress(input, "Planning the change…");
  const plan = await generateJson<{ summary: string; changes: { path: string; action: string; what: string }[] }>(
    "Plan the change to this codebase: which files to modify or create (paths relative to the project folder) and exactly what changes in each. Include tests for new behaviour if the project has tests. Never delete files.",
    `Request: ${input.requestText}\n\nProject ${project.name}, outline of every file:\n${outlineText}\n\nThe most relevant files in full:\n${fullOf(mostRelevant, 14_000)}`,
    { signal: ctx.signal, schema: EDIT_PLAN_SCHEMA, temperature: 0.2, maxTokens: 2500, maxInput: 40_000, effort: "medium", patientMs: 60_000, preferBestMs: 45_000 }
  );
  assertNotAborted(ctx);
  if (!plan?.changes?.length) return noModel();

  // All files, by path relative to the project folder; changes are applied to this copy.
  const files = new Map([...original].map(([p, c]) => [rel(p), c]));
  const failedEdits: string[] = [];
  progress(input, `Changing ${plan.changes.length} file(s)…`);
  const targets = plan.changes.map((c) => ({ ...c, path: safeRel(c.path) ?? "" })).filter((c) => c.path).slice(0, 12);
  // One request per file: that file in full, plus the files it uses (by import) in full if small.
  const planText = `Plan: ${plan.summary}\n${targets.map((c) => `- ${c.action} ${c.path}: ${c.what}`).join("\n")}`;
  const replies = await Promise.all(
    targets.map((c) => {
      const content = files.get(c.path) ?? "";
      const related = [...files.keys()].filter((p) => p !== c.path && (content.includes(path.posix.basename(p, path.posix.extname(p))) || targets.some((t) => t.path === p)));
      return ask(
        EDIT_SYSTEM,
        `Request: ${input.requestText}\n\n${planText}\n\nProject outline:\n${outlineText}\n\nRelated files:\n${fullOf(related, 12_000) || "(none)"}\n\nNow ${c.action === "create" ? "create" : "change"} ONLY this file: ${c.path} -- ${c.what}\n${content ? `~~~~file ${c.path}\n${content}\n~~~~\n${content.split("\n").length > 250 ? "This file is LARGE: reply with edit blocks." : ""}` : "(new file)"}`,
        ctx,
        8000
      );
    })
  );
  for (const b of replies.flatMap((r) => (r ? parseBlocks(r) : []))) {
    const p = safeRel(b.path);
    if (!p) continue;
    if (b.kind === "file") files.set(p, b.body.endsWith("\n") ? b.body : `${b.body}\n`);
    else if (files.has(p)) {
      const r = applyEdits(files.get(p)!, b.body);
      files.set(p, r.text);
      failedEdits.push(...r.failed.map((f) => `${p}: "${f}"`));
    }
  }
  const changedBefore = [...files].filter(([p, c]) => original.get(`${project.folder}/${p}`) !== c);
  if (!changedBefore.length) {
    return { status: "partial_success", findings: [aiUnavailableReason() ?? "The AI didn't produce a usable change for this request. Try describing the change more specifically (which feature, where)."], evidence: [], confidence: 0.2, limitations: [], proposedActions: [] };
  }

  progress(input, "Checking the changed project…");
  const { report, repairs } = await checkAndRepair(input, ctx, files, `Request: ${input.requestText}\nPlan: ${plan.summary}`, deadline);
  assertNotAborted(ctx);

  const changed = [...files].filter(([p, c]) => original.get(`${project.folder}/${p}`) !== c).map(([p, c]) => {
    const full = `${project.folder}/${p}`;
    const before = original.get(full);
    // Files outside what was read (too large) are never rewritten blind.
    const exists = fs.existsSync(path.join(root, full));
    return { file: full, original: before ?? "", fixed: c, isNew: before === undefined && !exists, skip: before === undefined && exists };
  }).filter((c) => !c.skip);
  const diff = changed.map((c) => (c.isNew ? `+++ new file ${c.file} (${c.fixed.split("\n").length} lines)` : unifiedDiff(c.file, c.original, c.fixed))).join("\n\n");
  const action: ProposedAction = { ...proposedAction(`Apply the change to ${project.name}: ${plan.summary.slice(0, 120)} (${changed.length} file${changed.length === 1 ? "" : "s"})`, "medium"), preview: diff.slice(0, 12_000) };
  savePatchSet(action.id, plan.summary, changed.map(({ file, original: o, fixed, isNew }) => ({ file, original: o, fixed, isNew })));
  logAgentAction(input.runId, "CodePilot", "edit_project", { project: project.folder, files: changed.length, problems: report.problems.length, testsPassed: report.tests.passed, testsFailed: report.tests.failed, repairs }, "completed");
  const good = !report.problems.length && (!report.tests.ran || !report.tests.failed);
  return {
    status: good ? "needs_approval" : "partial_success",
    findings: [
      `**Change to ${project.name}:** ${plan.summary}`,
      `Files: ${changed.map((c) => `\`${c.file}\`${c.isNew ? " (new)" : ""}`).join(", ")}${repairs ? `. Repaired ${repairs} time${repairs === 1 ? "" : "s"} after checking.` : "."}`,
      `**Checks on the whole project with the change:** ${describeCheck(report)}`,
      "Review the diff below; approving applies every file together (all or nothing), and you can undo it.",
      ...(failedEdits.length ? [`Some edits didn't match the files exactly and were skipped: ${failedEdits.slice(0, 4).join("; ")}.`] : []),
    ],
    evidence: [evidence(`ai-model:${agentModel()}`, "Change written by the AI model.")],
    confidence: good ? 0.75 : 0.4,
    limitations: total >= 90_000 ? ["The project is large; only the most relevant files were read."] : [],
    proposedActions: [action],
  };
}
