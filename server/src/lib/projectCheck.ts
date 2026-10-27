import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { countTests, e2bEnabled, installCommands, runInSandbox, testCommands } from "./e2b.js";

// Checks a whole multi-file project before CodePilot offers it, the way a careful developer would:
//   1. Every file parses (Python via ast, JavaScript via `node --check`, TypeScript via the
//      TypeScript parser when available, JSON, and local links in HTML).
//   2. Files fit together: every local import points to a file in the project, and every name
//      imported from it is really defined there.
//   3. The project's own tests run (Python unittest, Node's built-in test runner), in a throwaway
//      folder with an empty environment and a time limit -- but only if no file reaches for the
//      network, other processes or deleting files. Like the snippet sandbox, this is a guard rail,
//      not a security boundary.
// Third-party packages aren't installed, so tests that need them are skipped (and that's said).

export interface ProjectFile {
  path: string;
  content: string;
}

export interface CheckProblem {
  file: string;
  line?: number;
  message: string;
}

export interface CheckReport {
  problems: CheckProblem[];
  warnings: string[];
  tests: { ran: boolean; passed: number; failed: number; output: string; why?: string; /** Where they ran: here (sandboxed) or in an E2B cloud sandbox. */ via?: "local" | "e2b" };
}

const ext = (p: string) => path.extname(p).toLowerCase();
const isPy = (p: string) => ext(p) === ".py";
const isJs = (p: string) => [".js", ".mjs", ".cjs", ".jsx"].includes(ext(p));
const isTs = (p: string) => [".ts", ".tsx", ".mts"].includes(ext(p));

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ ok: boolean; out: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd, TMPDIR: cwd, ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}) } }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: `${stdout}${stderr}`.trim(), timedOut: Boolean(err && (err as any).killed) })
    );
  });
}

const python = () => process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");

// Parses every Python file and reports syntax errors, imports and top-level names (one interpreter run).
const PY_INSPECT = String.raw`
import ast, json, sys
out = {}
for path in sys.argv[1:]:
    src = open(path, encoding="utf-8").read()
    try:
        tree = ast.parse(src, path)
    except SyntaxError as e:
        out[path] = {"error": {"line": e.lineno or 0, "msg": e.msg}}
        continue
    imports, names = [], set()
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(node.name)
        elif isinstance(node, ast.Assign):
            for t in node.targets:
                for n in ast.walk(t):
                    if isinstance(n, ast.Name): names.add(n.id)
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            names.add(node.target.id)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            for a in node.names: names.add((a.asname or a.name).split(".")[0])
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names: imports.append({"module": a.name, "names": [], "level": 0, "line": node.lineno})
        elif isinstance(node, ast.ImportFrom):
            imports.append({"module": node.module or "", "names": [a.name for a in node.names], "level": node.level, "line": node.lineno})
    out[path] = {"imports": imports, "names": sorted(names)}
# sys.stdlib_module_names is Python 3.10+; older versions (e.g. macOS's system 3.9) lack it, so
# fall back to the C builtins plus whatever lives in the standard library directory. Without this
# every import looks third-party, and the project's tests are wrongly skipped as "needs packages".
stdlib = getattr(sys, "stdlib_module_names", None)
if not stdlib:
    import os.path, pkgutil
    stdlib = set(sys.builtin_module_names) | {m.name for m in pkgutil.iter_modules([os.path.dirname(os.__file__)])}
print(json.dumps({"files": out, "stdlib": sorted(stdlib)}))
`;

