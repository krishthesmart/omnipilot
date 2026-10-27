import crypto from "node:crypto";
import { getConnectorInternal, setConnectorVerified } from "../db.js";
import { registerExecutor } from "./actions.js";
import { publicOrigin } from "./ownerAuth.js";

// Google Drive, for real, for free: Google's own sign-in (OAuth 2.0 for desktop apps, with PKCE).
// The user creates a free OAuth client ID in Google Cloud (a "Desktop app" client; steps on the
// Drive card), pastes it here once, and signs in with Google. Google then redirects back to
// OmniPilot on this computer (http://localhost:<port>/api/oauth/google/callback).
//
// Permissions requested:
//   - drive.readonly: search and read your files (OmniPilot never changes or deletes them);
//   - drive.file: create NEW files (a Google Doc of a study plan, notes, code) -- only when you
//     approve, and only files OmniPilot created.
// Tokens stay in OmniPilot's local database and are never shown to the AI or the app.

export const DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive.readonly", "https://www.googleapis.com/auth/drive.file", "openid", "email"];
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const timeout = () => AbortSignal.timeout(Number(process.env.OMNIPILOT_PROVIDER_TIMEOUT_MS ?? 15_000) || 15_000);

interface Pending {
  verifier: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  at: number;
}
/** Sign-ins started in the last 10 minutes, by their random state value. */
const pending = new Map<string, Pending>();

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A local page origin the redirect may go back to (never another site). */
export const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/;

/** Starts a sign-in: returns Google's consent page address. */
export function startDriveAuth(clientId: string, clientSecret: string, origin: string): string {
  if (!LOCAL_ORIGIN.test(origin) && origin !== publicOrigin()) throw new Error("Sign-in must be started from OmniPilot itself.");
  if (!/\.apps\.googleusercontent\.com$/.test(clientId.trim())) throw new Error('That isn\'t a Google OAuth client ID (it ends with ".apps.googleusercontent.com").');
  for (const [k, v] of pending) if (Date.now() - v.at > 10 * 60_000) pending.delete(k);
  const state = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(48));
  const redirectUri = `${origin}/api/oauth/google/callback`;
  pending.set(state, { verifier, clientId: clientId.trim(), clientSecret: clientSecret.trim(), redirectUri, at: Date.now() });
  const params = new URLSearchParams({
    client_id: clientId.trim(),
    redirect_uri: redirectUri,
    response_type: "code",
    scope: DRIVE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
    code_challenge: b64url(crypto.createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
  });
  return `${AUTH_URL}?${params}`;
}

interface Tokens {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
}

async function tokenRequest(body: Record<string, string>): Promise<any> {
  const res = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body), signal: timeout() });
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(data.error_description ?? data.error ?? `Google answered HTTP ${res.status}`);
  return data;
}

/** Finishes a sign-in (Google redirected back with a code): saves the connection. */
export async function finishDriveAuth(code: string, state: string): Promise<{ account: string }> {
  const p = pending.get(state);
  pending.delete(state);
  if (!p || Date.now() - p.at > 10 * 60_000) throw new Error("This sign-in link expired or wasn't started here. Start again from the Google Drive card.");
  const t = await tokenRequest({ code, client_id: p.clientId, client_secret: p.clientSecret, redirect_uri: p.redirectUri, grant_type: "authorization_code", code_verifier: p.verifier });
  if (!t.refresh_token) throw new Error("Google didn't grant offline access. Remove OmniPilot's access in your Google Account and sign in again.");
  const tokens: Tokens = { clientId: p.clientId, clientSecret: p.clientSecret, refreshToken: t.refresh_token, accessToken: t.access_token, expiresAt: Date.now() + (Number(t.expires_in) || 3600) * 1000 };
  const about = await fetch(`${API}/about?fields=user(emailAddress,displayName)`, { headers: { Authorization: `Bearer ${tokens.accessToken}` }, signal: timeout() }).then((r) => r.json() as Promise<any>).catch(() => ({}) as any);
  const account = about?.user?.emailAddress ?? about?.user?.displayName ?? "your Google account";
  setConnectorVerified("Google Drive", account, JSON.stringify(tokens));
  return { account };
}

function stored(): Tokens {
  const c = getConnectorInternal("Google Drive");
  if (c?.status !== "connected" || !c.secret_token) throw new Error("Google Drive isn't connected.");
  return JSON.parse(c.secret_token);
}

export const driveConnected = () => getConnectorInternal("Google Drive")?.status === "connected";

/** A valid access token (refreshed when it's about to expire). */
async function accessToken(): Promise<string> {
  const t = stored();
  if (t.accessToken && t.expiresAt - Date.now() > 60_000) return t.accessToken;
  const r = await tokenRequest({ client_id: t.clientId, client_secret: t.clientSecret, refresh_token: t.refreshToken, grant_type: "refresh_token" }).catch((e) => {
    throw new Error(`Google Drive needs you to sign in again (${e.message}).`);
  });
  const next = { ...t, accessToken: r.access_token, expiresAt: Date.now() + (Number(r.expires_in) || 3600) * 1000 };
  const c = getConnectorInternal("Google Drive");
  setConnectorVerified("Google Drive", c?.account_label ?? "Google Drive", JSON.stringify(next));
  return next.accessToken;
}

