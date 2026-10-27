import { useEffect, useState } from "react";
import { Bot, MessageSquare, Plus, Sparkles, Trash2, Zap } from "lucide-react";
import { createSkill, deleteSkill, fetchSkills, type SkillInfo } from "../api";
import { AGENT_META } from "../agentMeta";
import type { AgentName } from "../types";

// Skills (saved requests run with /name) and custom agents (a role you chat with), plus the
// built-in specialist agents OmniPilot routes to.

const BUILT_IN = Object.entries(AGENT_META) as [AgentName, (typeof AGENT_META)[AgentName]][];

export function SkillsPage({ onUse }: { onUse: (text: string) => void }) {
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<{ kind: "skill" | "agent"; name: string; instructions: string } | null>(null);

  const load = () => fetchSkills().then(setSkills).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  async function save() {
    if (!form) return;
    setError(null);
    try {
      await createSkill({ kind: form.kind, name: form.name, instructions: form.instructions });
      setForm(null);
      load();
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function remove(s: SkillInfo) {
    if (!confirm(`Delete ${s.kind === "agent" ? "the agent" : "the skill"} "${s.label}"?`)) return;
    try {
      await deleteSkill(s.name);
      load();
    } catch (e: any) {
      setError(e.message);
    }
  }

  const mySkills = (skills ?? []).filter((s) => s.kind === "skill");
  const myAgents = (skills ?? []).filter((s) => s.kind === "agent");

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>
            <Sparkles size={20} /> Skills &amp; agents
          </h1>
          <p>
            A <b>skill</b> is a request you save and run with <code>/name</code>. A <b>custom agent</b> is a role you chat with (a Spanish tutor, a debate coach…).
          </p>
        </div>
        <div className="page-actions">
          <button className="pill-btn primary" onClick={() => setForm({ kind: "skill", name: "", instructions: "" })}>
            <Plus size={14} /> New skill
          </button>
          <button className="pill-btn" onClick={() => setForm({ kind: "agent", name: "", instructions: "" })}>
            <Plus size={14} /> New agent
          </button>
        </div>
      </header>

      {error && (
        <p className="page-error" role="alert">
          {error}
        </p>
      )}

      {form && (
        <form
          className="page-card routine-form"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <label>
            {form.kind === "skill" ? "Skill name (you'll type /name)" : "Agent name"}
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={form.kind === "skill" ? "study_session" : "SpanishTutor"} required autoFocus />
          </label>
          <label>
            {form.kind === "skill" ? "What should it do?" : "Who is this agent and how should it answer?"}
            <textarea
              rows={3}
              value={form.instructions}
              onChange={(e) => setForm({ ...form, instructions: e.target.value })}
              placeholder={form.kind === "skill" ? "Make me a 45-minute study plan for my next test and quiz me on it" : "A friendly Spanish tutor: answer in simple Spanish, then the English, and correct my mistakes"}
              required
            />
          </label>
          <div className="page-actions">
            <button type="submit" className="pill-btn primary">
              Save {form.kind}
            </button>
            <button type="button" className="pill-btn" onClick={() => setForm(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      <section className="page-section">
        <h3>Your skills</h3>
        {skills === null ? (
          <p className="page-meta">Loading…</p>
        ) : mySkills.length === 0 ? (
          <p className="page-meta">No skills yet. Or say in chat: "create a skill called start_my_day that tells me what's due".</p>
        ) : (
          <div className="card-list compact">
            {mySkills.map((s) => (
              <div key={s.name} className="page-card row">
                <span className="row-main">
                  <strong>/{s.name}</strong>
                  <span className="page-meta">{s.instructions}</span>
                  {s.dailyAt && <span className="tag">daily at {s.dailyAt}</span>}
                </span>
                <span className="page-actions">
                  <button className="pill-btn" onClick={() => onUse(`/${s.name}`)}>
                    <Zap size={13} /> Run
                  </button>
                  <button className="icon-btn" onClick={() => remove(s)} aria-label={`Delete ${s.label}`}>
                    <Trash2 size={14} />
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="page-section">
        <h3>Your agents</h3>
        {skills !== null && myAgents.length === 0 ? (
          <p className="page-meta">No custom agents yet.</p>
        ) : (
          <div className="card-list compact">
            {myAgents.map((s) => (
              <div key={s.name} className="page-card row">
                <span className="row-main">
                  <strong>
                    <Bot size={14} /> {s.label}
                  </strong>
                  <span className="page-meta">{s.instructions}</span>
                </span>
                <span className="page-actions">
                  <button className="pill-btn" onClick={() => onUse(`/${s.name}`)}>
                    <MessageSquare size={13} /> Chat
                  </button>
                  <button className="icon-btn" onClick={() => remove(s)} aria-label={`Delete ${s.label}`}>
                    <Trash2 size={14} />
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="page-section">
        <h3>Built-in agents</h3>
        <p className="page-meta">OmniPilot picks the right ones for each request; several can work on one request together.</p>
        <div className="agent-grid">
          {BUILT_IN.map(([name, meta]) => {
            const Icon = meta.icon;
            return (
              <div key={name} className="page-card agent-tile" style={{ ["--accent-agent" as string]: meta.accent }}>
                <Icon size={18} />
                <strong>{name}</strong>
                <span className="page-meta">{meta.tagline}</span>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
