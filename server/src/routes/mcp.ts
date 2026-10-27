import { Router } from "express";
import { asyncRoute } from "../lib/security.js";
import { listServers, refreshTools, removeServer } from "../lib/mcp.js";
import { logAudit } from "../lib/audit.js";

// The user's MCP servers. Adding one happens in chat and only after approval (it runs a program or
// opens a URL); here the app can list them, reload a server's tools, or remove one.
export const mcpRouter = Router();

mcpRouter.get("/mcp/servers", (_req, res) => res.json({ servers: listServers() }));

mcpRouter.post("/mcp/servers/:name/refresh", asyncRoute(async (req, res) => {
  try {
    res.json({ tools: await refreshTools(req.params.name) });
  } catch (e: any) {
    res.status(400).json({ error: "refresh_failed", message: e?.message ?? "failed" });
  }
}));

mcpRouter.delete("/mcp/servers/:name", (req, res) => {
  if (!removeServer(req.params.name)) return res.status(404).json({ error: "not_found" });
  logAudit({ runId: "n/a", agent: "InfraPilot", action: "mcp_remove_server", parameters: { name: req.params.name }, outcome: "removed" });
  res.json({ ok: true });
});
