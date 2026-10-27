import type { NextFunction, Request, Response } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { hasOwnerSession, isOpenPath, ownerPassword, publicOrigin } from "./ownerAuth.js";

// OmniPilot is a local app: the API must only be usable by OmniPilot's own
// UI and the Watcher browser extension running on this computer -- never by
// another device on the network or by some other website open in the
// browser (which could otherwise make CodePilot write and run code, or read
// connector state).

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const EXTENSION_ORIGIN = /^(chrome|moz)-extension:\/\/[a-z0-9-]+$/i;

/** Extra origins allowed via OMNIPILOT_ALLOWED_ORIGINS (comma-separated), for unusual setups. */
const extraOrigins = () => (process.env.OMNIPILOT_ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean);

/**
 * Optional access for SDK clients on other devices (a Raspberry Pi, an ESP32):
 * set OMNIPILOT_API_TOKEN (16+ characters) and send `Authorization: Bearer <token>`.
 * A token only opens the question-answering endpoints -- never integrations,
 * approvals or Watcher settings -- and never for web pages (no browser Origin).
 */
export const apiToken = () => {
  const t = process.env.OMNIPILOT_API_TOKEN?.trim();
  return t && t.length >= 16 ? t : null;
};
// No run list for tokens: an SDK client reads only runs it started, by ID plus that run's key.
const SDK_PATHS = /^\/api\/(ask|chat|runs\/[\w-]+(\/events(\.json)?)?|status|health|math\/(status|discoveries|check))$/;

function tokenMatches(header: string | undefined): boolean | null {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? "");
  if (!m) return null;
  const expected = apiToken();
  if (!expected) return false;
  // Compare fixed-length digests so neither length nor content leaks through timing.
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(m[1].trim()), digest(expected));
}

/** Headers a reverse proxy adds: such a request may have come from anywhere, even over loopback. */
// Cloudflare's own headers count too: a Cloudflare Tunnel connects from this computer, but its
// visitors are on the internet.
const PROXY_HEADERS = ["x-forwarded-for", "forwarded", "x-real-ip", "x-forwarded-host", "cf-connecting-ip", "cf-ray"];
/** Set by the Python front door (only trusted alongside the internal secret): it saw a local client. */
export const FRONT_DOOR_LOCAL_HEADER = "x-omnipilot-client-local";

const isLoopbackAddress = (addr: string | undefined) => !!addr && /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/.test(addr);

/**
 * Whether the request really comes from this computer: decided by the connection's address,
 * never by the Host header (which any client can set). A proxied request isn't proof either.
 * Behind the front door, the front door's own verdict is used (it checked the real client).
 */
export function isLocalClient(req: Request, res: Response): boolean {
  if (res.locals.viaFrontDoor) return req.headers[FRONT_DOOR_LOCAL_HEADER] === "1";
  if (PROXY_HEADERS.some((h) => req.headers[h] !== undefined)) return false;
  return isLoopbackAddress(req.socket?.remoteAddress);
}

/**
 * Behind the Python front door (engine/), this server listens on an internal loopback port and
 * only serves requests carrying the per-launch internal secret, so nothing on the machine can
 * bypass the front door's checks. Without OMNIPILOT_INTERNAL_TOKEN it runs standalone, as before.
 */
export function internalOnly(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.OMNIPILOT_INTERNAL_TOKEN;
  if (!expected) return next();
  const sent = req.headers["x-omnipilot-internal"];
  const digest = (s: string) => createHash("sha256").update(s).digest();
  if (typeof sent !== "string" || !timingSafeEqual(digest(sent), digest(expected))) return res.status(403).json({ error: "internal_only" });
  res.locals.viaFrontDoor = true;
  next();
}

/**
 * Who may use the API:
 * - this computer (by connection address, see isLocalClient), from OmniPilot's own page, a tool
 *   without an Origin, or the Watcher extension for its two endpoints;
 * - an SDK client with OMNIPILOT_API_TOKEN, for question-answering only (res.locals.principal = "sdk").
 * The Host header is still checked as a DNS-rebinding defence; OMNIPILOT_ALLOW_ANY_HOST relaxes only
 * that check, never the requirement to be local or hold the token.
 */

/** The scheduler's wake-up call (a Cloudflare cron): POST /api/routines/run-due with the cron secret. */
function isCronCall(req: Request): boolean {
  const expected = process.env.OMNIPILOT_CRON_SECRET?.trim();
  const sent = req.headers["x-omnipilot-cron"];
  if (!expected || expected.length < 16 || typeof sent !== "string" || req.method !== "POST" || req.path !== "/api/routines/run-due") return false;
  const d = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(d(sent), d(expected));
}

