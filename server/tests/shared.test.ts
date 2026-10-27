import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { SHARED_FILE, sharedDefinitions } from "../scripts/export-shared.mts";

describe("shared/omnipilot.json", () => {
  it("matches the TypeScript definitions (regenerate with: npx tsx scripts/export-shared.mts --write)", () => {
    expect(JSON.parse(fs.readFileSync(SHARED_FILE, "utf8"))).toEqual(JSON.parse(JSON.stringify(sharedDefinitions())));
  });
});
