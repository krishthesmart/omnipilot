import crypto from "node:crypto";
import { getWatcherRow, saveWatcherRow } from "../db.js";
import { generateJson } from "./llm.js";

// WatcherPilot's rules engine: given the parent's focus policy ("learn math,
// no AI"), decide whether a page may load. The browser extension asks this
// for every navigation; it also hard-blocks AI domains on its own so blocking
// keeps working if OmniPilot isn't running.

export type Subject = "math" | "reading" | "writing" | "science" | "coding" | "history" | "languages";

export interface WatcherPolicy {
  active: boolean;
  /** The parent's words, e.g. "learn math". */
  task: string;
  subject: Subject | null;
  blockAI: boolean;
  blockAIExtensions: boolean;
  /** Only pages related to the task may load (GoGuardian-style "on task" mode). */
  onTaskOnly: boolean;
  allow: string[];
  block: string[];
  /** ISO time the session ends; null = until a parent turns it off. */
  until: string | null;
}

export interface WatcherDecision {
  decision: "allow" | "block";
  reason: string;
  category: "ai" | "settings" | "distraction" | "off_task" | "parent_rule" | "on_task" | "safe" | "inactive";
}

export const DEFAULT_POLICY: WatcherPolicy = {
  active: false,
  task: "",
  subject: null,
  blockAI: true,
  blockAIExtensions: true,
  onTaskOnly: true,
  allow: [],
  block: [],
  until: null,
};

/** AI chatbots/assistants and answer-solvers (a solver does the learning for you). */
export const AI_DOMAINS = [
  "chatgpt.com", "chat.openai.com", "openai.com", "claude.ai", "gemini.google.com", "bard.google.com", "aistudio.google.com",
  "notebooklm.google.com", "copilot.microsoft.com", "perplexity.ai", "poe.com", "character.ai", "you.com", "phind.com",
  "deepseek.com", "chat.mistral.ai", "huggingface.co", "meta.ai", "grok.com", "x.ai", "chat.qwen.ai", "kimi.com", "pi.ai",
  "quillbot.com", "jasper.ai", "writesonic.com", "copy.ai", "rytr.me", "chatpdf.com", "humata.ai", "monica.im", "merlin.foyer.work",
  "photomath.com", "mathway.com", "symbolab.com", "gauthmath.com", "brainly.com", "chegg.com", "socratic.org", "wolframalpha.com",
  "mathgptpro.com", "studyx.ai", "answer.ai", "questionai.com", "homeworkify.net",
];
/** AI features living on otherwise-normal sites. */
const AI_PATHS: { host: string; path: RegExp }[] = [
  { host: "bing.com", path: /^\/(chat|copilot)/ },
  { host: "google.com", path: /[?&]udm=50\b/ }, // Google "AI Mode"
];

/** Sites that are almost never part of schoolwork. */
const DISTRACTIONS = [
  "tiktok.com", "instagram.com", "snapchat.com", "facebook.com", "x.com", "twitter.com", "reddit.com", "discord.com", "twitch.tv",
  "netflix.com", "disneyplus.com", "hulu.com", "roblox.com", "fortnite.com", "epicgames.com", "steampowered.com", "minecraft.net",
  "poki.com", "crazygames.com", "coolmathgames.com", "friv.com", "miniclip.com", "pinterest.com", "9gag.com",
];

const SUBJECT_SITES: Record<Subject, string[]> = {
  math: ["khanacademy.org", "desmos.com", "geogebra.org", "mathsisfun.com", "ixl.com", "prodigygame.com", "mathplayground.com", "brilliant.org", "purplemath.com", "zearn.org"],
  reading: ["khanacademy.org", "readworks.org", "commonlit.org", "newsela.com", "epic.com", "gutenberg.org", "storylineonline.net"],
  writing: ["khanacademy.org", "docs.google.com", "readwritethink.org", "owl.purdue.edu", "merriam-webster.com", "thesaurus.com"],
  science: ["khanacademy.org", "phet.colorado.edu", "nasa.gov", "ck12.org", "sciencebuddies.org", "nationalgeographic.com", "britannica.com"],
  coding: ["code.org", "scratch.mit.edu", "khanacademy.org", "developer.mozilla.org", "w3schools.com", "freecodecamp.org", "replit.com"],
  history: ["khanacademy.org", "britannica.com", "loc.gov", "history.com", "smithsonianmag.com", "nationalgeographic.com"],
  languages: ["duolingo.com", "khanacademy.org", "wordreference.com", "spanishdict.com", "busuu.com"],
};

