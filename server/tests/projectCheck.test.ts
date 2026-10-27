import { describe, expect, it } from "vitest";
import { checkProject } from "../src/lib/projectCheck.js";

describe("checking a whole project", () => {
  it("passes a good Python project and runs its tests", async () => {
    const r = await checkProject([
      { path: "todo/core.py", content: "def add(items, x):\n    return items + [x]\n" },
      { path: "todo/__init__.py", content: "" },
      { path: "main.py", content: "from todo.core import add\nprint(add([], 'a'))\n" },
      { path: "tests/test_core.py", content: "import unittest\nfrom todo.core import add\n\nclass T(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add([], 1), [1])\n    def test_two(self):\n        self.assertEqual(add([1], 2), [1, 2])\n" },
    ]);
    expect(r.problems).toEqual([]);
    expect(r.tests).toMatchObject({ ran: true, passed: 2, failed: 0 });
  });

  it("finds syntax errors, missing files and missing names", async () => {
    const r = await checkProject([
      { path: "a.py", content: "def f(:\n  pass\n" },
      { path: "b.py", content: "from c import g\nfrom .missing import x\n" },
      { path: "c.py", content: "def h():\n    return 1\n" },
      { path: "web/app.js", content: "import { sum, nope } from './math.js';\nimport { x } from './gone.js';\n" },
      { path: "web/math.js", content: "export function sum(a, b) { return a + b }\n" },
      { path: "web/index.html", content: '<script src="app.js"></script><link href="style.css" rel="stylesheet">' },
      { path: "bad.js", content: "function (" },
    ], { runTests: false });
    const msgs = r.problems.map((p) => `${p.file}: ${p.message}`).join("\n");
    expect(msgs).toMatch(/a\.py: Syntax error/);
    expect(msgs).toMatch(/b\.py: Imports g from c\.py/);
    expect(msgs).toMatch(/b\.py: Imports "\.missing"/);
    expect(msgs).toMatch(/web\/app\.js: Imports nope from web\/math\.js/);
    expect(msgs).toMatch(/web\/app\.js: Imports "\.\/gone\.js"/);
    expect(msgs).toMatch(/web\/index\.html: Links to "style\.css"/);
    expect(msgs).toMatch(/bad\.js: Syntax error/);
    expect(msgs).not.toMatch(/sum from/);
  });

  it("reports failing tests, and runs Node's test runner", async () => {
    const r = await checkProject([
      { path: "lib.js", content: "export const double = (n) => n * 3;\n" },
      { path: "lib.test.js", content: "import test from 'node:test';\nimport assert from 'node:assert';\nimport { double } from './lib.js';\ntest('double', () => assert.equal(double(2), 4));\ntest('zero', () => assert.equal(double(0), 0));\n" },
      { path: "package.json", content: '{"type":"module"}' },
    ]);
    expect(r.tests).toMatchObject({ ran: true, passed: 1, failed: 1 });
  });

  it("won't run tests for code that reaches the network or other programs", async () => {
    const r = await checkProject([
      { path: "x.py", content: "import subprocess\nsubprocess.run(['ls'])\n" },
      { path: "test_x.py", content: "import unittest\nimport x\n" },
    ]);
    expect(r.tests.ran).toBe(false);
    expect(r.tests.why).toMatch(/subprocess/);
  });
});
