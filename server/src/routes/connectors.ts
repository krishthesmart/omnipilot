import { asyncRoute } from "../lib/security.js";
import { Router } from "express";
import { z } from "zod";
import { getConnectorInternal, getConnectorPublic, listConnectors, setConnectorStatus, setConnectorVerified } from "../db.js";
import { verifierFor } from "../lib/integrations.js";
import { verifyGmail } from "../lib/gmail.js";
import { finishDriveAuth, revokeDrive, startDriveAuth } from "../lib/googleDrive.js";
import { logAudit } from "../lib/audit.js";

export const connectorsRouter = Router();

connectorsRouter.get("/connectors", (_req, res) => {
  res.json({ connectors: listConnectors() });
});

const connectSchema = z.object({ token: z.string().min(1).max(500).optional(), account: z.string().min(3).max(200).optional() });

connectorsRouter.post("/connectors/:name/connect", asyncRoute(async (req, res) => {
  const name = req.params.name;
  const existing = getConnectorInternal(name);
  if (!existing) return res.status(404).json({ error: "not_found" });

  const parsed = connectSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

  // Gmail: an address plus a Google app password, checked by signing in over IMAP (read-only).
  if (name === "Gmail") {
    const { token, account } = parsed.data;
    if (!token || !account) return res.status(400).json({ error: "token_required", message: "Gmail needs your address and an app password." });
    const result = await verifyGmail(account.trim(), token);
    logAudit({ runId: "n/a", agent: "InfraPilot", action: "connector_verify", parameters: { name, account, token }, outcome: result.ok ? `verified as ${result.accountLabel}` : `failed: ${result.error}` });
    if (!result.ok) return res.status(400).json({ error: "verification_failed", message: result.error });
    setConnectorVerified(name, result.accountLabel ?? account, JSON.stringify({ address: account.trim(), password: token.replace(/\s+/g, "") }));
    return res.json(getConnectorPublic(name));
  }

  const verifier = verifierFor(name);

  if (verifier) {
    // Real, token-based connectors: require and actually verify the token
    // against the provider's own API before ever marking it connected.
    if (!parsed.data.token) {
      return res.status(400).json({ error: "token_required", message: `${name} requires a token to verify a real connection.` });
    }
    const result = await verifier(parsed.data.token);
    logAudit({
      runId: "n/a",
      agent: "InfraPilot",
      action: "connector_verify",
      parameters: { name, token: parsed.data.token }, // redacted by key "token" before persisting/broadcasting
      outcome: result.ok ? `verified as ${result.accountLabel}` : `failed: ${result.error}`,
    });
    if (!result.ok) {
      return res.status(400).json({ error: "verification_failed", message: result.error });
    }
    setConnectorVerified(name, result.accountLabel ?? "connected", parsed.data.token);
    return res.json(getConnectorPublic(name));
  }

  // Every connector is verified for real; one without a token check signs in with the provider instead.
  return res.status(400).json({ error: "oauth_required", message: `${name} connects by signing in with the provider (use the button on its card).` });
}));

// Google Drive: start Google's sign-in. The page sends its own origin so Google redirects back here.
const oauthStartSchema = z.object({ clientId: z.string().min(10).max(200), clientSecret: z.string().min(5).max(200), origin: z.string().max(100) });
connectorsRouter.post("/connectors/:name/oauth/start", (req, res) => {
  if (req.params.name !== "Google Drive") return res.status(404).json({ error: "not_found" });
  startOauth(req, res);
});
function startOauth(req: any, res: any) {
  const parsed = oauthStartSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_request", message: "Paste the client ID and client secret from Google Cloud." });
  try {
    res.json({ url: startDriveAuth(parsed.data.clientId, parsed.data.clientSecret, parsed.data.origin) });
  } catch (e: any) {
    res.status(400).json({ error: "invalid_request", message: e?.message ?? "couldn't start sign-in" });
  }
}

const page = (title: string, text: string, ok: boolean) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f5f6f8;color:#1f2937}main{max-width:460px;padding:32px;background:#fff;border-radius:16px;box-shadow:0 4px 24px #0001;text-align:center}h1{font-size:20px;color:${ok ? "#059669" : "#b91c1c"}}@media (prefers-color-scheme:dark){body{background:#111318;color:#e5e7eb}main{background:#1b1e24}}</style></head><body><main><h1>${title}</h1><p>${text}</p></main></body></html>`;
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// Google redirects the browser here after sign-in.
connectorsRouter.get("/oauth/google/callback", asyncRoute(async (req, res) => {
  const { code, state, error } = req.query as Record<string, string | undefined>;
  res.type("html");
  if (error || !code || !state) return res.status(400).send(page("Google Drive wasn't connected", error === "access_denied" ? "You cancelled the sign-in. You can close this tab." : "Google didn't send a sign-in code. Start again from the Google Drive card.", false));
  try {
    const { account } = await finishDriveAuth(code, state);
    logAudit({ runId: "n/a", agent: "InfraPilot", action: "connector_oauth", parameters: { name: "Google Drive" }, outcome: `connected as ${account}` });
    res.send(page("Google Drive is connected", `Signed in as ${escapeHtml(account)}. You can close this tab and go back to OmniPilot.`, true));
  } catch (e: any) {
    logAudit({ runId: "n/a", agent: "InfraPilot", action: "connector_oauth", parameters: { name: "Google Drive" }, outcome: `failed: ${e?.message}` });
    res.status(400).send(page("Google Drive wasn't connected", escapeHtml(e?.message ?? "Sign-in failed."), false));
  }
}));

connectorsRouter.post("/connectors/:name/disconnect", asyncRoute(async (req, res) => {
  const existing = getConnectorInternal(req.params.name);
  if (!existing) return res.status(404).json({ error: "not_found" });
  if (req.params.name === "Google Drive") await revokeDrive();
  setConnectorStatus(req.params.name, "not_connected");
  logAudit({ runId: "n/a", agent: "InfraPilot", action: "connector_disconnect", parameters: { name: req.params.name }, outcome: "not_connected" });
  res.json(getConnectorPublic(req.params.name));
}));
