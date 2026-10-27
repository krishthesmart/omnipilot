import type { AgentFn } from "./base.js";
import { evidence, logAgentAction } from "./base.js";
import { deleteSkill, getSkill, listSkills, markRan, parseTime, saveSkill, setDailyAt, slug, type Skill } from "../lib/skills.js";
import { getConnectorInternal } from "../db.js";
import { eventLine, eventsBetween, fetchIcs } from "../lib/calendar.js";

// InfraPilot's skills, custom agents, routines and calendar, all managed in chat:
//   "create a skill called start_my_day that checks my calendar for today"
//   "create an agent called SpanishTutor that helps me practise Spanish"
//   "run start_my_day every day at 7am" / "stop the start_my_day routine"
//   "list my skills" / "delete the skill start_my_day"
//   "what's on my calendar tomorrow?"

type Result = Awaited<ReturnType<AgentFn>>;

const CREATE = /\b(create|make|add|save|set up|setup|build|teach you)\b[^.?!]*\b(skill|command|shortcut|agent|routine)\b/i;
const LIST = /\b(list|show|what are|which)\b[^.?!]*\b(skills|agents|routines|commands)\b|\bmy (skills|agents|routines)\b/i;
const DELETE = /\b(delete|remove|forget)\b[^.?!]*\b(skill|agent|routine|command)\b/i;
const STOP_ROUTINE = /\b(stop|pause|turn off|cancel)\b[^.?!]*\broutine\b|\bstop running\b/i;
const DAILY = /\b(every ?day|daily|each day|every (morning|evening|night)|each (morning|evening))\b|\broutine\b/i;
export const CALENDAR = /\b(calendar|agenda|events?|meetings?|appointments?)\b/i;

