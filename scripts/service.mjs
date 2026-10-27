#!/usr/bin/env node
// Runs OmniPilot in the background as a system service, instead of a terminal with `npm start`
// (and `caffeinate`): it starts when you log in, restarts if it ever stops, and doesn't rebuild on
// every start. Routines whose time passed while the computer was asleep run as soon as it wakes.
//
//   npm run service:install     build once, then install and start the service
//   npm run service:status      is it running? where are the logs?
//   npm run service:restart     after changing server/.env or pulling updates (rebuilds first)
//   npm run service:uninstall   stop it and remove it
//
// macOS: a LaunchAgent (~/Library/LaunchAgents). Linux: a systemd user service.
// A computer that's asleep (lid closed) can't run anything; to keep OmniPilot running while your
// computer is off, host it on an always-on server (see docs/DEPLOY.md).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LABEL = "com.omnipilot.server";
const cmd = process.argv[2] ?? "status";
const sh = (c, args, opts = {}) => spawnSync(c, args, { encoding: "utf8", ...opts });
const say = (s) => console.log(`  ${s}`);

const PORT = (() => {
  const env = fs.existsSync(path.join(ROOT, "server/.env")) ? fs.readFileSync(path.join(ROOT, "server/.env"), "utf8") : "";
  return /^\s*PORT\s*=\s*(\d+)/m.exec(env)?.[1] ?? "8899";
})();

// A background service starts with a bare PATH, so it misses tools installed in per-user dirs. Build a PATH that
// keeps this terminal's and also includes where uv/node/brew usually live, so the Python front door (uv) and
// cloudflared are found. Without uv, only the legacy engine runs — no workspace, NVIDIA or smart answers.
function servicePath() {
  const home = os.homedir();
  const extra = [
    path.dirname(process.execPath), // the node running this
    `${home}/.local/bin`, `${home}/.cargo/bin`, // uv commonly lives here
    "/opt/homebrew/bin", "/opt/homebrew/opt/node@22/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin",
  ];
  const uv = ["uv", `${home}/.local/bin/uv`, "/opt/homebrew/bin/uv", "/usr/local/bin/uv", `${home}/.cargo/bin/uv`]
    .find((c) => sh(c === "uv" ? "which" : "test", c === "uv" ? ["uv"] : ["-x", c]).status === 0);
  if (uv && uv !== "uv") extra.unshift(path.dirname(uv));
  const seen = new Set();
  return [...(process.env.PATH ?? "").split(":"), ...extra].filter((d) => d && !seen.has(d) && seen.add(d)).join(":");
}

function build() {
  say("Building OmniPilot once…");
  const r = sh(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], { cwd: ROOT, stdio: "inherit", env: { ...process.env, NODE_ENV: "production" } });
  if (r.status !== 0) {
    console.error("\n  The build failed; the service wasn't changed. Run: npm run doctor\n");
    process.exit(1);
  }
}

// --- macOS ---
const plistPath = path.join(os.homedir(), "Library/LaunchAgents", `${LABEL}.plist`);
const logDir = path.join(os.homedir(), "Library/Logs/OmniPilot");
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

// Background services start with a bare PATH: keep this terminal's, so node and uv are found.
const macPlist = () => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${esc(process.execPath)}</string><string>${esc(path.join(ROOT, "scripts/start.mjs"))}</string></array>
  <key>WorkingDirectory</key><string>${esc(ROOT)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${esc(servicePath())}</string>
    <key>HOME</key><string>${esc(os.homedir())}</string>
    <key>NODE_ENV</key><string>production</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${esc(path.join(logDir, "omnipilot.log"))}</string>
  <key>StandardErrorPath</key><string>${esc(path.join(logDir, "omnipilot.log"))}</string>
</dict>
</plist>
`;

const macDomain = () => `gui/${process.getuid()}`;
const macLoaded = () => sh("launchctl", ["print", `${macDomain()}/${LABEL}`]).status === 0;
const napSync = (seconds) => sh("sleep", [String(seconds)]);

function macInstall() {
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  // Fully unload any existing job, then wait until launchd really lets go — bootstrapping too soon returns
  // "Bootstrap failed: 5: Input/output error" because the old job is still registered.
  sh("launchctl", ["bootout", `${macDomain()}/${LABEL}`]);
  for (let i = 0; i < 20 && macLoaded(); i++) napSync(0.25);
  fs.writeFileSync(plistPath, macPlist());
  sh("launchctl", ["enable", `${macDomain()}/${LABEL}`]);
  let r;
  for (let attempt = 0; attempt < 6; attempt++) {
    r = sh("launchctl", ["bootstrap", macDomain(), plistPath]);
    if (r.status === 0) break;
    sh("launchctl", ["bootout", `${macDomain()}/${LABEL}`]); // clear a half-registered job, then retry
    napSync(0.8);
  }
  if (r.status !== 0) {
    console.error(`  Couldn't start the service: ${r.stderr.trim()}`);
    console.error("  If this keeps happening, something else may be using the port. Check: lsof -iTCP:" + PORT + " -sTCP:LISTEN");
    process.exit(1);
  }
  sh("launchctl", ["kickstart", "-k", `${macDomain()}/${LABEL}`]); // make sure it's actually running now
}

