#!/usr/bin/env node
// `npm run doctor`: checks everything OmniPilot needs and says how to fix what's missing.
import fs from "node:fs";
import net from "node:net";

// Settings from server/.env (what the server itself will use), then the shell's environment.
const fileEnv = Object.fromEntries(
  (fs.existsSync("server/.env") ? fs.readFileSync("server/.env", "utf8") : "")
    .split(/\r?\n/)
    .map((l) => /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(l))
    .filter(Boolean)
    .map((m) => [m[1], m[2].replace(/^(["'])(.*)\1$/, "$2")])
);
const env = { ...fileEnv, ...process.env };

const GROQ_KEY = (env.GROQ_API_KEY ?? "").trim();
const GROQ_MODEL = env.GROQ_MODEL ?? "openai/gpt-oss-120b";
const PORT = Number(env.PORT ?? 8899);

let problems = 0;
const ok = (msg) => console.log(`  ✓ ${msg}`);
const bad = (msg, fix) => {
  problems++;
  console.log(`  ✗ ${msg}\n      → ${fix}`);
};
const warn = (msg, fix) => console.log(`  ! ${msg}\n      → ${fix}`);

console.log("\nOmniPilot doctor\n");

const [major, minor] = process.versions.node.split(".").map(Number);
if (major > 22 || (major === 22 && minor >= 13)) ok(`Node.js ${process.versions.node}`);
else bad(`Node.js ${process.versions.node} is too old (OmniPilot needs 22.13 or newer for its built-in database)`, "Install the current LTS from https://nodejs.org (or: nvm install 22 && nvm use 22)");

if (fs.existsSync("node_modules/express") && fs.existsSync("node_modules/vite")) ok("Dependencies installed");
else bad("Dependencies aren't installed (or the build tools were skipped)", process.env.NODE_ENV === "production" ? "Run: NODE_ENV=development npm install" : "Run: npm install");

// The AI: Groq (free tier). The key is only sent to Groq.
if (!GROQ_KEY) {
  bad("No Groq API key: OmniPilot's AI runs on Groq", "Get a free key at https://console.groq.com/keys and add GROQ_API_KEY=... to server/.env");
} else {
  try {
    const res = await fetch("https://api.groq.com/openai/v1/models", { headers: { Authorization: `Bearer ${GROQ_KEY}` }, signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const { data = [] } = await res.json();
      if (data.some((m) => m.id === GROQ_MODEL)) ok(`AI ready: ${GROQ_MODEL} on Groq`);
      else bad(`Groq doesn't offer ${GROQ_MODEL} to this key`, "Remove GROQ_MODEL from server/.env to use the default");
    } else bad(`Groq answered ${res.status}${res.status === 401 ? " (the API key was rejected)" : ""}`, "Check GROQ_API_KEY in server/.env");
  } catch {
    warn("Couldn't reach Groq: OmniPilot still works, but answers are limited to built-in knowledge", "Check your internet connection");
  }
}

// Optional: the offline encyclopedia for factual answers.
const kbPath = env.OMNIPILOT_KNOWLEDGE ?? "server/data/knowledge.sqlite";
if (fs.existsSync(kbPath)) ok(`Offline encyclopedia is built (${Math.round(fs.statSync(kbPath).size / 1e6)} MB)`);
else warn("The offline encyclopedia isn't built: factual answers rely on the model's memory", "Run once: npm run knowledge (needs uv; downloads 157 MB)");

// Optional: web tools (only reports whether a key is set; never prints it).
if ((env.BROWSERBASE_API_KEY ?? "").trim() && env.WEB_TOOLS !== "off") ok("Web tools (Browserbase) are configured for Helper's web research");

// Optional: E2B remote execution (only reports whether a key is set; never prints it).
if ((env.E2B_API_KEY ?? "").trim()) ok("E2B remote execution is configured (smoke test: POST /api/remote/e2b/smoke-test)");

// Optional: access from other devices needs a token.
if (env.HOST && !/^(127\.\d+\.\d+\.\d+|localhost|::1)$/.test(env.HOST)) {
  if ((env.OMNIPILOT_API_TOKEN ?? "").trim().length >= 16) ok(`Network access is on (HOST=${env.HOST}) and protected by a token`);
  else bad(`HOST=${env.HOST} needs OMNIPILOT_API_TOKEN (16+ characters); OmniPilot won't start without it`, "Add OMNIPILOT_API_TOKEN to server/.env (see docs/SDK.md), or remove HOST");
}

await new Promise((resolve) => {
  const s = net.createServer();
  s.once("error", () => {
    warn(`Port ${PORT} is in use (maybe OmniPilot is already running)`, `Open http://localhost:${PORT}, or use another port: PORT=8900 npm start`);
    resolve();
  });
  s.once("listening", () => s.close(() => (ok(`Port ${PORT} is free`), resolve())));
  s.listen(PORT, "127.0.0.1");
});

if (process.env.NODE_ENV === "production") {
  warn("NODE_ENV=production is set in this shell, so npm install skips the build tools", "Run: NODE_ENV=development npm install");
}

console.log(problems ? `\n${problems} problem(s) to fix.\n` : "\nAll set. Run: npm start\n");
process.exit(problems ? 1 : 0);
