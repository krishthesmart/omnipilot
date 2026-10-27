import "./loadEnv.js";
import { ownerPassword, publicOrigin } from "./lib/ownerAuth.js";
import { createApp } from "./app.js";
import { db } from "./db.js";
import { APP_VERSION } from "./lib/status.js";
import { apiToken } from "./lib/security.js";
import { startMathPilot, stopMathPilot } from "./lib/math/discovery.js";
import { startRoutines, stopRoutines } from "./lib/routines.js";
import { startCodeWatch, stopCodeWatch } from "./lib/codeWatch.js";
import { closeAllServers } from "./lib/mcp.js";
import { flushLangfuse, langfuseEnabled } from "./lib/langfuse.js";
import { webToolsEnabled } from "./lib/web/browserbase.js";
import { browserUseEnabled } from "./lib/web/browserUse.js";
import { e2bEnabled } from "./lib/e2b.js";
import { WORKSPACE_ROOT } from "./orchestrator.js";
import { groqModels, groqStatus } from "./lib/groq.js";

const PORT = Number(process.env.PORT ?? 8899);
// Local app: listen on this computer only. HOST=0.0.0.0 would expose it to the network (not recommended).
const HOST = process.env.HOST ?? "127.0.0.1";
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost|::1)$/;

// Listening on the network only makes sense with a token: other devices can't use OmniPilot without one.
// (OMNIPILOT_ALLOW_ANY_HOST relaxes the Host-header check only; it never stands in for the token.)
if (!LOOPBACK.test(HOST) && !apiToken() && !ownerPassword()) {
  console.error(`\n  HOST=${HOST} makes OmniPilot reachable from other devices. Set OMNIPILOT_API_TOKEN in server/.env first`);
  console.error(`  (16+ random characters; devices send it as "Authorization: Bearer <token>"). See docs/SDK.md.\n`);
  process.exit(1);
}

const server = createApp().listen(PORT, HOST, async () => {
  // Behind the Python front door the launcher announces the public address; this port is internal.
  if (process.env.OMNIPILOT_BEHIND_FRONT_DOOR === "1") console.log(`\n  OmniPilot ${APP_VERSION}: engine ready on internal port ${PORT}`);
  else console.log(`\n  OmniPilot ${APP_VERSION} is running at http://localhost:${PORT}\n`);
  const ai = await groqStatus();
  if (ai.reachable) console.log(`  AI ready: ${ai.model} on Groq (backups when it's busy: ${groqModels().slice(1).join(", ")}).\n`);
  else console.log(`  ! AI not available: ${ai.problem}. Get a free key at https://console.groq.com/keys and put GROQ_API_KEY=... in server/.env.\n`);
  const extras = [
    webToolsEnabled() && "web research (Browserbase)",
    browserUseEnabled() && "cloud browser (Browser Use)",
    e2bEnabled() && "cloud commands (E2B)",
    langfuseEnabled() && "tracing (Langfuse)",
  ].filter(Boolean);
  if (extras.length) console.log(`  Also on: ${extras.join(", ")}.\n`);
  if (!LOOPBACK.test(HOST) && ownerPassword()) console.log(`  Hosted mode: sign in with OMNIPILOT_PASSWORD at ${publicOrigin() ?? "your server's address (set OMNIPILOT_PUBLIC_URL)"}\n`);
  else if (!LOOPBACK.test(HOST)) console.log(`  SDK access from other devices is on (token required): http://<this computer's IP>:${PORT}/api/ask\n`);
  // MathPilot's background search for new identities (MATHPILOT=off to disable).
  startMathPilot();
  // Daily routines (skills with a time; ROUTINES=off to disable).
  startRoutines();
  // CodePilot's always-on check of the workspace's code folder (CODE_WATCH=off to disable).
  startCodeWatch(WORKSPACE_ROOT);
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n  Port ${PORT} is already in use. Is OmniPilot already running? Or set PORT=8900 in server/.env to use another port\n`);
    process.exit(1);
  }
  throw err;
});

function shutdown() {
  stopMathPilot();
  stopRoutines();
  stopCodeWatch();
  closeAllServers();
  void flushLangfuse();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
