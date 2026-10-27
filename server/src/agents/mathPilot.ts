import type { AgentFn } from "./base.js";
import { TRICKS, applyTrick, divisibilityText, fmt, trickCard, tricksNamed } from "../lib/math/tricks.js";
import { assertNotAborted, evidence, logAgentAction } from "./base.js";
import { checkIdentity, extractEquation } from "../lib/math/expr.js";
import { mathStatus, polyText } from "../lib/math/discovery.js";
import { listDiscoveries } from "../db.js";
import { CONSTANTS } from "../lib/math/precise.js";
import { generateText, modelLimitation } from "../lib/llm.js";

// MathPilot: checks identities you give it (numerically, never by guessing),
// and reports what its always-on search for new constant formulas has found.

const ASKS_FOR_RESULTS = /\b(found|find(ings)?|discover\w*|results?|progress|status|search(ing)?|running|new (identit|formula)\w*|latest|so far)\b/i;

function discoveriesMarkdown(limit = 5): string {
  const found = listDiscoveries(limit);
  if (found.length === 0) return "Nothing verified yet. The search has only just started; check back in a few minutes.";
  return found
    .map((d) => {
      const name = CONSTANTS.find((c) => c.name === d.constant)?.fullName ?? d.constant;
      return `- **${d.text.split("   [")[0]}**\n  involves ${name}; verified to ${d.digits} digits; a(n) = ${polyText(d.a)}, b(n) = ${polyText(d.b)}${d.variants > 1 ? `; ${d.variants - 1} related formula(s) found too` : ""}`;
    })
    .join("\n");
}

function statusLine(): string {
  const s = mathStatus();
  const state = !s.enabled ? "is turned off on this computer (MATHPILOT=off)" : s.finished ? "has finished every search stage" : s.paused ? "is paused" : "is running in the background";
  return `The search ${state}: ${s.checked.toLocaleString("en-US")} formulas checked so far, ${s.discoveries} verified identities found, now on stage ${s.stage} of ${s.stages} (${s.stageLabel}, ${Math.round(s.stageProgress * 100)}% done).`;
}

/** Plain inline math instead of LaTeX delimiters, and no sentence cut off by the token limit. */
function tidyExplanation(text: string): string {
  const plain = text.replace(/\\\(\s*|\s*\\\)/g, "`").replace(/\\\[\s*|\s*\\\]/g, "`").replace(/\$\$?([^$]+)\$\$?/g, "`$1`");
  const complete = plain.match(/^[\s\S]*[.!?](?=\s|$)/);
  return (complete ? complete[0] : plain).trim();
}

/** "math trick", "mental math", "quick way to work out 34 × 11", "shortcut for squaring 65". */
export const TRICK_INTENT = /\b(math|maths|mental[- ]math|multiplication|number|arithmetic|calculation|division|divisibility) (trick|shortcut|hack)s?\b|\btricks?\b|\bmental math\b|\bshortcut\b|\bquick(ly| way)\b[^.?!]*\b(multiply|square|work out|calculate|times|divide)|\bin your head\b/i;

/** Mental-math tricks: worked on the user's numbers when one fits, otherwise taught by example. */
function mathTricks(input: Parameters<AgentFn>[0]) {
  const text = input.requestText;
  const applied = applyTrick(text);
  let findings: string[];
  let action: string;
  if (applied) {
    action = applied.trick.id;
    findings = [
      `**Trick: ${applied.trick.name}**\n${applied.trick.how}\n\n${applied.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n\n**Answer: ${fmt(applied.answer)}** (checked exactly).`,
    ];
  } else if (/\bdivisib|\bdivisible\b/i.test(text)) {
    action = "divisibility";
    findings = [divisibilityText()];
  } else if (/\b(all|list|every|some|more)\b[^.?!]*\btricks?\b/i.test(text)) {
    action = "list";
    findings = [`**Mental-math tricks**\n${TRICKS.map((t) => `- **${t.name}**: ${t.example}`).join("\n")}\n\nGive me numbers (like "34 × 11" or "65 squared") and I'll show the trick step by step. Ask for "divisibility tricks" too.`];
  } else {
    const named = tricksNamed(text);
    // A different trick each time when none is named.
    const pick = named[0] ?? TRICKS[Math.floor(Date.now() / 1000) % TRICKS.length];
    action = named[0] ? pick.id : "random";
    findings = [`${trickCard(pick)}\n\nTry it: give me your own numbers and I'll work it with you, or ask for "all math tricks".`];
  }
  logAgentAction(input.runId, "MathPilot", "math_trick", { trick: action }, "completed");
  return { status: "success" as const, findings, evidence: [evidence("mathpilot-tricks", applied ? "worked and checked with exact arithmetic" : "built-in trick library")], confidence: 0.95, limitations: [], proposedActions: [] };
}

