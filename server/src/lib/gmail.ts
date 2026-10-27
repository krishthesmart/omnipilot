import { getConnectorInternal } from "../db.js";
import { registerExecutor } from "./actions.js";
import { openImap, type Email, type ImapLogin } from "./imap.js";
import type { VerifyResult } from "./integrations.js";

// Gmail, read-only, for free: IMAP with a Google "app password". OmniPilot reads (never marks as
// read, moves or deletes) and can save a draft for the user to send from Gmail themselves. It never
// sends email.

export const GMAIL_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Tests replace the network connection with a fake IMAP server. */
let connectOverride: ImapLogin["connect"] | undefined;
export const setImapConnector = (c: ImapLogin["connect"] | undefined) => (connectOverride = c);

const login = (user: string, pass: string): ImapLogin => ({ user, pass: pass.replace(/\s+/g, ""), connect: connectOverride });

/** Checks an address + app password by signing in and opening the inbox (read-only). */
export async function verifyGmail(address: string, appPassword: string): Promise<VerifyResult> {
  if (!GMAIL_ADDRESS.test(address)) return { ok: false, error: "Enter your Gmail address." };
  try {
    const s = await openImap(login(address, appPassword));
    const count = await s.examine("INBOX");
    await s.logout();
    return { ok: true, accountLabel: `${address} (${count.toLocaleString("en-US")} messages in the inbox)` };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "couldn't sign in" };
  }
}

function credentials(): { user: string; pass: string } {
  const c = getConnectorInternal("Gmail");
  if (c?.status !== "connected" || !c.secret_token) throw new Error("Gmail isn't connected.");
  const { address, password } = JSON.parse(c.secret_token);
  return { user: address, pass: password };
}

export const gmailConnected = () => getConnectorInternal("Gmail")?.status === "connected";

/** The newest `limit` messages matching a Gmail search (e.g. "is:unread newer_than:1d"). */
export async function readMail(query: string, limit = 12): Promise<Email[]> {
  const { user, pass } = credentials();
  const s = await openImap(login(user, pass));
  try {
    await s.examine("INBOX");
    const uids = (await s.search(query, "UNSEEN")).sort((a, b) => b - a).slice(0, limit);
    const mail = await s.fetch(uids);
    return mail.sort((a, b) => b.uid - a.uid);
  } finally {
    await s.logout();
  }
}

export interface Draft {
  to: string;
  subject: string;
  body: string;
}

const headerWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);

export function draftMessage(from: string, d: Draft): string {
  return [
    `From: ${from}`,
    `To: ${d.to}`,
    `Subject: ${headerWord(d.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(d.body, "utf8").toString("base64").replace(/.{76}/g, "$&\n"),
  ].join("\n");
}

registerExecutor("gmail_draft", async (d: Draft) => {
  const { user, pass } = credentials();
  const s = await openImap(login(user, pass));
  try {
    await s.appendDraft(draftMessage(user, d));
  } finally {
    await s.logout();
  }
  return { ok: true, message: `Saved a draft to ${d.to} in Gmail. Open Gmail's Drafts to review and send it.`, url: "https://mail.google.com/mail/u/0/#drafts" };
});
