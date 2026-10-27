import { useEffect, useState } from "react";
import { AlarmClock, MessageSquare, Pause, Play, Plus, Trash2, Zap } from "lucide-react";
import { createSkill, deleteSkill, fetchSkills, runSkill, updateSkill, type SkillInfo } from "../api";

// Routines: requests that run by themselves every day at a set time (while OmniPilot is running).
// Each routine's results collect in its own chat.

const TEMPLATES: { name: string; time: string; instructions: string }[] = [
  { name: "Start my day", time: "07:30", instructions: "Tell me what's due today and this week, what's on my calendar today, and summarize my unread emails." },
  { name: "Homework check", time: "16:00", instructions: "What homework, projects and tests do I have coming up? Make me a plan for this evening." },
  { name: "Daily science fact", time: "08:00", instructions: "Teach me one surprising science fact with a short explanation and a one-question quiz." },
  { name: "Code health", time: "18:00", instructions: "Scan my code in the workspace for security issues and summarize anything new." },
];

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function nextRun(s: SkillInfo): string {
  if (!s.dailyAt) return "Paused";
  const [h, m] = s.dailyAt.split(":").map(Number);
  const now = new Date();
  const ranToday = s.lastRunDate === today();
  const passed = now.getHours() * 60 + now.getMinutes() >= h * 60 + m;
  const at = new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return ranToday || passed ? `Next: tomorrow at ${at}` : `Next: today at ${at}`;
}

export function RoutinesPage({ onOpenChat }: { onOpenChat: (conversationId: string) => void }) {
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ name: "", instructions: "", time: "07:30" });
  const [editing, setEditing] = useState<Record<string, string>>({});

  const load = () => fetchSkills().then(setSkills).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  // Routines are skills with a time; skills without one can be scheduled from here too.
  const routines = (skills ?? []).filter((s) => s.kind === "skill" && (s.dailyAt || s.lastRunDate));
  const unscheduled = (skills ?? []).filter((s) => s.kind === "skill" && !s.dailyAt && !s.lastRunDate);

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      await load();
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function create(t?: (typeof TEMPLATES)[number]) {
    const s = t ?? { name: draft.name, instructions: draft.instructions, time: draft.time };
    await act(async () => {
      await createSkill({ name: s.name, kind: "skill", instructions: s.instructions, dailyAt: s.time || null });
      setCreating(false);
      setDraft({ name: "", instructions: "", time: "07:30" });
    });
  }

  async function runNow(s: SkillInfo) {
    try {
      const r = await runSkill(s.name);
      onOpenChat(r.conversationId);
    } catch (e: any) {
      setError(e.message);
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>
            <AlarmClock size={20} /> Routines
          </h1>
          <p>Requests that run by themselves every day at a set time, while OmniPilot is running. Each routine's results collect in its own chat.</p>
        </div>
        <button className="pill-btn primary" onClick={() => setCreating((c) => !c)}>
          <Plus size={14} /> New routine
        </button>
      </header>

      {error && (
        <p className="page-error" role="alert">
          {error}
        </p>
      )}

      {creating && (
        <form
          className="page-card routine-form"
          onSubmit={(e) => {
            e.preventDefault();
            create();
          }}
        >
          <label>
            Name
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Start my day" required autoFocus />
          </label>
          <label>
            What should it do?
            <textarea value={draft.instructions} onChange={(e) => setDraft({ ...draft, instructions: e.target.value })} placeholder="Tell me what's due today and summarize my unread emails" rows={3} required />
          </label>
          <label className="routine-time">
            Every day at
            <input type="time" value={draft.time} onChange={(e) => setDraft({ ...draft, time: e.target.value })} required />
          </label>
          <div className="page-actions">
            <button type="submit" className="pill-btn primary">
              Save routine
            </button>
            <button type="button" className="pill-btn" onClick={() => setCreating(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {skills === null ? (
        <p className="page-meta">Loading…</p>
      ) : routines.length === 0 && !creating ? (
        <div className="page-empty">
          <p>No routines yet. Start with one of these, or make your own:</p>
          <div className="template-grid">
            {TEMPLATES.map((t) => (
              <button key={t.name} className="page-card template" onClick={() => create(t)}>
                <strong>{t.name}</strong>
                <span className="page-meta">Every day at {new Date(2000, 0, 1, ...(t.time.split(":").map(Number) as [number, number])).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
                <span>{t.instructions}</span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="card-list">
          {routines.map((s) => (
            <article key={s.name} className={`page-card routine ${s.dailyAt ? "" : "paused"}`}>
              <div className="routine-head">
                <div>
                  <h2>{s.label}</h2>
                  <span className="page-meta">
                    {nextRun(s)}
                    {s.lastRunDate ? ` · last ran ${s.lastRunDate === today() ? "today" : s.lastRunDate}` : " · hasn't run yet"}
                  </span>
                </div>
                <input
                  type="time"
                  aria-label={`Time for ${s.label}`}
                  value={s.dailyAt ?? ""}
                  onChange={(e) => e.target.value && act(() => updateSkill(s.name, { dailyAt: e.target.value }))}
                />
              </div>
              {editing[s.name] !== undefined ? (
                <div className="routine-edit">
                  <textarea value={editing[s.name]} rows={3} onChange={(e) => setEditing({ ...editing, [s.name]: e.target.value })} />
                  <div className="page-actions">
                    <button
                      className="pill-btn primary"
                      onClick={() =>
                        act(async () => {
                          await updateSkill(s.name, { instructions: editing[s.name] });
                          const { [s.name]: _, ...rest } = editing;
                          setEditing(rest);
                        })
                      }
                    >
                      Save
                    </button>
                    <button
                      className="pill-btn"
                      onClick={() => {
                        const { [s.name]: _, ...rest } = editing;
                        setEditing(rest);
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <p className="routine-instructions" onClick={() => setEditing({ ...editing, [s.name]: s.instructions })} title="Click to edit">
                  {s.instructions}
                </p>
              )}
              <div className="page-actions">
                <button className="pill-btn" onClick={() => runNow(s)}>
                  <Zap size={13} /> Run now
                </button>
                <button className="pill-btn" onClick={() => onOpenChat(s.conversationId)}>
                  <MessageSquare size={13} /> Results
                </button>
                {s.dailyAt ? (
                  <button className="pill-btn" onClick={() => act(() => updateSkill(s.name, { dailyAt: null }))}>
                    <Pause size={13} /> Pause
                  </button>
                ) : (
                  <button className="pill-btn" onClick={() => act(() => updateSkill(s.name, { dailyAt: "07:30" }))}>
                    <Play size={13} /> Resume
                  </button>
                )}
                <button className="pill-btn danger" onClick={() => confirm(`Delete the routine "${s.label}"?`) && act(() => deleteSkill(s.name))}>
                  <Trash2 size={13} /> Delete
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      {unscheduled.length > 0 && (
        <section className="page-section">
          <h3>Skills you could schedule</h3>
          <div className="card-list compact">
            {unscheduled.map((s) => (
              <div key={s.name} className="page-card row">
                <span>
                  <strong>/{s.name}</strong> <span className="page-meta">{s.instructions.slice(0, 90)}</span>
                </span>
                <button className="pill-btn" onClick={() => act(() => updateSkill(s.name, { dailyAt: "07:30" }))}>
                  <AlarmClock size={13} /> Run daily
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