async function api(url: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${await accessToken()}` }, signal: timeout() });
  if (res.status === 401) throw new Error("Google Drive needs you to sign in again.");
  if (res.status === 403) {
    const d = (await res.clone().json().catch(() => ({}))) as any;
    throw new Error(`Google Drive refused: ${d?.error?.message ?? "permission denied"}`);
  }
  return res;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  webViewLink?: string;
  size?: string;
}

const KIND: Record<string, string> = {
  "application/vnd.google-apps.document": "Google Doc",
  "application/vnd.google-apps.spreadsheet": "Google Sheet",
  "application/vnd.google-apps.presentation": "Google Slides",
  "application/vnd.google-apps.folder": "folder",
  "application/pdf": "PDF",
};
export const kindOf = (mime: string) => KIND[mime] ?? (mime.startsWith("text/") ? "text file" : mime.split("/").pop() ?? "file");

const q = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

/** Files whose name or text matches, newest first (or the most recent files when `text` is empty). */
export async function searchDrive(text: string, limit = 10): Promise<DriveFile[]> {
  const words = text.trim();
  const query = words ? `trashed = false and (name contains '${q(words)}' or fullText contains '${q(words)}')` : "trashed = false and mimeType != 'application/vnd.google-apps.folder'";
  const params = new URLSearchParams({ q: query, pageSize: String(limit), fields: "files(id,name,mimeType,modifiedTime,webViewLink,size)", ...(words ? {} : { orderBy: "modifiedTime desc" }), supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
  const res = await api(`${API}/files?${params}`);
  const d = (await res.json()) as any;
  if (!res.ok) throw new Error(d?.error?.message ?? `Drive search failed (HTTP ${res.status})`);
  const files: DriveFile[] = d.files ?? [];
  // Name matches first, then text matches.
  const lw = words.toLowerCase();
  return files.sort((a, b) => Number(b.name.toLowerCase().includes(lw)) - Number(a.name.toLowerCase().includes(lw)));
}

/** The Drive file id in a Google Docs/Sheets/Slides/Drive link, if any. */
export function driveIdFromLink(text: string): string | null {
  return (
    /(?:docs|drive|sheets|slides)\.google\.com\/(?:a\/[^/]+\/)?(?:document|spreadsheets|presentation|file|forms)\/(?:u\/\d+\/)?d\/(?:e\/)?([\w-]{20,})/.exec(text)?.[1] ??
    /drive\.google\.com\/(?:open|uc)\?(?:[^ ]*&)?id=([\w-]{20,})/.exec(text)?.[1] ??
    null
  );
}

/** A file by id (one the signed-in account can open). */
export async function getDriveFile(id: string): Promise<DriveFile> {
  const res = await api(`${API}/files/${encodeURIComponent(id)}?fields=id,name,mimeType,modifiedTime,webViewLink,size&supportsAllDrives=true`);
  const d = (await res.json().catch(() => ({}))) as any;
  if (res.status === 404) throw new Error("That file isn't in your Drive or shared with your Google account.");
  if (!res.ok) throw new Error(d?.error?.message ?? `Couldn't open the file (HTTP ${res.status}).`);
  return d as DriveFile;
}

/** A file's text: Docs/Slides as plain text, Sheets as CSV, text files as they are. */
export async function readDriveFile(f: DriveFile, maxChars = 60_000): Promise<string> {
  const exportAs: Record<string, string> = {
    "application/vnd.google-apps.document": "text/plain",
    "application/vnd.google-apps.presentation": "text/plain",
    "application/vnd.google-apps.spreadsheet": "text/csv",
  };
  let url: string;
  if (exportAs[f.mimeType]) url = `${API}/files/${f.id}/export?mimeType=${encodeURIComponent(exportAs[f.mimeType])}`;
  else if (f.mimeType.startsWith("text/") || /json|xml|javascript|x-python|csv|markdown/.test(f.mimeType)) url = `${API}/files/${f.id}?alt=media`;
  else throw new Error(`${f.name} is a ${kindOf(f.mimeType)}, which OmniPilot can't read as text yet (it reads Google Docs, Sheets, Slides and text files).`);
  const res = await api(url);
  if (!res.ok) throw new Error(`Couldn't read ${f.name} (HTTP ${res.status}).`);
  return (await res.text()).replace(/\r/g, "").slice(0, maxChars);
}

/** Creates a new Google Doc from text (only when the user approves). */
export async function createDriveDoc(title: string, text: string): Promise<{ id: string; link: string }> {
  const boundary = `omnipilot-${crypto.randomBytes(8).toString("hex")}`;
  const body = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify({ name: title, mimeType: "application/vnd.google-apps.document" }),
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    text,
    `--${boundary}--`,
  ].join("\r\n");
  const res = await api(`${UPLOAD}/files?uploadType=multipart&fields=id,webViewLink`, { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body });
  const d = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(d?.error?.message ?? `Couldn't create the doc (HTTP ${res.status}).`);
  return { id: d.id, link: d.webViewLink ?? `https://docs.google.com/document/d/${d.id}/edit` };
}

/** Signs out: tells Google to revoke OmniPilot's access (best effort). */
export async function revokeDrive(): Promise<void> {
  try {
    const t = stored();
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t.refreshToken)}`, { method: "POST", signal: timeout() });
  } catch {
    // already gone
  }
}

registerExecutor("drive_create_doc", async (p: { title: string; text: string }) => {
  const doc = await createDriveDoc(p.title, p.text);
  return { ok: true, message: `Created the Google Doc "${p.title}" in your Drive.`, url: doc.link };
});