export function localOnly(req: Request, res: Response, next: NextFunction) {
  if (isCronCall(req)) {
    res.locals.principal = "cron";
    return next();
  }
  const token = tokenMatches(req.headers.authorization);
  if (token === false) return res.status(401).json({ error: "invalid_token" });
  if (token === true) {
    if (req.headers.origin || !SDK_PATHS.test(req.path)) return res.status(403).json({ error: "forbidden_for_token" });
    res.locals.principal = "sdk";
    return next();
  }
  if (!isLocalClient(req, res)) {
    // Hosted on a server (OMNIPILOT_PASSWORD set): the owner signs in from any device.
    if (ownerPassword()) return ownerAccess(req, res, next);
    return res.status(401).json({ error: "token_required", message: "Requests from other devices need the API token." });
  }
  res.locals.principal = "local";
  const host = req.headers.host ?? "";
  if (!LOCAL_HOST.test(host) && process.env.OMNIPILOT_ALLOW_ANY_HOST !== "1") {
    return res.status(403).json({ error: "forbidden_host" });
  }
  const origin = req.headers.origin;
  if (origin && !LOCAL_ORIGIN.test(origin) && !extraOrigins().includes(origin)) {
    // Extensions may only use the Watcher endpoints they need.
    const extensionAllowed = EXTENSION_ORIGIN.test(origin) && /^\/api\/watcher\/(policy|check)$/.test(req.path) && (req.method === "GET" || req.path.endsWith("/check"));
    if (!extensionAllowed) return res.status(403).json({ error: "forbidden_origin" });
  }
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
}

/** A request from another device when OmniPilot is hosted: signed in, to OmniPilot's own address. */
function ownerAccess(req: Request, res: Response, next: NextFunction) {
  const pub = publicOrigin();
  // The address the visitor used: OmniPilot's free Worker passes it in its own header; other proxies
  // (Fly.io, a Cloudflare Worker) as X-Forwarded-Host, which Express reads as req.hostname.
  const viaWorker = req.get("x-omnipilot-forwarded-host");
  const visitorHost = viaWorker ?? req.get("x-forwarded-host") ?? req.headers.host ?? "";
  const visitorHostname = viaWorker ? viaWorker.replace(/:\d+$/, "") : req.hostname;
  // DNS-rebinding defence: with a public address set, the visitor must have used it.
  if (pub && visitorHostname !== new URL(pub).hostname) return res.status(403).json({ error: "forbidden_host" });
  // Another website can't act through the owner's session: changes must come from OmniPilot's own page
  // (its public address, or the same address the visitor is on, e.g. a Cloudflare Tunnel link).
  const origin = req.headers.origin;
  const sameSite = (() => {
    try {
      return Boolean(origin) && new URL(origin!).host === visitorHost;
    } catch {
      return false;
    }
  })();
  if (origin && origin !== pub && !sameSite && !LOCAL_ORIGIN.test(origin)) return res.status(403).json({ error: "forbidden_origin" });
  if (req.method !== "GET" && req.method !== "HEAD" && !origin && !req.path.startsWith("/api/login")) {
    // Browsers always send Origin on these; a missing one with a session cookie isn't our page.
    if (req.headers.cookie) return res.status(403).json({ error: "forbidden_origin" });
  }
  if (isOpenPath(req)) {
    res.locals.principal = "public";
    return next();
  }
  if (!hasOwnerSession(req)) return res.status(401).json({ error: "login_required", message: "Sign in to OmniPilot." });
  res.locals.principal = "owner";
  next();
}

/**
 * Headers for a web page CodePilot wrote, shown in the chat's preview frame. Its own scripts may run,
 * but the CSP sandbox gives it an opaque origin (no access to OmniPilot's API, cookies or storage, even
 * if opened directly), it can't load or send anything over the network, and only OmniPilot can frame it.
 * eval is allowed because generated calculators and games commonly use it; the sandbox contains it.
 */
export const PREVIEW_CSP =
  "sandbox allow-scripts allow-forms allow-modals; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'";
export const PREVIEW_PATH = /^\/api\/runs\/[\w-]+\/preview\/\d+$/;

export function securityHeaders(req: Request, res: Response, next: NextFunction) {
  if (PREVIEW_PATH.test(req.path)) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Content-Security-Policy", PREVIEW_CSP);
    return next();
  }
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
  );
  next();
}

/** Simple per-client sliding-window limiter: plenty for one person, stops runaway loops. */
export function rateLimit({ windowMs, max }: { windowMs: number; max: number }) {
  const hits = new Map<string, number[]>();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip ?? "local";
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      res.setHeader("Retry-After", Math.ceil(windowMs / 1000));
      return res.status(429).json({ error: "rate_limited" });
    }
    recent.push(now);
    hits.set(key, recent);
    next();
  };
}

/**
 * Express 4 doesn't catch a rejected promise from an async handler (the request would hang, or the
 * process crash on an unhandled rejection): this passes it to the error handler instead.
 */
export const asyncRoute =
  <R extends Request, S extends Response>(fn: (req: R, res: S, next: NextFunction) => Promise<unknown>) =>
  (req: R, res: S, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };

/** Last-resort error handler: client mistakes are 4xx; anything else is logged and returned without internals. */
export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  // A response that already started (a stream) can only be ended.
  if (res.headersSent) {
    console.error("Error after the response started:", err);
    return res.end();
  }
  if (err?.type === "entity.parse.failed") return res.status(400).json({ error: "invalid_json" });
  if (err?.type === "entity.too.large") return res.status(413).json({ error: "too_large" });
  // Errors Express marks as the client's (e.g. a URL with malformed %-encoding, which it can't decode).
  const status = Number(err?.status ?? err?.statusCode);
  if (status >= 400 && status < 500) return res.status(status).json({ error: "bad_request" });
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "internal_error" });
}
