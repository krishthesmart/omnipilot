// OmniPilot's keys from Infisical (the project in .infisical.json), read once at launch with the Infisical
// CLI: your `infisical login` on this computer, or a machine identity's INFISICAL_TOKEN on a server.
// Infisical comes before server/.env and .env (they're the fallback when Infisical can't be reached); the
// shell's own environment still wins. Values are never printed; OMNIPILOT_INFISICAL=0 turns this off.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Names Infisical may hold under a spelling the code doesn't read. */
const ALIASES = { "YOU.COM_API_KEY": "YDC_API_KEY" };

export function infisicalSettings(root) {
  const file = path.join(root, ".infisical.json");
  if (!fs.existsSync(file)) return null;
  try {
    const c = JSON.parse(fs.readFileSync(file, "utf8"));
    return c.workspaceId ? { projectId: c.workspaceId, env: c.defaultEnvironment || "dev" } : null;
  } catch {
    return null;
  }
}

/** { secrets, note }: secrets is {} when Infisical isn't set up or can't be reached (note says why, without values). */
export function loadInfisical(root, env = process.env) {
  if (env.OMNIPILOT_INFISICAL === "0") return { secrets: {}, note: null };
  const s = infisicalSettings(root);
  if (!s) return { secrets: {}, note: null };
  const cli = ["infisical", "/opt/homebrew/bin/infisical", "/usr/local/bin/infisical"].find((c) => spawnSync(c, ["--version"], { stdio: "ignore" }).status === 0);
  if (!cli) return { secrets: {}, note: "Infisical CLI not installed; using the .env files." };
  const r = spawnSync(cli, ["export", "--projectId", s.projectId, "--env", env.OMNIPILOT_INFISICAL_ENV || s.env, "--format", "json", "--silent"], {
    cwd: root, env, encoding: "utf8", timeout: 20_000, maxBuffer: 4 * 1024 * 1024,
  });
  if (r.status !== 0) return { secrets: {}, note: "Couldn't read Infisical (not signed in, or offline); using the .env files. Run: infisical login" };
  try {
    const secrets = {};
    for (const { key, value } of JSON.parse(r.stdout)) {
      const name = ALIASES[key] ?? key;
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && typeof value === "string") secrets[name] = value;
    }
    return { secrets, note: `Keys from Infisical (${Object.keys(secrets).length}, environment "${env.OMNIPILOT_INFISICAL_ENV || s.env}").` };
  } catch {
    return { secrets: {}, note: "Infisical's answer wasn't readable; using the .env files." };
  }
}
