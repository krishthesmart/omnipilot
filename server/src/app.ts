import express from "express";
import { checkPassword, clearSessionCookie, hasOwnerSession, issueSession, loginAllowed, noteFailedLogin, ownerPassword, publicOrigin, setSessionCookie } from "./lib/ownerAuth.js";
import { budgetWarning, cacheStats, usageToday } from "./lib/aiBudget.js";
import { z } from "zod";
import { logAudit } from "./lib/audit.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chatRouter } from "./routes/chat.js";
import { auditRouter } from "./routes/audit.js";
import { approvalsRouter } from "./routes/approvals.js";
import { mcpRouter } from "./routes/mcp.js";
import { skillsRouter } from "./routes/skills.js";
import { codeRouter } from "./routes/code.js";
import { connectorsRouter } from "./routes/connectors.js";
import { watcherRouter } from "./routes/watcher.js";
import { mathRouter } from "./routes/math.js";
import { askRouter } from "./routes/ask.js";
import { conversationsRouter } from "./routes/conversations.js";
import { registerPythonBridge } from "./lib/pythonBridge.js";
import { asyncRoute, errorHandler, internalOnly, localOnly, rateLimit, securityHeaders } from "./lib/security.js";
import { APP_VERSION } from "./lib/status.js";
import { aiUnavailableReason, groqModels, groqStatus } from "./lib/groq.js";
import { sandboxEnabled } from "./lib/sandbox.js";

/** The built web UI (`npm run build`), served from the same port in production. */
const WEB_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");

const internalAuditSchema = z.object({
  agent: z.string().min(1).max(40),
  action: z.string().min(1).max(80),
  outcome: z.string().min(1).max(300),
  parameters: z.record(z.unknown()).optional(),
  runId: z.string().min(1).max(100).optional(),
});

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  // Hosted behind a proxy (Fly.io, Render...): the client's address comes from the proxy's header.
  if (publicOrigin() || ownerPassword()) app.set("trust proxy", 1);
  app.use(securityHeaders);
  app.use(internalOnly);
  app.use(localOnly);
  app.use((req, res, next) => (req.path.startsWith("/api/internal/agent/") ? next() : express.json({ limit: "256kb" })(req, res, next)));
  registerPythonBridge(app);

  app.get("/api/health", (_req, res) => res.json({ ok: true }));

  // Signing in when OmniPilot is hosted on a server (OMNIPILOT_PASSWORD). On this computer it's never needed.
  app.get("/api/auth", (req, res) => {
    const required = Boolean(ownerPassword()) && res.locals.principal !== "local";
    res.json({ required, signedIn: !required || hasOwnerSession(req) });
  });
  app.post("/api/login", (req, res) => {
    if (!ownerPassword()) return res.status(404).json({ error: "not_found" });
    const ip = req.ip ?? "unknown";
    if (!loginAllowed(ip)) return res.status(429).json({ error: "rate_limited", message: "Too many tries. Wait 15 minutes." });
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!checkPassword(password)) {
      noteFailedLogin(ip);
      return res.status(401).json({ error: "wrong_password", message: "That password isn't right." });
    }
    setSessionCookie(req, res, issueSession());
    logAudit({ runId: "n/a", agent: "System", action: "sign_in", parameters: {}, outcome: "signed in" });
    res.json({ ok: true });
  });
  app.post("/api/logout", (req, res) => {
    clearSessionCookie(req, res);
    res.json({ ok: true });
  });
  app.get("/api/status", asyncRoute(async (_req, res) => {
    const models = groqModels();
    res.json({
      version: APP_VERSION,
      ai: { ...(await groqStatus()), usage: usageToday(models), budgetWarning: aiUnavailableReason() ?? budgetWarning(models), cache: cacheStats() },
      codeVerify: sandboxEnabled(),
    });
  }));

  // Activity-log entries from the Python front door (e.g. E2B remote execution). Only the front door
  // can call this: it needs the per-launch internal secret, and the front door never forwards
  // /api/internal/* from clients.
  app.post("/api/internal/audit", (req, res) => {
    if (!res.locals.viaFrontDoor) return res.status(404).json({ error: "not_found" });
    const parsed = internalAuditSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
    const { agent, action, outcome, parameters, runId } = parsed.data;
    res.json(logAudit({ runId: runId ?? "remote-exec", agent, action, outcome, parameters: parameters ?? {} }));
  });

  app.use("/api/chat", rateLimit({ windowMs: 60_000, max: 30 }));
  app.use("/api/ask", rateLimit({ windowMs: 60_000, max: 30 }));
  app.use("/api", chatRouter);
  app.use("/api", auditRouter);
  app.use("/api", approvalsRouter);
  app.use("/api", codeRouter);
  app.use("/api", mcpRouter);
  app.use("/api", skillsRouter);
  app.use("/api", connectorsRouter);
  app.use("/api", watcherRouter);
  app.use("/api", mathRouter);
  app.use("/api", askRouter);
  app.use("/api", conversationsRouter);
  app.use("/api", (_req, res) => res.status(404).json({ error: "not_found" }));

  if (fs.existsSync(path.join(WEB_DIST, "index.html"))) {
    app.use(express.static(WEB_DIST, { index: false, maxAge: "1h" }));
    // Single-page app: every other GET serves the UI.
    app.get("*", (_req, res) => res.sendFile(path.join(WEB_DIST, "index.html")));
  }

  app.use(errorHandler);
  return app;
}