function macStatus() {
  if (!fs.existsSync(plistPath)) return say("Not installed. Run: npm run service:install");
  const r = sh("launchctl", ["print", `gui/${process.getuid()}/${LABEL}`]);
  const running = /state = running/.test(r.stdout);
  const pid = /pid = (\d+)/.exec(r.stdout)?.[1];
  say(running ? `Running (pid ${pid}) at http://localhost:${PORT}` : "Installed but not running right now (it restarts by itself within seconds).");
  say(`Logs: ${path.join(logDir, "omnipilot.log")}`);
}

function macUninstall() {
  sh("launchctl", ["bootout", `gui/${process.getuid()}/${LABEL}`]);
  fs.rmSync(plistPath, { force: true });
}

// --- Linux (systemd user service) ---
const unitPath = path.join(os.homedir(), ".config/systemd/user/omnipilot.service");

const linuxUnit = () => `[Unit]
Description=OmniPilot
After=network-online.target

[Service]
WorkingDirectory=${ROOT}
ExecStart=${process.execPath} ${path.join(ROOT, "scripts/start.mjs")}
Environment=PATH=${servicePath()}
Environment=NODE_ENV=production
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`;

function linuxInstall() {
  fs.mkdirSync(path.dirname(unitPath), { recursive: true });
  fs.writeFileSync(unitPath, linuxUnit());
  sh("systemctl", ["--user", "daemon-reload"]);
  const r = sh("systemctl", ["--user", "enable", "--now", "omnipilot.service"]);
  if (r.status !== 0) {
    console.error(`  Couldn't start the service: ${r.stderr.trim()}`);
    process.exit(1);
  }
  // Keep running after logout (and start at boot) where allowed.
  sh("loginctl", ["enable-linger", os.userInfo().username]);
}

const linuxStatus = () => {
  if (!fs.existsSync(unitPath)) return say("Not installed. Run: npm run service:install");
  const r = sh("systemctl", ["--user", "is-active", "omnipilot.service"]);
  say(r.stdout.trim() === "active" ? `Running at http://localhost:${PORT}` : `Not running (${r.stdout.trim()}).`);
  say("Logs: journalctl --user -u omnipilot -f");
};
const linuxUninstall = () => {
  sh("systemctl", ["--user", "disable", "--now", "omnipilot.service"]);
  fs.rmSync(unitPath, { force: true });
  sh("systemctl", ["--user", "daemon-reload"]);
};

const platform = process.platform === "darwin" ? "mac" : process.platform === "linux" ? "linux" : null;
if (!platform) {
  console.error("  The background service is set up for macOS and Linux. On Windows, use Task Scheduler to run `npm run serve` at log-in, or host OmniPilot on a server (docs/DEPLOY.md).");
  process.exit(1);
}
const ops = platform === "mac" ? { install: macInstall, status: macStatus, uninstall: macUninstall } : { install: linuxInstall, status: linuxStatus, uninstall: linuxUninstall };

// `print`: show the service definition install would write, without installing anything.
if (cmd === "print") {
  console.log(platform === "mac" ? macPlist() : linuxUnit());
  process.exit(0);
}

// `wait`: block until the service answers on its port (used before sharing, so share attaches instead of
// starting its own copy). Exits 0 when healthy, 1 on timeout.
if (cmd === "wait") {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const r = sh("curl", ["-s", "-m", "2", "-o", "/dev/null", "-w", "%{http_code}", `http://127.0.0.1:${PORT}/api/engine/health`]);
    if (r.stdout.trim() === "200") {
      console.log(`  OmniPilot is ready at http://localhost:${PORT}`);
      process.exit(0);
    }
    napSync(1);
  }
  console.error("  OmniPilot didn't become ready in time. Check: npm run service:status and its logs.");
  process.exit(1);
}

console.log("");
if (cmd === "install" || cmd === "restart") {
  // The service runs with the node that installs it: it has to be new enough.
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj < 22 || (maj === 22 && min < 13)) {
    console.error(`  This terminal's Node.js is ${process.versions.node}; OmniPilot needs 22.13 or newer. Switch (e.g. nvm use 22, or put Homebrew's node first in PATH) and run this again.\n`);
    process.exit(1);
  }
  build();
  ops.install();
  say(`OmniPilot now runs in the background and starts when you log in: http://localhost:${PORT}`);
  say("You can close the terminal. Routines missed while the computer slept run when it wakes.");
  say("To keep it running while the computer is off, host it on a server: docs/DEPLOY.md");
} else if (cmd === "uninstall") {
  ops.uninstall();
  say("Removed. OmniPilot no longer runs in the background (start it with npm start when you want it).");
} else ops.status();
console.log("");