export const mathPilotAgent: AgentFn = async (input, ctx) => {
  assertNotAborted(ctx);
  if (TRICK_INTENT.test(input.requestText)) return mathTricks(input);
  const eq = extractEquation(input.requestText);

  if (eq) {
    let check;
    try {
      check = checkIdentity(eq.left, eq.right);
    } catch (err: any) {
      return {
        status: "partial_success",
        findings: [`I couldn't read that as math (${err.message}). Try writing it like \`sin(x)^2 + cos(x)^2 = 1\` or \`sum(1/n^2, n, 1, inf) = pi^2/6\`.`],
        evidence: [],
        confidence: 0.2,
        limitations: [],
        proposedActions: [],
      };
    }
    logAgentAction(input.runId, "MathPilot", "check_identity", { left: eq.left, right: eq.right }, check.verdict);
    const headline = { true: "✅ **True**", false: "❌ **Not true**", unclear: "⚠️ **Can't tell**" }[check.verdict];
    const findings = [`${headline}: \`${eq.left} = ${eq.right}\`\n\n${check.detail}`];

    // The verdict is computed, never generated: the model only explains it.
    if (check.verdict !== "unclear") {
      const why = await generateText(
        "You are MathPilot, a friendly math tutor. A numerical check has already decided whether the statement is true. Never contradict that verdict. In 2-3 short sentences explain WHY, for a student. If it's false, name the correct version if there's a well-known one.",
        `Statement: ${eq.left} = ${eq.right}\nVerdict: ${check.verdict === "true" ? "TRUE" : "FALSE"}\nCheck details: ${check.detail}`,
        { signal: ctx.signal, maxTokens: 160, temperature: 0.2 }
      );
      assertNotAborted(ctx);
      // Drop an explanation that argues against the computed verdict.
      const contradicts = why && (check.verdict === "true" ? /\b(is not true|isn't true|is false|not an identity)\b/i : /\b(is true|holds for all|is an identity)\b/i).test(why);
      if (why && !contradicts) findings.push(`**Why:** ${tidyExplanation(why)}`);
    }
    return {
      status: check.verdict === "unclear" ? "partial_success" : "success",
      findings,
      evidence: [evidence("mathpilot:numeric-check", check.pointsTested ? `${check.pointsTested} test points` : `${check.digits ?? 0} matching digits`)],
      confidence: check.verdict === "unclear" ? 0.3 : check.verdict === "false" ? 0.97 : check.pointsTested ? 0.9 : 0.95,
      limitations: [
        check.verdict === "false"
          ? "A counterexample proves it's not an identity."
          : "A numerical check is strong evidence, not a proof.",
        ...(findings.length > 1 ? [modelLimitation()] : []),
      ],
      proposedActions: [],
    };
  }

  const status = statusLine();
  const wantsResults = ASKS_FOR_RESULTS.test(input.requestText);
  return {
    status: "success",
    findings: [
      ...(wantsResults ? [] : ["MathPilot does two things: it **checks identities** you give it (try \"is sin(x)^2 + cos(x)^2 = 1?\"), and it **searches for new formulas** for famous constants like π, e and ζ(3) all the time in the background."]),
      status,
      `**Latest verified identities**\n${discoveriesMarkdown()}`,
      "Each one is a continued fraction that matches the constant to at least 20 digits at high precision. That makes it a strong conjecture, not a proof, and many turn out to be already known. Ask me for the latest discoveries any time.",
    ],
    evidence: [evidence("mathpilot:search", `${mathStatus().checked} candidates checked`)],
    confidence: 0.9,
    limitations: ["Discoveries are numerically verified conjectures; novelty isn't checked against the published literature."],
    proposedActions: [],
  };
};
