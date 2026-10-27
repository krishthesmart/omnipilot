import type { AgentFn } from "./base.js";
import { assertNotAborted, evidence, logAgentAction, previousTurnText } from "./base.js";
import { agentModel, generateJson, generateText, modelLimitation } from "../lib/llm.js";
import { checkLearnPilotSafety } from "./learnPilot.js";
import {
  addTask,
  deleteTask,
  findTask,
  fromIso,
  listTasks,
  parseDueDate,
  scheduleSteps,
  setDone,
  studyDays,
  whenText,
  type SchoolTask,
  type TaskKind,
} from "../lib/school.js";

// SchoolPilot: help with school stuff. It keeps track of homework, projects and tests (with due
// dates worked out exactly), breaks big assignments into steps scheduled before they're due,
// plans spaced study sessions before a test, and helps with essays and homework by guiding the
// student rather than doing the work for them.

const LIST_INTENT = /\b(what|which|show|list|any)\b[^.?!]*\b(homework|assignments?|due|tests?|exams?|projects?|essays?|tasks?)\b|\bwhat'?s due\b|\bmy (homework|assignments|schedule|to-?do)\b|\b(homework|assignment) list\b/i;
const DONE_INTENT = /\b(i('ve| have)? )?(done|finished|completed|turned in|submitted|handed in)\b|\bmark\b[^.?!]*\bdone\b/i;
const DELETE_INTENT = /\b(delete|remove|cancel|drop|forget)\b[^.?!]*\b(homework|assignment|project|test|exam|essay|task|it)\b/i;
const ADD_NOUN = /\b(homework|assignment|worksheet|project|science fair|report|presentation|poster|essay|paper|test|exam|quiz|midterm|final|lab)\b/i;

function kindOf(text: string): TaskKind {
  if (/\b(test|exam|quiz|midterm|final)\b/i.test(text)) return "test";
  if (/\b(essay|paper|book report|report)\b/i.test(text)) return "essay";
  if (/\b(project|science fair|presentation|poster|lab)\b/i.test(text)) return "project";
  return "homework";
}

const SUBJECTS = ["math", "science", "biology", "chemistry", "physics", "history", "english", "reading", "writing", "spanish", "french", "geography", "art", "music", "computer science", "coding", "social studies", "economics"];
const subjectOf = (text: string) => SUBJECTS.find((s) => new RegExp(`\\b${s}\\b`, "i").test(text)) ?? null;

/** A short title from the request: "my science project on volcanoes due Friday" -> "Science project on volcanoes". */
function titleOf(text: string): string {
  const t = text
    .replace(/\b(i have|i've got|i got|there'?s|add|remind me about|please|can you|help me( plan)?|plan|a|an|my)\b/gi, " ")
    .replace(/\b(due|on|by|for|this|next|in)\b\s*(today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d.*|week.*|[a-z]{3,9}\.? \d{1,2}.*)$/i, "")
    .replace(/\b(due|it'?s due).*$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.?!,]+$/, "");
  const title = t || "Assignment";
  return (title.charAt(0).toUpperCase() + title.slice(1)).slice(0, 80);
}

const STEPS_SYSTEM =
  "Break a student's assignment into 3 to 6 concrete steps, in order, that a student can each finish in one sitting (for example: choose a topic, research, outline, first draft, revise, final copy). " +
  "Make them specific to the assignment. Each step is one short sentence starting with a verb.";
const STEPS_SCHEMA = { type: "object", properties: { steps: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 6 } }, required: ["steps"] };

const TOPICS_SYSTEM =
  "A student has a test coming up. List the study sessions to prepare, one short topic or activity per session, from learning the material to practice tests. Make them specific to the subject if one is given.";
const topicsSchema = (n: number) => ({ type: "object", properties: { sessions: { type: "array", items: { type: "string" }, minItems: n, maxItems: n } }, required: ["sessions"] });

const HELP_SYSTEM =
  "You are SchoolPilot, a friendly study coach for students. Help with the school task in the request: explain clearly, step by step, at the student's level. " +
  "For homework, guide them to the answer (explain the method, work a similar example, then let them try) rather than only giving answers. " +
  "For essays, help with choosing a thesis, an outline, evidence and feedback on their own writing; if asked to write a whole essay for school, give a strong outline and an example opening paragraph, and offer to help them write the rest. " +
  "Keep it encouraging and concise, with headings or short lists where useful.";

const FALLBACK_STEPS: Record<TaskKind, string[]> = {
  project: ["Pick your topic and check it with your teacher", "Research and take notes", "Plan what you'll make or show", "Build or write the main part", "Finish, check it against the instructions, and practise presenting"],
  essay: ["Choose a topic and write a one-sentence thesis", "Find evidence and take notes", "Write an outline", "Write the first draft", "Revise, proofread and write the final copy"],
  homework: ["Do the homework"],
  test: [],
};

function listText(tasks: SchoolTask[]): string {
  if (tasks.length === 0) return "Nothing on your list right now. Tell me about homework, a project or a test and when it's due, and I'll keep track of it.";
  const lines = tasks.map((t) => {
    const next = t.steps.find((s) => fromIso(s.date) >= new Date(new Date().toDateString()));
    return `- **${t.title}** — due ${whenText(t.due)}${next ? `\n  Next step (${whenText(next.date).replace(/ \(.+\)$/, "")}): ${next.text}` : ""}`;
  });
  return `**Your school list**\n${lines.join("\n")}`;
}

function planText(task: SchoolTask): string {
  if (task.steps.length === 0) return `Added **${task.title}**, due ${whenText(task.due)}.`;
  const heading = task.kind === "test" ? "Study plan" : "Plan";
  return `Added **${task.title}**, due ${whenText(task.due)}.\n\n**${heading}**\n${task.steps
    .map((s) => `- ${fromIso(s.date).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}: ${s.text}`)
    .join("\n")}\n\nAsk "what's due?" any time, or tell me when you finish it.`;
}

export const schoolPilotAgent: AgentFn = async (input, ctx) => {
  assertNotAborted(ctx);
  const text = input.requestText;

  // Same academic-integrity and safety rules as LearnPilot, checked on the whole original request.
  const original = typeof input.context.originalRequest === "string" ? input.context.originalRequest : "";
  const gate = checkLearnPilotSafety(original ? `${original}\n${text}` : text);
  if (gate.blocked) {
    logAgentAction(input.runId, "SchoolPilot", "safety_gate", { requestExcerpt: text.slice(0, 120) }, "blocked");
    return {
      status: "failed_safe",
      findings: [`Request blocked by SchoolPilot's safety policy: ${gate.reason?.replace("LearnPilot", "SchoolPilot")}`],
      evidence: [],
      confidence: 1,
      limitations: ["SchoolPilot helps students learn and plan, but won't complete graded work for them to hand in."],
      proposedActions: [],
    };
  }
  const due = parseDueDate(text);

  // "what homework do I have?"
  if (LIST_INTENT.test(text) && !due) {
    const tasks = listTasks();
    logAgentAction(input.runId, "SchoolPilot", "list_tasks", { open: tasks.length }, "completed");
    return { status: "success", findings: [listText(tasks)], evidence: [evidence("school-list", `${tasks.length} open item(s)`)], confidence: 0.95, limitations: [], proposedActions: [] };
  }

  // "I finished my math worksheet" / "delete the history essay"
  const deleting = DELETE_INTENT.test(text);
  if ((DONE_INTENT.test(text) || deleting) && !due) {
    const task = findTask(text);
    if (task) {
      if (deleting) deleteTask(task.id);
      else setDone(task.id);
      logAgentAction(input.runId, "SchoolPilot", deleting ? "delete_task" : "complete_task", { id: task.id }, "completed");
      const left = listTasks();
      return {
        status: "success",
        findings: [`${deleting ? "Removed" : "Nice work! Marked done:"} **${task.title}**.${left.length ? `\n\n${listText(left)}` : "\n\nThat's everything on your list."}`],
        evidence: [evidence("school-list", `${left.length} open item(s)`)],
        confidence: 0.9,
        limitations: [],
        proposedActions: [],
      };
    }
  }

  // "I have a science project due Friday"
  if (due && ADD_NOUN.test(text)) {
    const kind = kindOf(text);
    const subject = subjectOf(text);
    const title = titleOf(text);
    let steps: string[] = [];
    let usedModel = false;
    if (kind === "test") {
      const days = studyDays(due);
      const plan = await generateJson<{ sessions: string[] }>(TOPICS_SYSTEM, `Test: ${title}${subject ? ` (subject: ${subject})` : ""}. Sessions: ${days.length}.`, {
        signal: ctx.signal,
        schema: topicsSchema(days.length),
        temperature: 0.3,
        maxTokens: 300,
      });
      const sessions = Array.isArray(plan?.sessions) ? plan!.sessions.map(String).slice(0, days.length) : [];
      usedModel = sessions.length === days.length;
      const fallback = days.map((_, i) => (i === days.length - 1 ? "Quick review of everything and an early night" : i === 0 ? "Read through your notes and list what you don't understand yet" : "Practise questions on the weakest topic"));
      const task = addTask({ title, subject, kind, due, steps: days.map((date, i) => ({ date, text: (usedModel ? sessions : fallback)[i] })) });
      assertNotAborted(ctx);
      logAgentAction(input.runId, "SchoolPilot", "add_task", { kind, due, sessions: days.length, model: usedModel ? agentModel() : null }, "completed");
      return { status: "success", findings: [planText(task)], evidence: [evidence("school-list", `${task.title} due ${due}`)], confidence: 0.9, limitations: usedModel ? [modelLimitation()] : [], proposedActions: [] };
    }
    if (kind === "project" || kind === "essay") {
      const planned = await generateJson<{ steps: string[] }>(STEPS_SYSTEM, `${text}${previousTurnText(input)}`, { signal: ctx.signal, schema: STEPS_SCHEMA, temperature: 0.3, maxTokens: 300 });
      steps = Array.isArray(planned?.steps) ? planned!.steps.map(String).filter(Boolean).slice(0, 6) : [];
      usedModel = steps.length >= 3;
      if (!usedModel) steps = FALLBACK_STEPS[kind];
    }
    const task = addTask({ title, subject, kind, due, steps: scheduleSteps(steps, due) });
    assertNotAborted(ctx);
    logAgentAction(input.runId, "SchoolPilot", "add_task", { kind, due, steps: steps.length, model: usedModel ? agentModel() : null }, "completed");
    return { status: "success", findings: [planText(task)], evidence: [evidence("school-list", `${task.title} due ${due}`)], confidence: 0.9, limitations: usedModel ? [modelLimitation()] : [], proposedActions: [] };
  }

  // Everything else: help with the school task itself.
  const help = await generateText(HELP_SYSTEM, `${previousTurnText(input)}${text}`, { signal: ctx.signal, maxTokens: 900, temperature: 0.4 });
  assertNotAborted(ctx);
  logAgentAction(input.runId, "SchoolPilot", "school_help", { model: help ? agentModel() : null }, help ? "completed" : "model_unavailable");
  if (!help) {
    return {
      status: "partial_success",
      findings: ["I can keep track of homework, projects and tests (tell me what's due and when), but explaining needs the AI model, which isn't answering right now."],
      evidence: [],
      confidence: 0.3,
      limitations: ["The AI model (Groq) didn't respond."],
      proposedActions: [],
    };
  }
  return { status: "success", findings: [help], evidence: [evidence(`ai-model:${agentModel()}`, "School help")], confidence: 0.7, limitations: [modelLimitation()], proposedActions: [] };
};
