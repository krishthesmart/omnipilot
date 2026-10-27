import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Tests run against a private copy of the starter workspace (code, docs, notes, robotics-arm),
// never the user's live server/workspace: projects the user builds and approves there must not
// change test results, and tests must never write into it.
export const TEST_WORKSPACE = path.join(os.tmpdir(), "omnipilot-test-workspace");
const SEED = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "workspace");
const STARTER = ["code", "docs", "notes", "robotics-arm"];

export default function setup() {
  fs.rmSync(TEST_WORKSPACE, { recursive: true, force: true });
  fs.mkdirSync(TEST_WORKSPACE, { recursive: true });
  for (const entry of STARTER) {
    const from = path.join(SEED, entry);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(TEST_WORKSPACE, entry), { recursive: true });
  }
  return () => fs.rmSync(TEST_WORKSPACE, { recursive: true, force: true });
}
