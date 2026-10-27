import { logAudit } from "./audit.js";
import type { ProjectFile } from "./projectCheck.js";

// Running commands in an E2B cloud sandbox (https://e2b.dev): a fresh, isolated Linux machine in
// the cloud for each job, thrown away afterwards. This is how OmniPilot runs things its local
// guard rails won't: installing packages, tests that need the network, any shell command a routine
// or a request asks for. Commands never run on your own computer.
//   - Only the project's files (or none) are uploaded; nothing else from your computer.
//   - Every command has a time limit, the whole sandbox has a lifetime limit, and it's always shut
//     down when the job ends.
//   - E2B_API_KEY stays on the server; E2B=off turns this off.

export const e2bEnabled = () => Boolean(process.env.E2B_API_KEY?.trim()) && process.env.E2B !== "off";

export interface CommandRun {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  ms: number;
  timedOut?: boolean;
}

const tail = (s: string, n = 6000) => (s.length > n ? `…${s.slice(-n)}` : s);
export const PROJECT_DIR = "/home/user/project";

/** Tests replace the SDK with a fake. */
let sdkOverride: { Sandbox: any } | null = null;
export const setE2bSdk = (sdk: { Sandbox: any } | null) => (sdkOverride = sdk);

async function sdk(): Promise<{ Sandbox: any }> {
  if (sdkOverride) return sdkOverride;
  return (await import("e2b")) as any;
}

/**
 * Uploads `files` to /home/user/project and runs `commands` there one after another (stopping at
 * the first that fails when `stopOnFailure`). Returns each command's output.
 */
export async function runInSandbox(opts: {
  files?: ProjectFile[];
  commands: string[];
  commandTimeoutMs?: number;
  stopOnFailure?: boolean;
  runId?: string;
  why?: string;
}): Promise<CommandRun[]> {
  if (!e2bEnabled()) throw new Error("E2B isn't set up: add E2B_API_KEY to server/.env (free account at e2b.dev).");
  const { Sandbox } = await sdk();
  const lifetimeMs = Math.min(15 * 60_000, (opts.commandTimeoutMs ?? 120_000) * opts.commands.length + 60_000);
  const sandbox = await Sandbox.create({ apiKey: process.env.E2B_API_KEY!.trim(), timeoutMs: lifetimeMs });
  const runs: CommandRun[] = [];
  try {
    if (opts.files?.length) await sandbox.files.write(opts.files.map((f) => ({ path: `${PROJECT_DIR}/${f.path}`, data: f.content })));
    else await sandbox.commands.run(`mkdir -p ${PROJECT_DIR}`);
    for (const command of opts.commands) {
      const t0 = Date.now();
      let run: CommandRun;
      try {
        const r = await sandbox.commands.run(command, { cwd: PROJECT_DIR, timeoutMs: opts.commandTimeoutMs ?? 120_000 });
        run = { command, exitCode: r.exitCode ?? 0, stdout: tail(r.stdout ?? ""), stderr: tail(r.stderr ?? ""), ms: Date.now() - t0 };
      } catch (e: any) {
        // A non-zero exit comes back as an error that still carries the output.
        const timedOut = /timeout|deadline/i.test(String(e?.name ?? "") + String(e?.message ?? ""));
        run = { command, exitCode: typeof e?.exitCode === "number" ? e.exitCode : 1, stdout: tail(e?.stdout ?? ""), stderr: tail(e?.stderr ?? String(e?.message ?? e)), ms: Date.now() - t0, timedOut };
      }
      runs.push(run);
      logAudit({ runId: opts.runId ?? "n/a", agent: "CodePilot", action: "e2b_command", parameters: { command, why: opts.why ?? "" }, outcome: run.timedOut ? "timed out" : `exit ${run.exitCode} in ${Math.round(run.ms / 100) / 10}s` });
      if (run.exitCode !== 0 && opts.stopOnFailure) break;
    }
  } finally {
    await sandbox.kill().catch(() => {}); // E2B also ends it when its lifetime runs out
  }
  return runs;
}

/** How to install a project's dependencies, from its files (requirements.txt, package.json). */
export function installCommands(files: ProjectFile[]): string[] {
  const out: string[] = [];
  if (files.some((f) => f.path === "requirements.txt")) out.push("pip install --quiet -r requirements.txt");
  if (files.some((f) => f.path === "pyproject.toml") && !files.some((f) => f.path === "requirements.txt")) out.push("pip install --quiet .");
  const pkg = files.find((f) => f.path === "package.json");
  if (pkg) {
    try {
      const p = JSON.parse(pkg.content);
      if (Object.keys({ ...(p.dependencies ?? {}), ...(p.devDependencies ?? {}) }).length) out.push("npm install --silent --no-audit --no-fund");
    } catch {
      // invalid package.json: the checks report it
    }
  }
  return out;
}

/** The project's test command(s): its own (package.json "test"), or the standard runners. */
export function testCommands(files: ProjectFile[]): string[] {
  const out: string[] = [];
  const pkg = files.find((f) => f.path === "package.json");
  let npmTest = false;
  if (pkg) {
    try {
      const t = JSON.parse(pkg.content)?.scripts?.test;
      npmTest = typeof t === "string" && !/no test specified/.test(t);
    } catch {
      // ignore
    }
  }
  if (npmTest) out.push("npm test");
  else if (files.some((f) => /\.test\.(m?js|cjs)$|(^|\/)tests?\/[^/]+\.(m?js|cjs)$/.test(f.path))) out.push("node --test");
  const pyTests = files.filter((f) => /(^|\/)test_[^/]*\.py$|_test\.py$/.test(f.path));
  if (pyTests.length) {
    if (files.some((f) => /pytest/.test(f.content)) || files.some((f) => /^requirements.*\.txt$/.test(f.path) && /pytest/.test(f.content))) out.push("python -m pytest -q");
    else for (const d of [...new Set(pyTests.map((t) => t.path.split("/").slice(0, -1).join("/") || "."))]) out.push(`python -m unittest discover -s ${d} -p "*test*.py" -v`);
  }
  return out;
}

/** Pass/fail counts from test output (unittest, pytest, node --test). */
export function countTests(output: string): { passed: number; failed: number } {
  const node = /^# pass (\d+)[\s\S]*?^# fail (\d+)/m.exec(output);
  if (node) return { passed: Number(node[1]), failed: Number(node[2]) };
  const pytest = /(\d+) passed/.exec(output);
  const pytestFail = /(\d+) (failed|error)/.exec(output);
  if (pytest || pytestFail) return { passed: Number(pytest?.[1] ?? 0), failed: Number(pytestFail?.[1] ?? 0) };
  return { passed: (output.match(/\.\.\. ok$/gm) ?? []).length, failed: (output.match(/\.\.\. (FAIL|ERROR)$/gm) ?? []).length };
}