const SUBJECT_WORDS: Record<Subject, RegExp> = {
  math: /\b(math|maths|algebra|geometry|fraction|decimal|multipl|divis|addition|subtract|equation|arithmetic|calculus|trigonometry|percent|graph|number|times table|integer|ratio|statistic|probability)/i,
  reading: /\b(reading|read aloud|story|stories|book|novel|poem|poetry|comprehension|vocabulary|phonics)/i,
  writing: /\b(writing|essay|grammar|paragraph|spelling|punctuation|dictionary|thesaurus)/i,
  science: /\b(science|biology|chemistry|physics|experiment|planet|cell|atom|ecosystem|photosynthesis|energy|earth|weather)/i,
  coding: /\b(coding|programming|code|javascript|python|scratch|html|css|algorithm)/i,
  history: /\b(history|historical|ancient|war|revolution|civilization|president|empire|timeline)/i,
  languages: /\b(spanish|french|german|chinese|japanese|language|vocabulary|grammar|conjugat)/i,
};

const SEARCH_ENGINES = ["google.com", "bing.com", "duckduckgo.com", "search.yahoo.com", "kiddle.co"];

// --- Policy parsing ("learn math and no AI for 1 hour") ----------------------------

export function parseFocusRequest(text: string, now = new Date()): Partial<WatcherPolicy> {
  const subject = (Object.keys(SUBJECT_WORDS) as Subject[]).find((s) => new RegExp(`\\b${s}`, "i").test(text) || SUBJECT_WORDS[s].test(text)) ?? null;
  const noAI = /\bno (ai|a\.i\.|chatgpt|chat ?bots?)\b|\bblock (all )?ai\b|\bwithout ai\b/i.test(text);
  const minutes = (() => {
    const m = text.match(/\b(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/i);
    if (!m) return null;
    return /^h/i.test(m[2]) ? Number(m[1]) * 60 : Number(m[1]);
  })();
  const taskMatch = text.match(/\b(learn|study|practice|do|work on|focus on|read|write)\b[^,.;]*?(?=\s+(?:and|but|with|for)\s+(?:no|without|block|\d)|[,.;]|$)/i);
  return {
    task: (taskMatch?.[0] ?? (subject ? `learn ${subject}` : text)).trim().slice(0, 120),
    subject,
    blockAI: noAI || DEFAULT_POLICY.blockAI,
    onTaskOnly: true,
    until: minutes ? new Date(now.getTime() + minutes * 60_000).toISOString() : null,
  };
}

// --- Policy storage + parent PIN ------------------------------------------------------

export function getPolicy(): WatcherPolicy {
  const row = getWatcherRow();
  const policy: WatcherPolicy = row ? { ...DEFAULT_POLICY, ...JSON.parse(row.data) } : { ...DEFAULT_POLICY };
  if (policy.active && policy.until && Date.parse(policy.until) <= Date.now()) policy.active = false;
  return policy;
}

export function hasPin(): boolean {
  return Boolean(getWatcherRow()?.pin_hash);
}

function hashPin(pin: string, salt = crypto.randomBytes(16).toString("hex")): string {
  return `${salt}:${crypto.scryptSync(pin, salt, 32).toString("hex")}`;
}

// Brute-force guard: 5 wrong PINs locks changes for 5 minutes.
let failedAttempts: number[] = [];
const LOCK_WINDOW_MS = 5 * 60_000;

export function pinLocked(): boolean {
  failedAttempts = failedAttempts.filter((t) => Date.now() - t < LOCK_WINDOW_MS);
  return failedAttempts.length >= 5;
}

export function verifyPin(pin: string): boolean {
  const stored = getWatcherRow()?.pin_hash;
  if (!stored || pinLocked()) return false;
  const [salt, hash] = stored.split(":");
  const candidate = crypto.scryptSync(pin, salt, 32);
  const ok = crypto.timingSafeEqual(candidate, Buffer.from(hash, "hex"));
  if (!ok) failedAttempts.push(Date.now());
  return ok;
}

export const PIN_FORMAT = /^\d{4,8}$/;

/** Saves the policy. The first save sets the PIN; later saves must present it. */
export function savePolicy(policy: WatcherPolicy, pin: string, newPin?: string): { ok: true } | { ok: false; error: string } {
  const row = getWatcherRow();
  if (row?.pin_hash) {
    if (pinLocked()) return { ok: false, error: "locked" };
    if (!verifyPin(pin)) return { ok: false, error: "wrong_pin" };
  } else if (!PIN_FORMAT.test(pin)) {
    return { ok: false, error: "pin_required" };
  }
  const pinToStore = newPin && PIN_FORMAT.test(newPin) ? newPin : row?.pin_hash ? null : pin;
  saveWatcherRow(policy, pinToStore ? hashPin(pinToStore) : row!.pin_hash);
  verdictCache.clear();
  return { ok: true };
}

// --- Classification -----------------------------------------------------------------------

function hostMatches(host: string, domains: string[]): string | undefined {
  return domains.find((d) => host === d || host.endsWith(`.${d}`));
}

const verdictCache = new Map<string, WatcherDecision>();

/** Pages that must always work: browser internals (except settings), OmniPilot itself, the extension's own pages. */
const SAFE_PROTOCOLS = /^(chrome-extension|moz-extension|edge-extension|about|data|blob|file):/i;
const BROWSER_SETTINGS = /^(chrome|edge|brave|opera|vivaldi):\/\/(extensions|settings\/(reset|clearBrowserData))|^about:(addons|debugging|config)/i;

export async function classifyPage(policy: WatcherPolicy, rawUrl: string, title = ""): Promise<WatcherDecision> {
  if (!policy.active) return { decision: "allow", reason: "No focus session is running.", category: "inactive" };

  // Turning the extension off is the first thing a kid tries; GoGuardian blocks the extensions page too.
  if (BROWSER_SETTINGS.test(rawUrl)) {
    return { decision: "block", reason: "Browser extension settings are locked during focus time. Ask a parent.", category: "settings" };
  }
  if (SAFE_PROTOCOLS.test(rawUrl) || /^(chrome|edge|brave|opera|vivaldi):\/\//i.test(rawUrl)) {
    return { decision: "allow", reason: "Browser page.", category: "safe" };
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { decision: "allow", reason: "Not a web page.", category: "safe" };
  }
  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  if (host === "localhost" || host === "127.0.0.1") return { decision: "allow", reason: "OmniPilot.", category: "safe" };

  if (hostMatches(host, policy.block)) return { decision: "block", reason: `A parent blocked ${host}.`, category: "parent_rule" };
  if (hostMatches(host, policy.allow)) return { decision: "allow", reason: `A parent allowed ${host}.`, category: "parent_rule" };

  if (policy.blockAI) {
    const ai = hostMatches(host, AI_DOMAINS) ?? AI_PATHS.find((p) => (host === p.host || host.endsWith(`.${p.host}`)) && p.path.test(url.pathname + url.search))?.host;
    if (ai) return { decision: "block", reason: `AI tools and answer solvers are off for "${policy.task}".`, category: "ai" };
  }

  if (!policy.onTaskOnly) return { decision: "allow", reason: "Only AI tools are blocked right now.", category: "on_task" };

  if (hostMatches(host, DISTRACTIONS)) return { decision: "block", reason: `${host} isn't part of "${policy.task}".`, category: "distraction" };
  if (policy.subject && hostMatches(host, SUBJECT_SITES[policy.subject])) {
    return { decision: "allow", reason: `${host} is a ${policy.subject} learning site.`, category: "on_task" };
  }
  if (hostMatches(host, SEARCH_ENGINES)) return { decision: "allow", reason: "Search is allowed; the pages it leads to are checked.", category: "safe" };

  // Everything else (YouTube, Wikipedia, blogs...) is judged by what the page is about.
  const text = `${host} ${decodeURIComponent(url.pathname + url.search).replace(/[/_+-]/g, " ")} ${title}`;
  if (policy.subject && SUBJECT_WORDS[policy.subject].test(text)) {
    return { decision: "allow", reason: `This page looks like ${policy.subject}.`, category: "on_task" };
  }

  const key = `${host}|${title}|${policy.task}`;
  const cached = verdictCache.get(key);
  if (cached) return cached;

  const verdict = await generateJson<{ on_task: boolean }>(
    "You help a parent keep a child focused. Decide whether this web page is useful for the child's assigned task. " +
      "Games, social media, entertainment and chatting are not on task. Answer on_task: true only if the page clearly helps with the task.",
    `Assigned task: ${policy.task}\nPage: ${host}\nTitle: ${title || "(unknown)"}\nURL path: ${url.pathname}`,
    { schema: { type: "object", properties: { on_task: { type: "boolean" } }, required: ["on_task"] }, temperature: 0, maxTokens: 20 }
  );
  // Without the model, unknown pages are blocked (on-task mode is an allowlist); a parent can allow a site.
  const decision: WatcherDecision = verdict?.on_task
    ? { decision: "allow", reason: `This page looks useful for "${policy.task}".`, category: "on_task" }
    : { decision: "block", reason: `This page doesn't look like part of "${policy.task}". A parent can allow it.`, category: "off_task" };
  if (verdict) verdictCache.set(key, decision);
  return decision;
}

/** Extension names/descriptions that look like AI assistants (the extension disables these during a session). */
export const AI_EXTENSION_PATTERN =
  "\\b(chatgpt|gpt|openai|gemini|copilot|claude|perplexity|monica|merlin|sider|maxai|harpa|quillbot|grammarly|photomath|gauth|brainly|ai (assistant|writer|chat|tutor|helper|homework))\\b|\\bAI\\b";
