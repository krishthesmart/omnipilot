import fs from "node:fs";
import path from "node:path";
import type { AgentInput } from "../types.js";
import type { AgentContext, AgentFn } from "./base.js";
import { evidence, logAgentAction } from "./base.js";
import { namedCodeProject } from "../lib/fileIndex.js";
import { checkProject, describeCheck, type ProjectFile } from "../lib/projectCheck.js";
import { e2bEnabled, runInSandbox } from "../lib/e2b.js";

type Result = Awaited<ReturnType<AgentFn>>;

// CodePilot running things, from chat or from a routine ("every day at 6pm, run the tests in my
// snake game project"):
//   - "run the tests in my <project>": checked and tested here when it's safe, or in an E2B cloud
//     sandbox when the tests need packages, the network or files deleted;
//   - "run `python main.py` in my <project>" / "run `ls -la`": any shell command, but ONLY in an
//     E2B cloud sandbox (with the project's files) -- never on your computer.

export const RUN_INTENT = /\b(run|execute|launch)\b[^.?!]*(`[^`]+`|\b(tests?|test suite|command|script|npm|pip|pytest|python3?|node|main\.py|make)\b)/i;
const TESTS = /\btests?\b|test suite|pytest/i;

/** A workspace project's files (text files under 200 kB, at most 300). */
export function projectFiles(root: string, folder: string): ProjectFile[] {
  const out: ProjectFile[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".") || ["node_modules", "dist", "build", "__pycache__", ".venv", "venv"].includes(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && fs.statSync(full).size < 200_000 && out.length < 300) {
        const content = fs.readFileSync(full, "utf8");
        if (!content.includes("\u0000")) out.push({ path: path.relative(path.join(root, folder), full).split(path.sep).join("/"), content });
      }
    }
  };
  walk(path.join(root, folder));
  return out;
}

const fence = (s: string) => `~~~text\n${s.trim() || "(no output)"}\n~~~`;

export async function runCommandSkill(input: AgentInput, ctx: AgentContext): Promise<Result | null> {
  // The whole request as typed: commands are taken from it exactly (never from a reworded part).
  const typed = typeof input.context.originalRequest === "string" ? input.context.originalRequest : "";
  const text = typed && /`[^`]+`/.test(typed) ? typed : input.requestText;
  if (!RUN_INTENT.test(text)) return null;
  const project = namedCodeProject(ctx.workspaceRoot, text);
  const command = /`([^`]+)`/.exec(text)?.[1]?.trim();
  const files = project ? projectFiles(ctx.workspaceRoot, project.folder) : [];

  // The project's tests.
  if (!command && TESTS.test(text)) {
    if (!project) return null; // not about a workspace project: CodePilot's usual paths handle it
    const report = await checkProject(files);
    logAgentAction(input.runId, "CodePilot", "run_tests", { project: project.folder, via: report.tests.via ?? "none", passed: report.tests.passed, failed: report.tests.failed }, report.tests.ran ? "ran" : "not run");
    return {
      status: report.tests.ran && !report.tests.failed && !report.problems.length ? "success" : "partial_success",
      findings: [`**Tests for ${project.name}** (\`${project.folder}/\`): ${describeCheck(report)}`, ...(report.tests.ran ? [fence(report.tests.output.split("\n").slice(-30).join("\n"))] : [])],
      evidence: [evidence(report.tests.via === "e2b" ? "e2b-sandbox" : "local-sandbox", `${report.tests.passed} passed, ${report.tests.failed} failed`)],
      confidence: report.tests.ran ? 0.9 : 0.5,
      limitations: [],
      proposedActions: [],
    };
  }

  // Any other command: only in a cloud sandbox.
  if (!command) return null;
  if (!e2bEnabled()) {
    return {
      status: "partial_success",
      findings: [
        `I don't run shell commands on your computer (for safety). With an E2B key, I run them in a throwaway cloud machine${project ? ` with your ${project.name} files` : ""}: add E2B_API_KEY to server/.env (free account at e2b.dev) and ask again.`,
      ],
      evidence: [],
      confidence: 0.9,
      limitations: [],
      proposedActions: [],
    };
  }
  const runs = await runInSandbox({ files, commands: [command], commandTimeoutMs: 180_000, runId: input.runId, why: text.slice(0, 120) });
  const r = runs[0];
  logAgentAction(input.runId, "CodePilot", "run_command", { command, project: project?.folder ?? null, exitCode: r.exitCode }, `exit ${r.exitCode}`);
  return {
    status: r.exitCode === 0 ? "success" : "partial_success",
    findings: [
      `Ran \`${command}\` in an E2B cloud sandbox${project ? ` with the files of **${project.name}**` : ""} (${(r.ms / 1000).toFixed(1)} s, exit code ${r.exitCode}${r.timedOut ? ", timed out" : ""}):`,
      fence(`${r.stdout}${r.stderr ? `\n${r.stderr}` : ""}`.split("\n").slice(-60).join("\n")),
      "The sandbox was thrown away afterwards: nothing it did affects your computer or your workspace files.",
    ],
    evidence: [evidence("e2b-sandbox", `exit ${r.exitCode}`)],
    confidence: 0.9,
    limitations: [],
    proposedActions: [],
  };
}
