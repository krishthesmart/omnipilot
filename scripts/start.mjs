#!/usr/bin/env node
// Starts OmniPilot: the Python front door (FastAPI, engine/) on the public port,
// and the TypeScript engine (server/) on an internal loopback port that only
// accepts requests carrying a secret made fresh for each launch. Stops both
// together. Without uv (the Python tool), the TypeScript engine runs on its own
// on the public port, as before.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadInfisical } from "./infisical.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The same settings files the server reads; the shell's environment wins.
// server/.env first, then .env in the project folder for anything not set there.
const readEnv = (file) =>
  Object.fromEntries(
    (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "")
      .split(/\r?\n/)
      .map((l) => /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(l))
      .filter(Boolean)
      .map((m) => [m[1], m[2].replace(/^(["'])(.*)\1$/, "$2")])
  );
const fileEnv = { ...readEnv(path.join(ROOT, ".env")), ...readEnv(path.join(ROOT, "server/.env")) };
// Keys from Infisical come before the files (which are the fallback); the shell's environment still wins.
const infisical = loadInfisical(ROOT, { ...fileEnv, ...process.env });
if (infisical.note) console.log(`  ${infisical.note}`);
const env = { ...fileEnv, ...infisical.secrets, ...process.env, ...(Object.keys(infisical.secrets).length ? { OMNIPILOT_INFISICAL_LOADED: Object.keys(infisical.secrets).join(",") } : {}) };
// A Python environment activated in this terminal (e.g. training/.venv) isn't OmniPilot's; uv uses engine/.venv.
delete env.VIRTUAL_ENV;
const PORT = Number(env.PORT ?? 8899);
const HOST = env.HOST ?? "127.0.0.1";
const NODE_PORT = Number(env.OMNIPILOT_NODE_PORT ?? PORT - 1);
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost|::1)$/;

// OMNIPILOT_ALLOW_ANY_HOST relaxes the Host-header check only; it never stands in for the token.
if (!LOOPBACK.test(HOST) && (env.OMNIPILOT_API_TOKEN ?? "").trim().length < 16) {
  console.error(`\n  HOST=${HOST} makes OmniPilot reachable from other devices. Set OMNIPILOT_API_TOKEN in server/.env first`);
  console.error(`  (16+ random characters; devices send it as "Authorization: Bearer <token>"). See docs/SDK.md.\n`);
  process.exit(1);
}

const hasUv = spawnSync("uv", ["--version"], { stdio: "ignore", shell: process.platform === "win32" }).status === 0;
const children = [];
let stopping = false;

function run(name, cmd, args, opts) {
  const child = spawn(cmd, args, { stdio: "inherit", shell: process.platform === "win32", ...opts });
  children.push(child);
  child.on("exit", (code) => {
    if (stopping) return;
    console.error(`\n  ${name} stopped${code ? ` (exit code ${code})` : ""}; shutting OmniPilot down.\n`);
    stop(code ?? 1);
  });
  return child;
}

function stop(code = 0) {
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill("SIGTERM");
  setTimeout(() => process.exit(code), 3000).unref();
  Promise.all(children.map((c) => (c.exitCode !== null ? null : new Promise((r) => c.once("exit", r))))).then(() => process.exit(code));
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

if (!hasUv) {
  console.log("\n  ! uv (the Python tool) isn't installed, so OmniPilot runs without its Python front door.");
  console.log("    Install it from https://docs.astral.sh/uv/ to use the full stack.\n");
  run("OmniPilot", process.execPath, ["dist/index.js"], { cwd: path.join(ROOT, "server"), env: { ...env, PORT: String(PORT), HOST } });
} else {
  // The Python environment (engine/.venv) from the locked versions; quick when already up to date.
  const sync = spawnSync("uv", ["sync", "--frozen", "--no-dev", "--inexact", "--project", path.join(ROOT, "engine")], { stdio: "inherit", shell: process.platform === "win32", env });
  if (sync.status !== 0) {
    console.error("\n  Couldn't set up the Python environment (engine/). Run: npm run doctor\n");
    process.exit(1);
  }
  const internal = randomBytes(32).toString("base64url");
  run("The TypeScript engine", process.execPath, ["dist/index.js"], {
    cwd: path.join(ROOT, "server"),
    // OMNIPILOT_ENGINE_URL: the front door's own services (the local-first AI model, the tool router).
    env: { ...env, PORT: String(NODE_PORT), HOST: "127.0.0.1", OMNIPILOT_INTERNAL_TOKEN: internal, OMNIPILOT_BEHIND_FRONT_DOOR: "1", OMNIPILOT_ENGINE_URL: `http://127.0.0.1:${PORT}` },
  });
  run("The Python front door", "uv", ["run", "--frozen", "--no-dev", "--project", path.join(ROOT, "engine"), "uvicorn", "omnipilot_engine.app:app", "--app-dir", path.join(ROOT, "engine"), "--host", HOST, "--port", String(PORT), "--log-level", "warning", "--no-server-header"], {
    env: { ...env, PORT: String(PORT), HOST, OMNIPILOT_NODE_URL: `http://127.0.0.1:${NODE_PORT}`, OMNIPILOT_INTERNAL_TOKEN: internal },
  });
  // Announce once the front door answers.
  const started = Date.now();
  const announce = async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/engine/health`, { headers: { host: `localhost:${PORT}` } });
      if (res.ok) return console.log(`\n  OmniPilot is running at http://localhost:${PORT}\n`);
    } catch {
      // not up yet
    }
    if (!stopping && Date.now() - started < 60_000) setTimeout(announce, 500);
  };
  setTimeout(announce, 800);
}