/** "called start_my_day", "named SpanishTutor", "/start_my_day". */
function nameIn(text: string): string | null {
  const m = /\b(?:called|named)\s+["“']?\/?([A-Za-z0-9][A-Za-z0-9_ -]{0,38}?)["”']?(?=\s+(?:that|to|which|who|for|every|daily|at|and)\b|[.,!?:]|$)/i.exec(text) ?? /(?:^|\s)\/([a-z0-9_-]{2,40})\b/i.exec(text);
  return m ? m[1].trim() : null;
}

/** What the skill/agent does: the part after "that ..." / "to ..." / "which ...". */
function instructionsIn(text: string, name: string | null): string | null {
  const after = name ? text.slice(text.toLowerCase().indexOf(name.toLowerCase()) + name.length) : text;
  const m = /\b(?:that|which|who|to)\s+([\s\S]{4,})$/i.exec(after);
  if (!m) return null;
  return m[1].replace(/\b(every ?day|daily|each day|every (morning|evening|night))\b.*$/i, "").replace(/\bat \d{1,2}(:\d{2})?\s*(am|pm)?\b.*$/i, "").trim().replace(/[.!]+$/, "") || null;
}

/** The existing skill a request talks about ("run start_my_day every day", "delete SpanishTutor"). */
function existingSkillIn(text: string): Skill | null {
  const named = nameIn(text);
  if (named && getSkill(named)) return getSkill(named);
  return listSkills().find((s) => new RegExp(`\\b${s.name.replace(/_/g, "[ _]")}\\b`, "i").test(text) || new RegExp(`\\b${s.label}\\b`, "i").test(text)) ?? null;
}

const today = () => {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
};

/** A daily time, without running straight away if that time already passed today. */
function scheduleDaily(s: Skill, time: string) {
  setDailyAt(s.name, time);
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  if (time <= hhmm) markRan(s.name, today());
}

const ok = (findings: string[], extra: Partial<Result> = {}): Result => ({ status: "success", findings, evidence: [evidence("omnipilot:skills", "skills, agents and routines saved on this computer")], confidence: 0.95, limitations: [], proposedActions: [], ...extra });

function describe(s: Skill) {
  return s.kind === "agent"
    ? `- **${s.label}** (agent): ${s.instructions} — talk to it with \`/${s.name} …\``
    : `- **/${s.name}** (skill): ${s.instructions}${s.dailyAt ? ` — runs every day at ${s.dailyAt}` : ""}`;
}

async function calendar(input: Parameters<AgentFn>[0]): Promise<Result> {
  const conn = getConnectorInternal("Google Calendar");
  if (conn?.status !== "connected" || !conn.secret_token) {
    return {
      status: "needs_connection",
      findings: [
        "Your calendar is not connected yet. In Google Calendar, open Settings → your calendar → Integrate calendar, copy the **Secret address in iCal format**, and paste it into the **Connect** button on the Google Calendar card above. It's read-only, and the link stays on this computer.",
      ],
      evidence: [evidence("connector:Google Calendar", JSON.stringify({ name: "Google Calendar", status: "not_connected", kind: "calendar", verification: "token" }))],
      confidence: 0.9,
      limitations: ["Nothing can read your calendar until you connect it."],
      proposedActions: [],
    };
  }
  const t = input.requestText.toLowerCase();
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  let days = 1;
  let label = "today";
  const nDays = /\bnext (\d{1,2}) days\b/.exec(t);
  if (/\btomorrow\b/.test(t)) (start.setDate(start.getDate() + 1), (label = "tomorrow"));
  else if (nDays) (days = Math.min(60, Number(nDays[1])), (label = `in the next ${Math.min(60, Number(nDays[1]))} days`));
  else if (/\b(this|next) month\b|\bmonth\b|\bupcoming\b|\bcoming up\b/.test(t)) (days = 30, (label = "in the next 30 days"));
  else if (/\b(this|next) week\b|\bweek\b/.test(t)) (days = 7, (label = "in the next 7 days"));
  let events;
  let next: string | null = null;
  try {
    const ics = await fetchIcs(conn.secret_token);
    events = eventsBetween(ics, start, days);
    // Nothing in that window: say when the next thing is.
    if (events.length === 0) {
      const later = eventsBetween(ics, new Date(start.getFullYear(), start.getMonth(), start.getDate() + days), 90)[0];
      if (later) next = eventLine(later).replace(/^- /, "");
    }
  } catch (err) {
    logAgentAction(input.runId, "InfraPilot", "read_calendar", {}, `failed: ${(err as Error).message}`);
    return { status: "unreachable", findings: [`I couldn't read your calendar: ${(err as Error).message}.`], evidence: [], confidence: 0.2, limitations: [], proposedActions: [] };
  }
  logAgentAction(input.runId, "InfraPilot", "read_calendar", { window: label, events: events.length }, "completed");
  return ok([events.length ? `**Your calendar ${label}**\n${events.map(eventLine).join("\n")}` : `Nothing on your calendar ${label}.${next ? ` The next thing is ${next}.` : ""}`], {
    evidence: [evidence("connector:Google Calendar", JSON.stringify({ name: "Google Calendar", status: "connected", kind: "calendar", verification: "token", accountLabel: conn.account_label }))],
  });
}

/** Handles skills, agents, routines and calendar requests; null when the request is about none of them. */
export async function infraSkills(input: Parameters<AgentFn>[0]): Promise<Result | null> {
  // The whole sentence as typed: the Coordinator may have split it into parts for other agents,
  // and a skill's description must be saved complete.
  const original = typeof input.context.originalRequest === "string" ? input.context.originalRequest : "";
  const text = original && CREATE.test(original) ? original : input.requestText;

  if (LIST.test(text)) {
    const all = listSkills();
    logAgentAction(input.runId, "InfraPilot", "list_skills", { count: all.length }, "completed");
    return ok([all.length ? `**Your skills and agents**\n${all.map(describe).join("\n")}` : 'You have no skills or agents yet. Try: "create a skill called start_my_day that checks my calendar for today and what homework is due".']);
  }

  if (STOP_ROUTINE.test(text)) {
    const s = existingSkillIn(text);
    if (s) {
      setDailyAt(s.name, null);
      logAgentAction(input.runId, "InfraPilot", "stop_routine", { name: s.name }, "completed");
      return ok([`Stopped the daily routine for **/${s.name}**. The skill is still there; run it any time with \`/${s.name}\`.`]);
    }
  }

  if (DELETE.test(text)) {
    const s = existingSkillIn(text);
    if (s) {
      deleteSkill(s.name);
      logAgentAction(input.runId, "InfraPilot", "delete_skill", { name: s.name }, "completed");
      return ok([`Deleted **${s.kind === "agent" ? s.label : `/${s.name}`}**.`]);
    }
    return ok(["I couldn't find that one. Say \"list my skills\" to see them."], { status: "partial_success", confidence: 0.6 });
  }

  // "run start_my_day every day at 7am" / "make start_my_day a routine at 7:30"
  const existing = existingSkillIn(text);
  const time = parseTime(text);
  if (existing && DAILY.test(text) && !CREATE.test(text.replace(/\broutine\b/i, ""))) {
    if (!time) return ok([`What time should **/${existing.name}** run each day? For example: "run ${existing.name} every day at 7am".`], { status: "partial_success", confidence: 0.6 });
    if (existing.kind === "agent") return ok(["Only skills can run as routines; agents answer when you talk to them."], { status: "partial_success", confidence: 0.7 });
    scheduleDaily(existing, time);
    logAgentAction(input.runId, "InfraPilot", "schedule_routine", { name: existing.name, time }, "completed");
    return ok([`Done: **/${existing.name}** will run every day at **${time}** while OmniPilot is running. The results appear in your chat history as "${existing.instructions.slice(0, 50)}…". Say "stop the ${existing.name} routine" to turn it off.`]);
  }

  if (CREATE.test(text)) {
    const isAgent = /\bagent\b/i.test(text) && !/\bskill\b/i.test(text);
    const name = nameIn(text);
    const instructions = instructionsIn(text, name);
    if (!name || !instructions) {
      return ok(
        [
          isAgent
            ? 'Tell me its name and what it should do, like: "create an agent called SpanishTutor that helps me practise Spanish conversation and corrects my mistakes".'
            : 'Tell me its name and what it should do, like: "create a skill called start_my_day that checks my calendar for today and what homework is due".',
        ],
        { status: "partial_success", confidence: 0.6 }
      );
    }
    let skill: Skill;
    try {
      skill = saveSkill({ name, label: name.replace(/_/g, " "), kind: isAgent ? "agent" : "skill", instructions });
    } catch (err) {
      return ok([(err as Error).message], { status: "partial_success", confidence: 0.6 });
    }
    const daily = !isAgent && DAILY.test(text) && time;
    if (daily) scheduleDaily(skill, time);
    logAgentAction(input.runId, "InfraPilot", isAgent ? "create_agent" : "create_skill", { name: skill.name, daily: daily ? time : null }, "completed");
    return ok([
      isAgent
        ? `Created the agent **${skill.label}**. Talk to it any time: \`/${skill.name} …\` or "ask ${skill.label} …".`
        : `Created the skill **/${skill.name}**: "${skill.instructions}". Run it any time by typing \`/${skill.name}\`${daily ? `; it also runs every day at **${time}**` : ` (or say "run ${skill.name} every day at 7am" to make it a routine)`}.`,
    ]);
  }

  if (CALENDAR.test(text)) return calendar(input);
  return null;
}

export { slug };
