import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { CASES, CONTRACT_FILE, captureCase, keywordContract } from "../scripts/contracts.mts";

// The engine must keep producing the reference runs in contracts/runs.json. The
// Python/LangGraph engine is held to the same file (engine/tests/test_contracts.py).
// After an intended behaviour change: npx tsx scripts/contracts.mts --write
const expected = JSON.parse(fs.readFileSync(CONTRACT_FILE, "utf8")).cases;

describe("Reference runs (contracts/runs.json)", () => {
  it("covers every case", () => {
    expect(expected.map((c: any) => c.name)).toEqual(CASES.map((c) => c.name));
  });

  CASES.forEach((c, i) => {
    it(c.name, async () => {
      expect(await captureCase(c, 100 + i)).toEqual(expected[i]);
    });
  });

  it("keyword scores (contracts/keywords.json)", async () => {
    const expectedKeywords = JSON.parse(fs.readFileSync(path.join(path.dirname(CONTRACT_FILE), "keywords.json"), "utf8")).phrases;
    expect(await keywordContract()).toEqual(expectedKeywords);
  });
});