const PY_DENY = /\bimport\s+(subprocess|socket|ctypes|multiprocessing|requests|urllib3?|httpx|ftplib|smtplib|telnetlib|shutil)\b|\bfrom\s+(subprocess|socket|ctypes|multiprocessing|requests|urllib3?|http|httpx|ftplib|smtplib|shutil)\b|\bos\.(system|popen|exec\w*|spawn\w*|remove|unlink|rmdir|removedirs|kill|fork)\b|\b(eval|exec|__import__)\s*\(/;
const JS_DENY = /\b(child_process|worker_threads|node:net|node:dgram|node:https?|node:tls|node:cluster)\b|["'](net|dgram|https?|tls|cluster)["']|\bfetch\s*\(|\bprocess\.(kill|exit)\b|\b(rmSync|rm|unlink|unlinkSync|rmdir|rmdirSync)\s*\(|\beval\s*\(|\bnew\s+Function\b|\bXMLHttpRequest\b|\bWebSocket\b/;

/** Why the project's tests won't be run, or null if they may. */
export function testRunRefusal(files: ProjectFile[]): string | null {
  for (const f of files) {
    const m = (isPy(f.path) ? PY_DENY : isJs(f.path) || isTs(f.path) ? JS_DENY : null)?.exec(f.content);
    if (m) return `${f.path} uses \`${m[0].trim()}\` (network, processes or deleting files), so its tests weren't run automatically`;
  }
  return null;
}

/** Where a JS import specifier points inside the project, or null. */
function resolveJs(from: string, spec: string, paths: Set<string>): string | null {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  const candidates = [base, ...[".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx"].map((e) => base + e), ...["index.js", "index.ts", "index.jsx", "index.tsx"].map((i) => `${base}/${i}`)];
  // TypeScript code imports "./x.js" for a file named x.ts.
  if (/\.js$/.test(base)) candidates.push(base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx"));
  return candidates.find((c) => paths.has(c)) ?? null;
}

/** Names a JS/TS module exports (best effort, by pattern). */
function jsExports(src: string): Set<string> | null {
  const names = new Set<string>();
  for (const m of src.matchAll(/\bexport\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/\bexport\s*\{([^}]*)\}/g)) for (const part of m[1].split(",")) {
    const n = part.trim().split(/\s+as\s+/).pop()?.trim();
    if (n) names.add(n);
  }
  for (const m of src.matchAll(/\bexports\.([A-Za-z_$][\w$]*)\s*=/g)) names.add(m[1]);
  const cjs = /\bmodule\.exports\s*=\s*\{([^}]*)\}/.exec(src);
  if (cjs) for (const part of cjs[1].split(",")) {
    const n = part.trim().split(/\s*:\s*/)[0].trim();
    if (/^[A-Za-z_$][\w$]*$/.test(n)) names.add(n);
  }
  // module.exports = something else (a function, a class): any destructured name might be fine.
  if (/\bmodule\.exports\s*=\s*(?!\{)/.test(src) || /\bexport\s+\*\s+from\b/.test(src)) return null;
  return names;
}

const BUILTIN_JS = new Set(["assert", "buffer", "crypto", "events", "fs", "path", "os", "readline", "stream", "string_decoder", "test", "timers", "url", "util", "zlib", "process", "perf_hooks", "querystring", "child_process", "http", "https", "net", "dgram", "worker_threads", "cluster", "tls", "module", "vm"]);

async function typescriptParser(): Promise<any | null> {
  try {
    return (await import("typescript")).default;
  } catch {
    return null;
  }
}

/** Runs the checks on a set of files. */
export async function checkProject(files: ProjectFile[], opts: { runTests?: boolean; timeoutMs?: number; /** Allow E2B for tests that can't run locally (default true). */ cloud?: boolean } = {}): Promise<CheckReport> {
  const problems: CheckProblem[] = [];
  const warnings: string[] = [];
  const paths = new Set(files.map((f) => f.path));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omnipilot-project-"));
  try {
    for (const f of files) {
      const full = path.join(dir, f.path);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, f.content, "utf8");
    }

    // --- Python: syntax, local imports and names ---
    const py = files.filter((f) => isPy(f.path));
    let pyThirdParty = false;
    if (py.length) {
      const r = await run(python(), ["-I", "-c", PY_INSPECT, ...py.map((f) => f.path)], dir, 20_000);
      let info: { files: Record<string, any>; stdlib: string[] } | null = null;
      try {
        info = JSON.parse(r.out.split("\n").pop() ?? "");
      } catch {
        warnings.push("Python isn't available here, so the Python files weren't checked.");
      }
      if (info) {
        const stdlib = new Set(info.stdlib);
        const modulePath = (mod: string, from: string, level: number) => {
          const baseParts = level ? path.posix.dirname(from).split("/").filter((p) => p && p !== ".").slice(0, Math.max(0, path.posix.dirname(from).split("/").filter((p) => p && p !== ".").length - (level - 1))) : [];
          const parts = [...baseParts, ...mod.split(".").filter(Boolean)];
          const stem = parts.join("/");
          // Absolute imports may be relative to the project root or to the importing file's folder (scripts run from there).
          const roots = level ? [""] : ["", path.posix.dirname(from) === "." ? "" : path.posix.dirname(from) + "/"];
          for (const root of roots) for (const c of [`${root}${stem}.py`, `${root}${stem}/__init__.py`]) if (paths.has(c.replace(/^\//, ""))) return c.replace(/^\//, "");
          return stem && roots.some((root) => files.some((f) => f.path.startsWith(`${root}${stem}/`))) ? "<package>" : null;
        };
        for (const f of py) {
          const fi = info.files[f.path];
          if (!fi) continue;
          if (fi.error) {
            problems.push({ file: f.path, line: fi.error.line, message: `Syntax error: ${fi.error.msg}` });
            continue;
          }
          for (const imp of fi.imports as { module: string; names: string[]; level: number; line: number }[]) {
            const top = imp.module.split(".")[0];
            const local = modulePath(imp.module, f.path, imp.level);
            if (!local) {
              if (imp.level > 0) problems.push({ file: f.path, line: imp.line, message: `Imports "${".".repeat(imp.level)}${imp.module}", which isn't a file in the project.` });
              else if (top && !stdlib.has(top)) pyThirdParty = true;
              // "from package import module": each name may itself be a module file.
              continue;
            }
            if (local === "<package>") continue;
            const target = info.files[local];
            if (!target || target.error) continue;
            for (const n of imp.names) {
              if (n === "*" || target.names.includes(n) || modulePath(`${imp.module}.${n}`, f.path, imp.level)) continue;
              problems.push({ file: f.path, line: imp.line, message: `Imports ${n} from ${local}, but ${local} doesn't define ${n}.` });
            }
          }
        }
      }
    }

    // --- JavaScript / TypeScript: syntax and local imports ---
    const ts = files.some((f) => isTs(f.path)) ? await typescriptParser() : null;
    if (files.some((f) => isTs(f.path)) && !ts) warnings.push("TypeScript files were checked for imports only (the TypeScript parser isn't installed here).");
    let jsBare = false;
    for (const f of files.filter((x) => isJs(x.path) || isTs(x.path))) {
      if (ext(f.path) === ".jsx" || isTs(f.path)) {
        if (ts) {
          const out = ts.transpileModule(f.content, { fileName: f.path, reportDiagnostics: true, compilerOptions: { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ES2022 } });
          for (const d of out.diagnostics ?? []) {
            const line = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : undefined;
            problems.push({ file: f.path, line, message: `Syntax error: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}` });
          }
        }
      } else {
        const r = await run(process.execPath, ["--check", f.path], dir, 10_000);
        if (!r.ok) {
          const line = Number(/:(\d+)\n/.exec(r.out)?.[1]) || undefined;
          problems.push({ file: f.path, line, message: `Syntax error: ${r.out.split("\n").find((l) => /Error/.test(l))?.trim() ?? r.out.slice(0, 200)}` });
        }
      }
      const specs = [...f.content.matchAll(/\bimport\s+(?:type\s+)?(?:([\w$*{}\s,]+?)\s+from\s+)?["']([^"']+)["']|\brequire\(\s*["']([^"']+)["']\s*\)|\bimport\(\s*["']([^"']+)["']\s*\)/g)];
      for (const m of specs) {
        const spec = m[2] ?? m[3] ?? m[4];
        const line = f.content.slice(0, m.index).split("\n").length;
        if (!spec.startsWith(".") && !spec.startsWith("/")) {
          const name = spec.replace(/^node:/, "").split("/")[0];
          if (!spec.startsWith("node:") && !BUILTIN_JS.has(name)) jsBare = true;
          continue;
        }
        const target = resolveJs(f.path, spec, paths);
        if (!target) {
          problems.push({ file: f.path, line, message: `Imports "${spec}", which isn't a file in the project.` });
          continue;
        }
        const named = /\{([^}]*)\}/.exec(m[1] ?? "")?.[1];
        const exported = named ? jsExports(files.find((x) => x.path === target)!.content) : null;
        if (named && exported) {
          for (const part of named.split(",")) {
            const n = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
            if (n && !exported.has(n)) problems.push({ file: f.path, line, message: `Imports ${n} from ${target}, but ${target} doesn't export it.` });
          }
        }
      }
    }

    // --- JSON and HTML ---
    for (const f of files) {
      if (ext(f.path) === ".json") {
        try {
          JSON.parse(f.content);
        } catch (e: any) {
          problems.push({ file: f.path, message: `Invalid JSON: ${e.message}` });
        }
      }
      if (ext(f.path) === ".html") {
        for (const m of f.content.matchAll(/<(?:script|img)[^>]+src=["']([^"']+)["']|<link[^>]+href=["']([^"']+)["']/gi)) {
          const ref = (m[1] ?? m[2]).split(/[?#]/)[0];
          if (/^(https?:|data:|\/\/|#|mailto:)/.test(ref) || !ref) continue;
          const target = path.posix.normalize(path.posix.join(path.posix.dirname(f.path), ref)).replace(/^\//, "");
          if (!paths.has(target)) problems.push({ file: f.path, message: `Links to "${ref}", which isn't a file in the project.` });
        }
      }
    }

    // --- Tests ---
    let tests: CheckReport["tests"] = { ran: false, passed: 0, failed: 0, output: "" };
    const pyTests = py.filter((f) => /(^|\/)test_[^/]*\.py$|_test\.py$/.test(f.path));
    const jsTests = files.filter((f) => /\.test\.(m?js|cjs)$|(^|\/)tests?\/[^/]+\.(m?js|cjs)$/.test(f.path));
    if (opts.runTests !== false && (pyTests.length || jsTests.length)) {
      const refusal = testRunRefusal(files);
      const needsCloud = refusal ? refusal : pyTests.length && pyThirdParty ? "the Python code uses packages that aren't installed here" : jsTests.length && jsBare ? "the JavaScript code uses npm packages that aren't installed here" : null;
      if (problems.length) tests.why = "the files still have the problems listed above";
      else if (needsCloud && e2bEnabled() && opts.cloud !== false) {
        // What the local guard rails won't run (packages, network, deleting files) runs in a
        // throwaway E2B cloud machine instead.
        try {
          const runs = await runInSandbox({ files, commands: [...installCommands(files), ...testCommands(files)], commandTimeoutMs: opts.timeoutMs ?? 180_000, stopOnFailure: false, why: "project tests" });
          const testRuns = runs.slice(installCommands(files).length);
          const output = runs.map((r) => `$ ${r.command}\n${r.stdout}${r.stderr}`).join("\n").trim();
          const counts = testRuns.map((r) => countTests(`${r.stdout}\n${r.stderr}`));
          const passed = counts.reduce((n, c) => n + c.passed, 0);
          let failed = counts.reduce((n, c) => n + c.failed, 0);
          if (testRuns.some((r) => r.exitCode !== 0) && failed === 0) failed = 1;
          if (runs.slice(0, installCommands(files).length).some((r) => r.exitCode !== 0)) problems.push({ file: "(install)", message: "Installing the project's packages failed in the cloud sandbox." });
          tests = { ran: testRuns.length > 0, passed, failed, output: output.split("\n").slice(-60).join("\n").slice(0, 6000), via: "e2b" };
        } catch (e: any) {
          tests.why = `${needsCloud}, and the E2B cloud sandbox couldn't run them (${String(e?.message ?? e).slice(0, 120)})`;
        }
      } else if (needsCloud) tests.why = `${needsCloud}${e2bEnabled() ? "" : " (with an E2B key, OmniPilot runs these in a cloud sandbox)"}`;
      else {
        const timeout = opts.timeoutMs ?? 30_000;
        let output = "";
        let passed = 0;
        let failed = 0;
        if (pyTests.length) {
          // Run from the project root (so `from todo.core import ...` works) with a clean environment.
          const dirs = [...new Set(pyTests.map((t) => path.posix.dirname(t.path)))];
          for (const d of dirs) {
            const r = await run(python(), ["-E", "-s", "-m", "unittest", "discover", "-s", d, "-p", "*test*.py", "-v"], dir, timeout);
            output += r.timedOut ? `Python tests timed out after ${timeout / 1000}s.\n` : r.out + "\n";
            passed += (r.out.match(/\.\.\. ok$/gm) ?? []).length;
            failed += (r.out.match(/\.\.\. (FAIL|ERROR)$/gm) ?? []).length + (/^(ERROR|FAIL):/m.test(r.out) && !/\.\.\. (FAIL|ERROR)$/m.test(r.out) ? 1 : 0) + (r.timedOut ? 1 : 0);
            if (!r.ok && passed + failed === 0) failed = 1;
          }
        }
        if (jsTests.length) {
          // Force the TAP reporter: Node's default is the "spec" reporter in some versions/environments,
          // which has no `# pass`/`# fail` summary lines for us to count.
          const r = await run(process.execPath, ["--test", "--test-reporter=tap", ...jsTests.map((t) => t.path)], dir, timeout);
          output += r.timedOut ? `JavaScript tests timed out after ${timeout / 1000}s.\n` : r.out + "\n";
          passed += Number(/^# pass (\d+)/m.exec(r.out)?.[1] ?? 0);
          failed += Number(/^# fail (\d+)/m.exec(r.out)?.[1] ?? 0) + (r.timedOut ? 1 : 0);
          if (!r.ok && !/^# fail/m.test(r.out)) failed = Math.max(failed, 1);
        }
        tests = { ran: true, passed, failed, output: output.trim().split("\n").slice(-60).join("\n").slice(0, 6000), via: "local" };
      }
    } else if (!pyTests.length && !jsTests.length) tests.why = "the project has no automated tests";
    return { problems, warnings, tests };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Plain-words summary of a check, for the answer. */
export function describeCheck(r: CheckReport): string {
  const parts = [r.problems.length ? `⚠️ ${r.problems.length} problem${r.problems.length === 1 ? "" : "s"} left: ${r.problems.slice(0, 5).map((p) => `${p.file}${p.line ? `:${p.line}` : ""} ${p.message}`).join("; ")}` : "✅ Every file parses and all local imports match."];
  const where = r.tests.via === "e2b" ? "in an E2B cloud sandbox" : "in a sandbox";
  if (r.tests.ran) parts.push(r.tests.failed ? `❌ Tests: ${r.tests.passed} passed, ${r.tests.failed} failed (${where}).` : `✅ Tests: all ${r.tests.passed} passed (run ${where}).`);
  else if (r.tests.why) parts.push(`Tests not run: ${r.tests.why}.`);
  return [...parts, ...r.warnings].join(" ");
}
