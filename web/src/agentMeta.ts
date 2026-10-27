import { Puzzle, Search, ShieldCheck, PenLine, FlaskConical, ScrollText, GraduationCap, Eye, Cpu, Sigma, Image, Backpack, Box, type LucideIcon } from "lucide-react";
import type { AgentName } from "./types";

export interface AgentMeta {
  icon: LucideIcon;
  tagline: string;
  accent: string; // CSS color token name, e.g. "var(--agent-code)"
}

export const AGENT_META: Record<AgentName, AgentMeta> = {
  InfraPilot: { icon: Puzzle, tagline: "Gmail, Drive, Calendar, Slack, GitHub, Notion, MCP; routines", accent: "var(--agent-infra)" },
  Helper: { icon: Search, tagline: "Answers questions, does math, searches your notes", accent: "var(--agent-helper)" },
  CodePilot: { icon: ShieldCheck, tagline: "Writes & tests code, finds security bugs", accent: "var(--agent-code)" },
  PromptPilot: { icon: PenLine, tagline: "Rewrites prompts for other AI tools", accent: "var(--agent-prompt)" },
  ScienceLab: { icon: FlaskConical, tagline: "Runs physics & biology simulations", accent: "var(--agent-science)" },
  ScriptScholar: { icon: ScrollText, tagline: "Compares ancient writing systems", accent: "var(--agent-script)" },
  LearnPilot: { icon: GraduationCap, tagline: "Tutors at any grade: lessons, flashcards, quizzes", accent: "var(--agent-learn)" },
  WatcherPilot: { icon: Eye, tagline: "Parent-set focus time: blocks AI & off-task sites", accent: "var(--agent-watcher)" },
  HardwarePilot: { icon: Cpu, tagline: "Shows how to wire & connect things, step by step", accent: "var(--agent-hardware)" },
  MathPilot: { icon: Sigma, tagline: "Checks math identities; hunts for new formulas 24/7", accent: "var(--agent-math)" },
  PicturePilot: { icon: Image, tagline: "Draws pictures from your words", accent: "var(--agent-picture)" },
  ModelPilot: { icon: Box, tagline: "Interactive 3D models you can take apart", accent: "var(--agent-science)" },
  SchoolPilot: { icon: Backpack, tagline: "Tracks homework, plans projects and study time", accent: "var(--agent-learn)" },
};

export const EXAMPLE_PROMPTS: string[] = [
  "Explain photosynthesis for a 5th grader",
  "Write a Python function that checks if a number is prime",
  "How do I connect an LED to my Arduino, and how does it work?",
  "My kid should learn math for 1 hour, no AI.",
  "A $40 shirt is 25% off. What do I pay?",
  "Draw a rocket flying past a planet",
  "Is it true that (a+b)^2 = a^2 + b^2?",
  "Check my code for security bugs and make a study plan for what you find.",
];
