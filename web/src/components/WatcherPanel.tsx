import { useEffect, useState } from "react";
import { Eye, X } from "lucide-react";
import { fetchWatcher, fetchWatcherEvents, saveWatcher, type WatcherState } from "../api";
import type { WatcherPolicy } from "../types";

const SUBJECTS: WatcherPolicy["subject"][] = ["math", "reading", "writing", "science", "coding", "history", "languages"];
const DURATIONS = [
  { min: 30, label: "30 minutes" },
  { min: 60, label: "1 hour" },
  { min: 120, label: "2 hours" },
  { min: 0, label: "Until I turn it off" },
];
const ERRORS: Record<string, string> = {
  wrong_pin: "That PIN isn't right.",
  pin_required: "Choose a 4–8 digit PIN.",
  locked: "Too many wrong PINs. Try again in 5 minutes.",
  invalid_request: "Something in the form isn't valid.",
};

const splitList = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

function nearestDuration(until: string | null | undefined): number {
  if (!until) return 0;
  const mins = (Date.parse(until) - Date.now()) / 60_000;
  return DURATIONS.filter((d) => d.min).reduce((best, d) => (Math.abs(d.min - mins) < Math.abs(best - mins) ? d.min : best), 60);
}

export function WatcherPanel({ open, onClose, prefill }: { open: boolean; onClose: () => void; prefill?: Partial<WatcherPolicy> }) {
  const [state, setState] = useState<WatcherState | null>(null);
  const [form, setForm] = useState<WatcherPolicy | null>(null);
  const [duration, setDuration] = useState(60);
  const [allowText, setAllowText] = useState("");
  const [blockText, setBlockText] = useState("");
  const [pin, setPin] = useState("");
  const [pinConfirm, setPinConfirm] = useState("");
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [events, setEvents] = useState<{ at: string; url: string; reason: string }[] | null>(null);

  useEffect(() => {
    if (!open) return;
    setMessage(null);
    setEvents(null);
    setPin("");
    setPinConfirm("");
    fetchWatcher().then((s) => {
      setState(s);
      const base = { ...s.policy, ...(prefill ?? {}) };
      setForm(base);
      setDuration(prefill ? nearestDuration(prefill.until) : s.policy.active ? nearestDuration(s.policy.until) : 60);
      setAllowText(base.allow.join(", "));
      setBlockText(base.block.join(", "));
    });
  }, [open, prefill]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const firstTime = state ? !state.hasPin : false;
  const running = state?.policy.active;

  async function submit(active: boolean) {
    if (!form) return;
    if (firstTime && pin !== pinConfirm) return setMessage({ kind: "error", text: "The two PINs don't match." });
    const policy: WatcherPolicy = {
      ...form,
      active,
      allow: splitList(allowText),
      block: splitList(blockText),
      until: active && duration ? new Date(Date.now() + duration * 60_000).toISOString() : null,
    };
    const res = await saveWatcher(policy, pin);
    if (res.error) return setMessage({ kind: "error", text: ERRORS[res.error] ?? res.error });
    setState((s) => (s ? { ...s, policy: res.policy!, hasPin: true } : s));
    setMessage({ kind: "ok", text: active ? "Focus session is on. The browser extension picks it up within a minute." : "Focus session stopped." });
    setPin("");
    setPinConfirm("");
  }

  async function loadEvents() {
    const res = await fetchWatcherEvents(pin);
    if (res.error) return setMessage({ kind: "error", text: ERRORS[res.error] ?? res.error });
    setEvents(res.events ?? []);
  }

  const set = <K extends keyof WatcherPolicy>(k: K, v: WatcherPolicy[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  return (
    <div className="integrations-overlay" onClick={onClose}>
      <div className="integrations-panel watcher-panel" onClick={(e) => e.stopPropagation()}>
        <div className="integrations-header">
          <h3>
            <Eye size={17} /> Watcher
          </h3>
          <button className="close-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <p className={running ? "watcher-status on" : "watcher-status"}>
          {running
            ? `Focus session running: "${state!.policy.task}"${state!.policy.until ? `, ends ${new Date(state!.policy.until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}.`
            : "No focus session is running."}
        </p>

        {form && (
          <form className="watcher-form" onSubmit={(e) => { e.preventDefault(); submit(true); }}>
            <label>
              Task
              <input value={form.task} onChange={(e) => set("task", e.target.value)} placeholder="learn math" maxLength={120} required />
            </label>
            <label>
              Subject
              <select value={form.subject ?? ""} onChange={(e) => set("subject", (e.target.value || null) as WatcherPolicy["subject"])}>
                <option value="">(none)</option>
                {SUBJECTS.map((s) => (
                  <option key={s!} value={s!}>{s}</option>
                ))}
              </select>
            </label>
            <label className="watcher-check">
              <input type="checkbox" checked={form.blockAI} onChange={(e) => set("blockAI", e.target.checked)} />
              Block AI tools &amp; answer solvers (ChatGPT, Gemini, Photomath, Brainly…)
            </label>
            <label className="watcher-check">
              <input type="checkbox" checked={form.blockAIExtensions} onChange={(e) => set("blockAIExtensions", e.target.checked)} />
              Switch off AI browser extensions during the session
            </label>
            <label className="watcher-check">
              <input type="checkbox" checked={form.onTaskOnly} onChange={(e) => set("onTaskOnly", e.target.checked)} />
              Only allow sites that fit the task (games, social media, and off-topic videos are blocked)
            </label>
            <label>
              How long
              <select value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
                {DURATIONS.map((d) => (
                  <option key={d.min} value={d.min}>{d.label}</option>
                ))}
              </select>
            </label>
            <label>
              Always allow (sites, comma-separated)
              <input value={allowText} onChange={(e) => setAllowText(e.target.value)} placeholder="classroom.google.com" />
            </label>
            <label>
              Always block
              <input value={blockText} onChange={(e) => setBlockText(e.target.value)} placeholder="example.com" />
            </label>

            <div className="watcher-pin">
              <label>
                {firstTime ? "Choose a parent PIN (4–8 digits)" : "Parent PIN"}
                <input type="password" inputMode="numeric" pattern="\d{4,8}" value={pin} onChange={(e) => setPin(e.target.value)} required autoComplete="off" />
              </label>
              {firstTime && (
                <label>
                  Confirm PIN
                  <input type="password" inputMode="numeric" pattern="\d{4,8}" value={pinConfirm} onChange={(e) => setPinConfirm(e.target.value)} required autoComplete="off" />
                </label>
              )}
            </div>

            {message && <p className={`watcher-msg ${message.kind}`}>{message.text}</p>}

            <div className="watcher-actions">
              <button type="submit" className="pill-btn primary">{running ? "Update session" : "Start session"}</button>
              {running && (
                <button type="button" className="pill-btn" onClick={() => submit(false)} disabled={!pin}>
                  Stop session
                </button>
              )}
              {!firstTime && (
                <button type="button" className="pill-btn" onClick={loadEvents} disabled={!pin}>
                  Show blocked attempts
                </button>
              )}
            </div>
          </form>
        )}

        {events && (
          <div className="watcher-events">
            <strong>Blocked attempts</strong>
            {events.length === 0 ? (
              <p className="empty-note">Nothing blocked yet.</p>
            ) : (
              <ul>
                {events.map((e, i) => (
                  <li key={i}>
                    <span className="watcher-event-time">{new Date(e.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>{" "}
                    {e.url.replace(/^https?:\/\//, "").slice(0, 60)}
                    <div className="watcher-event-reason">{e.reason}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <details className="watcher-install">
          <summary>Install the browser extension (one time)</summary>
          <ol>
            <li>In Chrome or Edge, open <code>chrome://extensions</code> and turn on <strong>Developer mode</strong>.</li>
            <li>Click <strong>Load unpacked</strong> and choose the <code>extension</code> folder inside OmniPilot.</li>
            <li>Keep OmniPilot running. The extension follows this panel's rules and keeps blocking AI sites even if OmniPilot is closed.</li>
          </ol>
          <p className="watcher-note">
            During a session the extension blocks the browser's extensions page so it can't simply be switched off. To also stop private
            windows and other browsers, a parent can set Chrome's <code>IncognitoModeAvailability</code> and <code>BrowserGuestModeEnabled</code>{" "}
            policies (for example via a macOS configuration profile), or use a separate child account on the computer.
          </p>
        </details>
      </div>
    </div>
  );
}
