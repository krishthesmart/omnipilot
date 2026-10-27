import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { getSetting, setSetting } from "../db.js";

// Signing in, for when OmniPilot runs on a server (so it keeps working while your computer is off).
// On your own computer nothing changes: requests from this computer need no password. When
// OMNIPILOT_PASSWORD is set (12+ characters), requests from anywhere else need you to sign in once
// with it; the browser then keeps a session cookie for 30 days.
//   - The cookie is HttpOnly (page scripts can't read it), Secure on https, and SameSite=Lax.
//   - Sessions are signed with a key made from the password and a random secret kept in the
//     database, so changing the password signs every device out.
//   - Anything that changes something must come from OmniPilot's own address (OMNIPILOT_PUBLIC_URL):
//     another website can't act through your session.
//   - Wrong passwords are slowed down (10 tries per 15 minutes per address).

export const SESSION_COOKIE = "omnipilot_session";
const SESSION_DAYS = 30;

export const ownerPassword = (): string | null => {
  const p = process.env.OMNIPILOT_PASSWORD ?? "";
  return p.length >= 12 ? p : null;
};

/** OmniPilot's public address when hosted (e.g. https://my-omnipilot.fly.dev), as an origin. */
export function publicOrigin(): string | null {
  const raw = process.env.OMNIPILOT_PUBLIC_URL?.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return /^https?:$/.test(u.protocol) ? u.origin : null;
  } catch {
    return null;
  }
}

function signingKey(): Buffer {
  let secret = getSetting("authSecret");
  if (!secret) {
    secret = randomBytes(32).toString("hex");
    setSetting("authSecret", secret);
  }
  return createHash("sha256").update(`${secret}:${ownerPassword() ?? ""}`).digest();
}

const sign = (payload: string) => createHmac("sha256", signingKey()).update(payload).digest("base64url");

export function issueSession(): string {
  const exp = Date.now() + SESSION_DAYS * 86_400_000;
  const payload = `${exp}.${randomBytes(9).toString("base64url")}`;
  return `${payload}.${sign(payload)}`;
}

function cookieValue(req: Request, name: string): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

/** A signed-in browser (password set, valid, unexpired session). */
export function hasOwnerSession(req: Request): boolean {
  if (!ownerPassword()) return false;
  const token = cookieValue(req, SESSION_COOKIE);
  if (!token) return false;
  const i = token.lastIndexOf(".");
  if (i < 0) return false;
  const [payload, sig] = [token.slice(0, i), token.slice(i + 1)];
  const expected = sign(payload);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  return Number(payload.split(".")[0]) > Date.now();
}

export function checkPassword(input: string): boolean {
  const expected = ownerPassword();
  if (!expected) return false;
  const d = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(d(input), d(expected));
}

/** Secure cookies whenever the visitor came over https (the public address, or a proxy saying so). */
const secure = (req: Request) => (publicOrigin()?.startsWith("https://") ?? false) || req.secure || req.get("x-forwarded-proto") === "https";

export function setSessionCookie(req: Request, res: Response, token: string) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86_400}${secure(req) ? "; Secure" : ""}`);
}

export function clearSessionCookie(req: Request, res: Response) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure(req) ? "; Secure" : ""}`);
}

/** Paths anyone may reach without signing in: the sign-in itself, health, and the app's page and assets (no data). */
export const isOpenPath = (req: Request) =>
  (req.method === "POST" && req.path === "/api/login") || (req.method === "GET" && (req.path === "/api/health" || req.path === "/api/auth" || !req.path.startsWith("/api/")));

// Wrong-password slowdown, per client address.
const attempts = new Map<string, number[]>();
export function loginAllowed(ip: string): boolean {
  const now = Date.now();
  const recent = (attempts.get(ip) ?? []).filter((t) => now - t < 15 * 60_000);
  attempts.set(ip, recent);
  return recent.length < 10;
}
export const noteFailedLogin = (ip: string) => attempts.set(ip, [...(attempts.get(ip) ?? []), Date.now()]);
