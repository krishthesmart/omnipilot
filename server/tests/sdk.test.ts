import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.js";
// @ts-expect-error -- plain JS module with its own .d.ts beside it
import { OmniPilot, OmniPilotError } from "../../sdk/js/index.mjs";

// The JavaScript SDK against a real OmniPilot server on a random port.
let server: Server;
let op: InstanceType<typeof OmniPilot>;

beforeAll(async () => {
  server = createApp().listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  op = new OmniPilot({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
});

afterAll(() => new Promise((r) => server.close(r)));

describe("JavaScript SDK", () => {
  it("asks and gets a whole answer", async () => {
    const r = await op.ask("is 2^10 = 1024?", { textOnly: true });
    expect(r.status).toBe("completed");
    expect(r.answer).toMatch(/True/);
    expect(r.agents.map((a: { agent: string }) => a.agent)).toContain("MathPilot");
  });

  it("streams an answer and hands over the whole text", async () => {
    let text = "";
    const r = await op.stream("Draw a cat under a rainbow", { onDelta: (d: string) => (text += d) });
    expect(text).toContain("Here's your picture");
    expect(r.attachments[0].type).toBe("picture");
  });

  it("keeps a conversation together", async () => {
    const chat = op.conversation();
    expect(chat.id).toMatch(/^sdk-/);
    const r = await chat.ask("is (a+b)^2 = a^2 + b^2?", { textOnly: true });
    expect(r.answer).toMatch(/Not true/);
  });

  it("uses MathPilot directly", async () => {
    expect((await op.checkIdentity("sin(x)^2 + cos(x)^2 = 1")).verdict).toBe("true");
    expect((await op.mathStatus()).stages).toBeGreaterThan(0);
    expect(Array.isArray(await op.discoveries({ limit: 3 }))).toBe(true);
  });

  it("reports errors clearly", async () => {
    await expect(op.checkIdentity("no equals sign here")).rejects.toBeInstanceOf(OmniPilotError);
  });
});
