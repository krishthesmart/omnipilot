// OmniPilot Watcher -- enforces the parent's focus session from OmniPilot.
//
// Works in Chrome, Edge, Brave, Opera and Firefox (Manifest V3). Firefox doesn't
// let extensions switch other extensions off, so that one feature is skipped there.
//
// Safety design:
// - AI sites are blocked by declarativeNetRequest rules built from the last policy
//   we received, so they stay blocked even if OmniPilot isn't running.
// - Every other page is checked with OmniPilot (/api/watcher/check) as it loads.
// - AI extensions are switched off for the session and switched back on after it.
// - The browser's extensions page is blocked during a session.
// Nothing here can change the rules: that needs the parent's PIN in OmniPilot.

const DEFAULT_SERVER = "http://localhost:8899";
const AI_RULE_BASE = 1000;
// Chromium browsers' extensions page, and Firefox's add-ons/debugging pages.
const SETTINGS_URL = /^(chrome|edge|brave|opera|vivaldi):\/\/(extensions|settings\/(reset|clearBrowserData))|^about:(addons|debugging)/i;

async function server() {
  const { serverUrl } = await chrome.storage.local.get("serverUrl");
  return (serverUrl || DEFAULT_SERVER).replace(/\/$/, "");
}

function sessionActive(policy) {
  return Boolean(policy && policy.active && (!policy.until || Date.parse(policy.until) > Date.now()));
}

function blockedPage(reason, category, url, task) {
  const q = new URLSearchParams({ reason, category, url: url || "", task: task || "" });
  return chrome.runtime.getURL(`blocked.html?${q}`);
}

// --- Policy sync ------------------------------------------------------------------

async function syncPolicy() {
  let data;
  try {
    const res = await fetch(`${await server()}/api/watcher/policy`, { cache: "no-store" });
    data = await res.json();
    await chrome.storage.local.set({ cached: data, lastSync: Date.now() });
  } catch {
    // OmniPilot unreachable: keep enforcing the last policy we had (fail closed for AI sites).
    data = (await chrome.storage.local.get("cached")).cached;
  }
  if (!data) return;
  await applyAiRules(data);
  await applyExtensionRules(data);
}

async function applyAiRules({ policy, aiDomains }) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.filter((r) => r.id >= AI_RULE_BASE).map((r) => r.id);
  const addRules =
    sessionActive(policy) && policy.blockAI
      ? [
          {
            id: AI_RULE_BASE,
            priority: 1,
            action: {
              type: "redirect",
              redirect: { extensionPath: `/blocked.html?category=ai&task=${encodeURIComponent(policy.task)}&reason=${encodeURIComponent("AI tools and answer solvers are off during focus time.")}` },
            },
            condition: { requestDomains: aiDomains, resourceTypes: ["main_frame", "sub_frame"] },
          },
        ]
      : [];
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
}

async function applyExtensionRules({ policy, aiExtensionPattern }) {
  const { disabledByWatcher = [] } = await chrome.storage.local.get("disabledByWatcher");
  if (sessionActive(policy) && policy.blockAIExtensions) {
    const pattern = new RegExp(aiExtensionPattern, "i");
    const all = await chrome.management.getAll();
    const targets = all.filter(
      (e) => e.type === "extension" && e.enabled && e.id !== chrome.runtime.id && e.mayDisable !== false && pattern.test(`${e.name} ${e.description}`)
    );
    for (const e of targets) {
      try {
        await chrome.management.setEnabled(e.id, false);
        disabledByWatcher.push(e.id);
      } catch {}
    }
    await chrome.storage.local.set({ disabledByWatcher: [...new Set(disabledByWatcher)] });
  } else if (disabledByWatcher.length) {
    // Session over: give back exactly what we switched off.
    for (const id of disabledByWatcher) {
      try {
        await chrome.management.setEnabled(id, true);
      } catch {}
    }
    await chrome.storage.local.set({ disabledByWatcher: [] });
  }
}

// --- Page checks ------------------------------------------------------------------------

const lastChecked = new Map(); // tabId -> url (avoid re-checking the same page)

async function checkTab(tabId, url, title) {
  if (!url || url.startsWith(chrome.runtime.getURL(""))) return;
  const { cached } = await chrome.storage.local.get("cached");
  const policy = cached && cached.policy;
  if (!sessionActive(policy)) return;

  if (SETTINGS_URL.test(url)) {
    chrome.tabs.update(tabId, { url: blockedPage("Browser extension settings are locked during focus time. Ask a parent.", "settings", "", policy.task) });
    return;
  }
  if (!/^https?:/i.test(url)) return;
  const key = `${url}|${title || ""}`;
  if (lastChecked.get(tabId) === key) return;
  lastChecked.set(tabId, key);

  try {
    const res = await fetch(`${await server()}/api/watcher/check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, title }),
    });
    const verdict = await res.json();
    if (verdict.decision === "block") {
      chrome.tabs.update(tabId, { url: blockedPage(verdict.reason, verdict.category, url, policy.task) });
    }
  } catch {
    // OmniPilot unreachable: AI sites are still blocked by the network rules above.
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) checkTab(tabId, changeInfo.url, "");
  // Re-check once the title is known (YouTube/Wikipedia are judged by what the page is about).
  if (changeInfo.title && tab.url) checkTab(tabId, tab.url, changeInfo.title);
});
chrome.tabs.onRemoved.addListener((tabId) => lastChecked.delete(tabId));

// A new or re-enabled AI extension during a session is switched straight back off.
chrome.management.onInstalled.addListener(() => syncPolicy());
chrome.management.onEnabled.addListener(() => syncPolicy());

chrome.alarms.create("sync", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => a.name === "sync" && syncPolicy());
chrome.runtime.onInstalled.addListener(syncPolicy);
chrome.runtime.onStartup.addListener(syncPolicy);
syncPolicy();
