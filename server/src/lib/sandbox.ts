import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Runs small, model-generated snippets so CodePilot can check its own code
// before showing it. This is a guard rail, not a security boundary: code that
// could touch files, the network, processes or the environment is refused
// statically, and what does run gets a throwaway directory, an empty
// environment, and a hard timeout. CODE_VERIFY=off disables execution.

export type SandboxLanguage = "python" | "javascript";

export interface SandboxResult {
  ok: boolean;
  output: string;
}

const DENY: Record<SandboxLanguage, RegExp> = {
  python:
    /\b(import|from)\s+(os|sys|subprocess|socket|shutil|pathlib|requests|urllib|http|ctypes|multiprocessing|threading|signal|pickle|importlib|builtins|asyncio)\b|\b(open|eval|exec|compile|__import__|input|globals|getattr|setattr|breakpoint)\s*\(/,
  javascript: /\b(require|import)\b|\bprocess\b|\bglobalThis\b|\bchild_process\b|\b(eval|Function|fetch|setInterval|XMLHttpRequest|WebSocket)\s*\(/,
};

export const sandboxEnabled = () => process.env.CODE_VERIFY !== "off";

/** Which runtime a fenced block can run in; null for languages the sandbox doesn't support (e.g. TypeScript, Go). */
export function sandboxLanguage(fenceTag: string, request: string): SandboxLanguage | null {
  const tag = fenceTag.toLowerCase();
  if (["py", "python", "python3"].includes(tag)) return "python";
  if (["js", "javascript", "node"].includes(tag)) return "javascript";
  if (tag) return null;
  return /\b(javascript|node\.?js)\b/i.test(request) ? "javascript" : "python";
}

/** Why a snippet won't be executed, or null if it may run. */
export function refusalReason(language: SandboxLanguage, code: string): string | null {
  const m = code.match(DENY[language]);
  return m ? `uses \`${m[0].trim()}\` (file, network, process or input access)` : null;
}

/** Wraps each boolean test expression on its own, so one wrong test can't hide the others' results. */
export function withTests(language: SandboxLanguage, code: string, tests: string[]): string {
  // The code's own "main program" (unittest.main(), a demo, input prompts) would run first and can
  // exit before the checks below; it's switched off in this test copy only.
  if (language === "python") {
    code = code.replace(/^if\s+__name__\s*==\s*["']__main__["']\s*:/gm, "if False:  # (main block skipped while testing)");
    const checks = tests
      .map(
        (t) =>
          `try:\n    assert (${t})\n    print("TEST PASS")\nexcept Exception as _e:\n    print("TEST FAIL", ${JSON.stringify(t)}, "->", type(_e).__name__, _e)`
      )
      .join("\n");
    return `${code}\n\n${checks}\n`;
  }
  const body = code.replace(/^\s*export\s+(default\s+)?/gm, "").replace(/\brequire\.main\s*===?\s*module\b/g, "false");
  const checks = tests
    .map(
      (t) =>
        `try { if (!(${t})) throw new Error("returned false"); console.log("TEST PASS"); } catch (e) { console.log("TEST FAIL", ${JSON.stringify(t)}, "->", e && e.message); }`
    )
    .join("\n");
  return `${body}\n\n${checks}\n`;
}

export interface TestReport {
  /** The code itself ran (no syntax error / crash outside the tests). */
  ran: boolean;
  passed: number;
  total: number;
  failures: string[];
  output: string;
}

export async function runTests(language: SandboxLanguage, code: string, tests: string[]): Promise<TestReport> {
  const run = await runSandboxed(language, withTests(language, code, tests));
  const lines = run.output.split("\n");
  const passed = lines.filter((l) => l.startsWith("TEST PASS")).length;
  const failures = lines.filter((l) => l.startsWith("TEST FAIL")).map((l) => l.replace(/^TEST FAIL\s*/, ""));
  const ran = run.ok && passed + failures.length === tests.length;
  return { ran, passed: ran ? passed : 0, total: tests.length, failures: ran ? failures : [], output: run.output };
}

/** Only what's needed to start the interpreter: no tokens, keys or other environment variables reach the code. */
function sandboxEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
  if (process.platform === "win32") env.SystemRoot = process.env.SystemRoot; // Python on Windows needs it to start
  return env;
}

export async function runSandboxed(language: SandboxLanguage, source: string, timeoutMs = 5000): Promise<SandboxResult> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omnipilot-run-"));
  const file = path.join(dir, language === "python" ? "main.py" : "main.js");
  try {
    await fs.writeFile(file, source, "utf8");
    const python = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
    const [cmd, args] = language === "python" ? [python, ["-I", file]] : [process.execPath, [file]];
    return await new Promise<SandboxResult>((resolve) => {
      execFile(
        cmd,
        args,
        { cwd: dir, timeout: timeoutMs, maxBuffer: 64 * 1024, env: sandboxEnv() },
        (err, stdout, stderr) => {
          const out = `${stdout}${stderr}`.trim();
          if (err && (err as any).killed) resolve({ ok: false, output: `Timed out after ${timeoutMs / 1000}s (infinite loop or very slow code?)` });
          else resolve({ ok: !err, output: out.split("\n").slice(-40).join("\n").slice(0, 4000) });
        }
      );
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
