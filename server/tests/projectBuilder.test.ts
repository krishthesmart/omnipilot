import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

// A scripted AI: the plan, each file (one with a bug), then a repair.
const replies: { match: RegExp; text: string }[] = [];
vi.mock("../src/lib/llm.js", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    agentLlmEnabled: () => true,
    agentModel: () => "test-model",
    generateJson: vi.fn(async (system: string) => {
      if (/architect/.test(system))
        return {
          name: "Tip Calc",
          summary: "Splits a bill",
          language: "python",
          run: "python3 main.py",
          test: "python3 -m unittest",
          files: [
            { path: "tipcalc/__init__.py", purpose: "package", provides: "nothing", uses: [] },
            { path: "tipcalc/core.py", purpose: "math", provides: "split(total, people, tip) -> float", uses: [] },
            { path: "main.py", purpose: "entry", provides: "main()", uses: ["tipcalc/core.py"] },
            { path: "tests/test_core.py", purpose: "tests", provides: "tests for split", uses: ["tipcalc/core.py"] },
            { path: "../evil.py", purpose: "escape", provides: "", uses: [] },
          ],
        };
      if (/Plan the change/.test(system)) return { summary: "Add rounding", changes: [{ path: "tipcalc/core.py", action: "modify", what: "round to cents" }] };
      return null;
    }),
    generateText: vi.fn(async (system: string, user: string) => {
      const r = replies.find((x) => x.match.test(system + "\n" + user));
      return r ? r.text : null;
    }),
  };
});

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "omni-build-"));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const { buildProject, editProject, parseBlocks, applyEdits, writeOrder, safeRel, isProjectRequest } = await import("../src/agents/projectBuilder.js");
const { applyPatch, undoPatch } = await import("../src/lib/patches.js");
const ctx = { signal: new AbortController().signal, workspaceRoot: ROOT } as any;

describe("project builder pieces", () => {
  it("tells projects from snippets", () => {
    expect(isProjectRequest("build a flashcard app in python with tests")).toBe(true);
    expect(isProjectRequest("write a function that adds two numbers")).toBe(false);
    expect(isProjectRequest("make a calculator web page")).toBe(false);
  });
  it("parses file and edit blocks, rejects unsafe paths", () => {
    const b = parseBlocks("~~~~file a/b.py\nx = 1\n~~~~\ntext\n~~~~edit c.js\n<<<<<<< FIND\nold\n=======\nnew\n>>>>>>> REPLACE\n~~~~");
    expect(b).toEqual([{ kind: "file", path: "a/b.py", body: "x = 1" }, { kind: "edit", path: "c.js", body: "<<<<<<< FIND\nold\n=======\nnew\n>>>>>>> REPLACE" }]);
    expect(safeRel("../x")).toBeNull();
    expect(safeRel("/etc/passwd")).toBeNull();
    expect(safeRel(".git/config")).toBeNull();
    expect(safeRel("src/app.py")).toBe("src/app.py");
  });
  it("applies exact find/replace edits only when unique", () => {
    expect(applyEdits("a\nb\nc\n", "<<<<<<< FIND\nb\n=======\nB\n>>>>>>> REPLACE")).toEqual({ text: "a\nB\nc\n", failed: [] });
    expect(applyEdits("x\nx\n", "<<<<<<< FIND\nx\n=======\ny\n>>>>>>> REPLACE").failed).toHaveLength(1);
  });
  it("orders files so each sees what it uses", () => {
    const order = writeOrder([
      { path: "main.py", purpose: "", provides: "", uses: ["core.py"] },
      { path: "core.py", purpose: "", provides: "", uses: [] },
      { path: "test.py", purpose: "", provides: "", uses: ["core.py", "main.py"] },
    ]);
    expect(order.map((l) => l.map((f) => f.path))).toEqual([["core.py"], ["main.py"], ["test.py"]]);
  });
});

