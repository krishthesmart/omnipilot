import { calendarName, fetchIcs } from "./calendar.js";
/**
 * Real, lightweight integration verification -- no OAuth app registration,
 * no third-party unified-API platform. Each of these providers supports a
 * simple bearer-token "who am I" call, so a pasted personal/bot token is
 * enough to prove (and use) a real connection:
 *   - Slack: a bot/user token  -> POST slack.com/api/auth.test
 *   - GitHub: a PAT            -> GET api.github.com/user
 *   - Notion: an integration token -> POST api.notion.com/v1/users/me
 *
 * Google Drive and a generic MCP server don't support plain static tokens
 * for user data (Drive needs OAuth; an MCP server needs its own transport),
 * so those stay `verification: "simulated"` in db.ts -- that's disclosed to
 * the user rather than faked as a real connection.
 */
export interface VerifyResult {
  ok: boolean;
  accountLabel?: string;
  error?: string;
}

/** How long a provider gets to answer a verification (OMNIPILOT_PROVIDER_TIMEOUT_MS, default 10 s). */
const providerTimeoutMs = () => Number(process.env.OMNIPILOT_PROVIDER_TIMEOUT_MS ?? 10_000) || 10_000;

/** A provider that never answers must not leave the request (and the user) waiting forever. */
async function safeFetchJson(url: string, init: RequestInit): Promise<{ status: number; data: any }> {
  const signal = AbortSignal.timeout(providerTimeoutMs());
  try {
    const res = await fetch(url, { ...init, signal });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  } catch (err: any) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError" || signal.aborted) throw new Error("provider_timeout: the provider didn't answer in time");
    throw err;
  }
}

export async function verifySlackToken(token: string): Promise<VerifyResult> {
  try {
    const { data } = await safeFetchJson("https://slack.com/api/auth.test", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (data.ok) return { ok: true, accountLabel: `${data.team ?? "Slack"} workspace (@${data.user ?? "unknown"})` };
    return { ok: false, error: data.error ?? "invalid_auth" };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "network_error" };
  }
}

export async function verifyGithubToken(token: string): Promise<VerifyResult> {
  try {
    const { status, data } = await safeFetchJson("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": "OmniPilot", Accept: "application/vnd.github+json" },
    });
    if (status === 200 && data.login) return { ok: true, accountLabel: `@${data.login}` };
    return { ok: false, error: data.message ?? `http_${status}` };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "network_error" };
  }
}

export async function verifyNotionToken(token: string): Promise<VerifyResult> {
  try {
    const { status, data } = await safeFetchJson("https://api.notion.com/v1/users/me", {
      headers: { Authorization: `Bearer ${token}`, "Notion-Version": "2022-06-28" },
    });
    if (status === 200) return { ok: true, accountLabel: data.name ?? data.bot?.owner?.user?.name ?? "Notion integration" };
    return { ok: false, error: data.message ?? `http_${status}` };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "network_error" };
  }
}

/** Google Calendar: the "token" is the calendar's secret iCal address; it's verified by reading it. */
export async function verifyCalendarLink(link: string): Promise<VerifyResult> {
  try {
    const ics = await fetchIcs(link);
    return { ok: true, accountLabel: calendarName(ics) ?? "your calendar" };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "couldn't read that calendar" };
  }
}

const VERIFIERS: Record<string, (token: string) => Promise<VerifyResult>> = {
  Slack: verifySlackToken,
  GitHub: verifyGithubToken,
  Notion: verifyNotionToken,
  "Google Calendar": verifyCalendarLink,
};

export function verifierFor(connectorName: string): ((token: string) => Promise<VerifyResult>) | null {
  return VERIFIERS[connectorName] ?? null;
}
