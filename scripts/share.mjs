#!/usr/bin/env node
// Shares the OmniPilot on this computer at a public https:// address, free, with a Cloudflare Tunnel
// (no Cloudflare account needed, nothing opened on your router). Visitors must sign in with
// OMNIPILOT_PASSWORD. The address works while this computer is on and awake.
//
//   npm run share
//
// With the free Cloudflare Worker set up (deploy/cloudflare-free/README.md), your permanent
// https://omnipilot-link.<you>.workers.dev address is pointed at the new tunnel automatically, so the
// link you share never changes.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadInfisical } from "./infisical.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readEnv = (file) =>
  Object.fromEntries(
    (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "")
      .split(/\r?\n/)
      .map((l) => /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(l))
      .filter(Boolean)
      .map((m) => [m[1], m[2].replace(/^(["'])(.*)\1$/, "$2")])
  );
const fileEnv = { ...readEnv(path.join(ROOT, ".env")), ...readEnv(path.join(ROOT, "server/.env")) };
const env = { ...fileEnv, ...loadInfisical(ROOT, { ...fileEnv, ...process.env }).secrets, ...process.env };
const PORT = Number(env.PORT ?? 8899);
const say = (s = "") => console.log(s ? `  ${s}` : "");
const fail = (s) => {
  console.error(`\n  ${s}\n`);
  process.exit(1);
};

if ((env.OMNIPILOT_PASSWORD ?? "").length < 12) {
  fail("Set OMNIPILOT_PASSWORD (12+ characters) in server/.env first: anyone with your link must sign in with it.");
}
const cloudflared = ["cloudflared", "/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared"].find((c) => spawnSync(c, ["--version"], { stdio: "ignore" }).status === 0);
if (!cloudflared) fail("Install Cloudflare's tunnel tool first: brew install cloudflared  (or https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)");

const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill("SIGTERM");
  setTimeout(() => process.exit(code), 1500).unref();
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

async function health() {
  try {
    return (await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

// 1. OmniPilot itself: use the one already running (npm start or the background service), or start it.
if (await health()) {
  // It must have been started with the password, or visitors couldn't be asked to sign in.
  const auth = await fetch(`http://127.0.0.1:${PORT}/api/auth`, { headers: { "CF-Connecting-IP": "203.0.113.1" } }).then((r) => r.json()).catch(() => null);
  if (!auth?.required) fail("OmniPilot is already running but was started before OMNIPILOT_PASSWORD was set. Restart it (npm run service:restart, or stop npm start and run this again).");
  say(`Using the OmniPilot already running on port ${PORT}.`);
} else {
  if (!fs.existsSync(path.join(ROOT, "server/dist/index.js")) || !fs.existsSync(path.join(ROOT, "web/dist/index.html"))) {
    say("Building OmniPilot once…");
    if (spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], { cwd: ROOT, stdio: "inherit", env: { ...process.env, NODE_ENV: "production" } }).status !== 0) fail("The build failed. Run: npm run doctor");
  }
  say("Starting OmniPilot…");
  const app = spawn(process.execPath, [path.join(ROOT, "scripts/start.mjs")], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"], env: process.env });
  children.push(app);
  app.on("exit", (code) => !stopping && (console.error(`\n  OmniPilot stopped (exit code ${code}).\n`), stop(1)));
  for (let i = 0; i < 120 && !(await health()); i++) await new Promise((r) => setTimeout(r, 500));
  if (!(await health())) fail("OmniPilot didn't start. Run npm start to see why.");
}

// 2. The tunnel: a free, temporary https://<random>.trycloudflare.com address.
say("Opening a Cloudflare Tunnel…");
const tunnel = spawn(cloudflared, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${PORT}`], { stdio: ["ignore", "pipe", "pipe"] });
children.push(tunnel);
tunnel.on("exit", (code) => !stopping && (console.error(`\n  The tunnel closed (exit code ${code}).\n`), stop(1)));
const url = await new Promise((resolve) => {
  const onData = (chunk) => {
    const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(String(chunk));
    if (m) resolve(m[0]);
  };
  tunnel.stdout.on("data", onData);
  tunnel.stderr.on("data", onData);
  setTimeout(() => resolve(null), 60_000);
});
if (!url) {
  stop(1);
  fail("Cloudflare didn't give a tunnel address within a minute. Check your internet connection and try again.");
}

// 3. The permanent link (optional): point the free Worker at this tunnel.
let permanent = null;
const workerDir = path.join(ROOT, "deploy/cloudflare-free");
const workerConfig = fs.existsSync(path.join(workerDir, "wrangler.jsonc")) ? fs.readFileSync(path.join(workerDir, "wrangler.jsonc"), "utf8") : "";
if (/"id":\s*"[0-9a-f]{32}"/.test(workerConfig) && fs.existsSync(path.join(workerDir, "node_modules"))) {
  const put = spawnSync("npx", ["wrangler", "kv", "key", "put", "--binding=LINK", "--remote", "target", url], { cwd: workerDir, encoding: "utf8" });
  if (put.status === 0) permanent = env.OMNIPILOT_SHARE_LINK || "your workers.dev link (see deploy/cloudflare-free/README.md)";
  else say(`(Couldn't update the permanent link: ${(put.stderr || put.stdout).trim().split("\n").pop()})`);
}

say();
say("OmniPilot is shared:");
say(`  ${url}`);
if (permanent) say(`  ${permanent}   (your permanent link now points here)`);
say();
say("Visitors sign in with your OMNIPILOT_PASSWORD. The link works while this computer is on and awake;");
say("this address changes each time unless you set up the permanent link. Press Ctrl-C to stop sharing.");
say();