describe("building a whole project", () => {
  it("plans, writes, finds the bug with the tests, repairs it, and offers one change set", async () => {
    replies.push(
      { match: /Now write: tipcalc\/__init__\.py/, text: "~~~~file tipcalc/__init__.py\n\n~~~~" },
      // The bug: tip ignored.
      { match: /Now write: tipcalc\/core\.py/, text: "~~~~file tipcalc/core.py\ndef split(total, people, tip):\n    return total / people\n~~~~" },
      { match: /Now write: main\.py/, text: "~~~~file main.py\nfrom tipcalc.core import split\n\nif __name__ == '__main__':\n    print(split(100, 4, 0.2))\n~~~~" },
      { match: /Now write: tests\/test_core\.py/, text: "~~~~file tests/test_core.py\nimport unittest\nfrom tipcalc.core import split\n\nclass T(unittest.TestCase):\n    def test_tip(self):\n        self.assertAlmostEqual(split(100, 4, 0.2), 30.0)\n    def test_no_tip(self):\n        self.assertAlmostEqual(split(90, 3, 0), 30.0)\n~~~~" },
      { match: /fix a multi-file project/, text: "Fixed the tip.\n~~~~file tipcalc/core.py\ndef split(total, people, tip):\n    return total * (1 + tip) / people\n~~~~" }
    );
    const r = await buildProject({ runId: "b1", requestText: "build a tip calculator in python with tests", context: {} } as any, ctx);
    expect(r.status, r.findings.join("\n")).toBe("needs_approval");
    const text = r.findings.join("\n");
    expect(text).toMatch(/Tests: all 2 passed/);
    expect(text).toMatch(/repaired 1 time/);
    expect(text).not.toMatch(/evil/);
    const project = r.attachments!.find((a) => a.type === "code-project") as any;
    expect(project.files.map((f: any) => f.path).sort()).toEqual(["main.py", "tests/test_core.py", "tipcalc/__init__.py", "tipcalc/core.py"]);
    expect(project.folder).toBe("projects/tip-calc");
    expect(fs.existsSync(path.join(ROOT, "projects"))).toBe(false); // nothing written yet

    const applied = applyPatch(r.proposedActions[0].id, ROOT);
    expect(applied).toMatchObject({ ok: true });
    expect(fs.readFileSync(path.join(ROOT, "projects/tip-calc/tipcalc/core.py"), "utf8")).toContain("(1 + tip)");
  });

  it("changes an existing project across files, checked with its own tests, all-or-nothing", async () => {
    replies.push({
      match: /change an existing codebase/,
      text: "~~~~edit tipcalc/core.py\n<<<<<<< FIND\n    return total * (1 + tip) / people\n=======\n    return round(total * (1 + tip) / people, 2)\n>>>>>>> REPLACE\n~~~~\n~~~~file tests/test_round.py\nimport unittest\nfrom tipcalc.core import split\n\nclass R(unittest.TestCase):\n    def test_round(self):\n        self.assertEqual(split(10, 3, 0), 3.33)\n~~~~",
    });
    const project = { folder: "projects/tip-calc", name: "Tip Calc", files: ["projects/tip-calc/tipcalc/__init__.py", "projects/tip-calc/tipcalc/core.py", "projects/tip-calc/main.py", "projects/tip-calc/tests/test_core.py"] };
    const r = await editProject({ runId: "e1", requestText: "add rounding to cents to my tip calc project", context: {} } as any, ctx, project);
    expect(r.status).toBe("needs_approval");
    expect(r.findings.join("\n")).toMatch(/Tests: all 3 passed/);
    expect(r.proposedActions[0].preview).toContain("+    return round(");
    expect(applyPatch(r.proposedActions[0].id, ROOT)).toMatchObject({ ok: true, files: ["projects/tip-calc/tipcalc/core.py", "projects/tip-calc/tests/test_round.py"] });
    expect(undoPatch(r.proposedActions[0].id, ROOT)).toMatchObject({ ok: true });
    expect(fs.existsSync(path.join(ROOT, "projects/tip-calc/tests/test_round.py"))).toBe(false);
  });
});

describe("reading files from any fence style", async () => {
  const { extractFile } = await import("../src/agents/projectBuilder.js");
  it("handles our block, a missing closing line, ``` fences, and fences nested inside our block", () => {
    expect(extractFile("~~~~file a.py\nx = 1\n~~~~", "a.py")).toBe("x = 1");
    expect(extractFile("Here:\n```python\nx = 2\n```\nDone.", "a.py")).toBe("x = 2");
    expect(extractFile("~~~~file a.py\n```python\nx = 3\n```\n~~~~", "a.py")).toBe("x = 3");
    expect(extractFile("~~~~file README.md\n# Title\n\n```bash\npython main.py\n```\n", "README.md")).toBe("# Title\n\n```bash\npython main.py\n```\n");
  });
});
