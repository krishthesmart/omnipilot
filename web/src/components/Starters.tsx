import { useMemo } from "react";
import { AGENT_META } from "../agentMeta";
import type { AgentName } from "../types";

// One-tap example requests on an empty chat, from different specialists and skills, so a first-time user
// sees the range of what OmniPilot does. A different selection each visit. (Router + six specialists; the
// former extra agents are skills of a specialist, docs/product D16.)
const STARTERS: { agent: AgentName; skill?: string; text: string }[] = [
  { agent: "ScienceLab", skill: "3D models", text: "Build a 3D model of a Nintendo Switch I can explore through its parts" },
  { agent: "ScienceLab", skill: "3D models", text: "Show me a water molecule in 3D" },
  { agent: "CodePilot", text: "Build a flashcard quiz app in Python with tests" },
  { agent: "CodePilot", text: "Make a snake game" },
  { agent: "ScienceLab", text: "Simulate a 2 m pendulum on Mars" },
  { agent: "ScienceLab", text: "Simulate predators and prey: 40 foxes and 200 rabbits" },
  { agent: "CodePilot", skill: "wiring guides", text: "How do I connect an LED to my Arduino?" },
  { agent: "Helper", skill: "lessons & quizzes", text: "Quiz me on photosynthesis at a 7th-grade level" },
  { agent: "ScienceLab", skill: "math checks", text: "Teach me a quick way to multiply by 11" },
  { agent: "Helper", skill: "school planner", text: "I have a science project due Friday" },
  { agent: "InfraPilot", text: "Summarize my unread emails" },
  { agent: "Helper", text: "Research how volcanoes form for 2 minutes" },
  { agent: "ScriptScholar", text: "Compare Linear A and Linear B" },
  { agent: "Helper", skill: "pictures", text: "Draw a rocket flying past Saturn" },
];

export function Starters({ onPick }: { onPick: (text: string) => void }) {
  const picks = useMemo(() => {
    const shuffled = [...STARTERS].sort(() => Math.random() - 0.5);
    const seen = new Set<string>();
    const key = (s: { agent: AgentName; skill?: string }) => `${s.agent}/${s.skill ?? ""}`;
    return shuffled.filter((s) => !seen.has(key(s)) && seen.add(key(s))).slice(0, 6);
  }, []);
  return (
    <div className="starters" aria-label="Try one of these">
      {picks.map((s) => {
        const meta = AGENT_META[s.agent];
        const Icon = meta.icon;
        return (
          <button key={s.text} className="starter" onClick={() => onPick(s.text)} style={{ ["--accent-agent" as string]: meta.accent }}>
            <Icon size={15} aria-hidden />
            <span className="starter-text">{s.text}</span>
            <span className="starter-agent">{s.skill ? `${s.agent} · ${s.skill}` : s.agent}</span>
          </button>
        );
      })}
    </div>
  );
}
