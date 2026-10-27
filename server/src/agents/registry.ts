import type { AgentName } from "../types.js";

/**
 * Every specialist's "tool manifest" -- the single place that says what an
 * agent does, when to use it, which other agents' output it builds on, and
 * how long it may run. The keyword router, the model router prompt,
 * the Coordinator's dependency graph and the orchestrator's time budgets are
 * all derived from this, so adding or changing an agent is one edit here
 * (plus its implementation in AGENTS).
 */
export interface AgentSpec {
  /** One line for the model router: what this agent is for. */
  description: string;
  /** Deterministic routing signals (the keyword half of the hybrid router). */
  keywords: RegExp[];
  /** Narrow agents may only be selected by the model when the request is clearly on-topic. */
  narrow?: boolean;
  /** The request describes one thing ("draw a cat and a dog under a rainbow"): later fragments continue it rather than becoming separate tasks. */
  describesOneThing?: boolean;
  /** Agents whose results this one should receive first, when both are in the plan. */
  buildsOn?: { agent: AgentName; when?: RegExp; reason: string }[];
  /** Per-attempt time budget and retry allowance (see orchestrator.ts). */
  budget: { timeoutMs: number; maxRetries: number };
}

/** Review/repair phrasing ("check my code", "scan", "bugs") as opposed to a spec like "check if a number is even". */
export const REVIEW_INTENT =
  /\b(scan|review|audit)\b|\b(check|fix)\b[^.?!]*\b(my|the|this|our)\s+(code|file|repo|project|function|script)\b|\b(bugs?|vulnerab\w*|security (issues?|holes?|problems?|flaws?)|what'?s wrong)\b/i;

/** Asks for live web pages: visit a site, official docs, "look it up online", a URL. Helper does these with the web tools. */
export const WEB_RESEARCH = new RegExp(
  [
    String.raw`\b(visit|browse|open|go to|check)\b[^.?!]*\b(web ?sites?|sites?|pages?|docs|documentation)\b`,
    String.raw`\b(official|developer|product)\s+(web ?sites?|sites?|docs|documentation|pages?)\b`,
    String.raw`\b(on the web|online|on the internet|search the web|web search|look (it |this |that )?up( online)?|latest news)\b`,
    // "visit google", "go to github.com", "browse amazon": a place on the web, not a file.
    String.raw`\b(visit|browse|go to)\s+(the\s+)?(?!(the |this |that |my |your )?(file|folder|directory|line|function|step|section|settings)\b)[a-z0-9][\w.-]*`,
    String.raw`\b(search|google)\s+(for|it|the internet|online)\b`,
    // Things that change and live on company or news sites.
    String.raw`\b(all\s+(of\s+)?(their|its|the company's)\s+(products|services|apps)|current (price|pricing|ceo|version|release)|latest (version|release|update|price|news)|today'?s (news|price|weather)|stock price|news (about|on))\b`,
    String.raw`https?:\/\/`,
    // "research the history of bicycles for 5 minutes", "deep research on battery chemistry"
    String.raw`\bresearch\w*\b[^.?!]*\bfor \d+(\.\d+)?\s*(minutes?|mins?|hours?|seconds?)\b|\b(deep|thorough|in-depth|detailed|comprehensive|extensive) research\b`,
  ].join("|"),
  "i"
);

/** A real request to be taught (not just "explain how X fits"). */
export const STRONG_TEACHING = /\b(teach|quiz|flashcards?|lesson|tutor|study plan|practice (problems|questions)|\d+(st|nd|rd|th) grader|grade \d+)\b/i;

/** Physical things you plug together. */
const HARDWARE_WORDS =
  "arduino|raspberry|rpi|esp32|breadboard|led|resistor|servo|motor|sensor|circuit|wiring|wires?|solder\\w*|gpio|pins?|hdmi|usb|monitor|cable|printer|keyboard|mouse|speakers?|headphones|router|motherboard|gpu|psu|desktop|tower";

/** "build a budget tracker app", "make a snake game", "create a REST API in node", "a python project with tests". */
export const BUILD_SOFTWARE =
  /\b(build|create|make|scaffold|develop|code|program)\b[^.?!]*\b(apps?|application|games?|websites?|web ?pages?|web app|apis?|backend|server|cli|bot|program|script|dashboard|tracker|calculator|extension|library|package|codebase)\b|\b(python|javascript|typescript|node(\.?js)?|react|html|java|rust|golang|c\+\+|flask|express)\b[^.?!]*\b(project|app|program)\b/i;

export const AGENT_SPECS: Record<AgentName, AgentSpec> = {
  InfraPilot: {
    description: "connecting integrations (Slack, GitHub, Notion, Google Calendar, Gmail, Google Drive) and doing things in them once approved (post a Slack message, open a GitHub issue, add to a Notion page, save a Gmail draft); reading and summarizing the user's Gmail; finding, reading and summarizing Google Drive files and saving new Google Docs; adding and using MCP servers and their tools; workflows; creating skills (\"/start_my_day\"), custom agents and daily routines; reading the user's calendar.",
    keywords: [
      /\bintegrat\w*\b/i, /\bmcp\b/i, /\bmodel context protocol\b/i, /\bworkflow\b/i, /\bschedule[sd]?\b/i,
      /\b(e-?mails?|inbox|gmail)\b/i, /\b(google drive|gdrive|google docs?|google sheets?|google slides)\b|\b(in|from|to) my drive\b/i,
      // Links that need the user's account: read through the integration.
      /\b(docs|drive|sheets|slides)\.google\.com\/|\bgithub\.com\/[\w.-]+\/[\w.-]+|\bnotion\.(so|site)\//i,
      /\b(post|send|message|tell|announce)\b[^.?!]*\bslack\b|\bslack\b[^.?!]*\b(channel|message)\b/i,
      /\b(open|create|file|make|submit)\b[^.?!]*\b(github\s+)?issue\b[^.?!]*\b(github|repo\w*|[\w.-]+\/[\w.-]+)\b/i, /\bnotion\b/i,
      /\bconnector\b/i, /\bcustom agent\b/i, /\bautomat\w*\b/i, /\bskills?\b/i, /\broutines?\b/i,
      /\b(create|make|build|add)\b[^.?!]*\bagent\b/i, /\bmy agents\b/i,
      /\b(my |the )?(calendar|agenda)\b|\b(events|meetings|appointments)\b[^.?!]*\b(today|tomorrow|this week|next)\b/i,
      // "connect Slack" -- but not "connect an LED to my Arduino" (that's HardwarePilot).
      new RegExp(`\\bconnect\\b(?![^.?!]*\\b(${HARDWARE_WORDS})\\b)`, "i"),
    ],
    budget: { timeoutMs: 60000, maxRetries: 0 },
  },
  Helper: {
    description:
      "general questions, facts, everyday math, and searching the user's own files/notes/docs. The DEFAULT for anything that doesn't clearly fit another specialist.",
    keywords: [
      /\bresearch\b/i, /\bfind\b/i, /\bsearch\b/i, /\blocate\b/i, /\block up\b/i,
      /\bmy (project|notes|docs|files)\b/i, /\bimprove my project\b/i, /\bcontext\b/i, /\bevidence\b/i,
      WEB_RESEARCH,
      // Lessons learned from feedback: "what have you learned?", "forget lesson 3".
      /\bwhat (have )?you (learned|learnt)\b|\b(your|the) lessons\b|\bforget (lesson|everything you)\b/i,
    ],
    // Web research (search + several page reads + a summary) needs time; the web tools stop at 90 s,
    // leaving room for the answer. No retry: it would repeat every web call.
    budget: { timeoutMs: 120000, maxRetries: 0 },
  },
  CodePilot: {
    description: "writing code (it runs and tests what it writes), scanning code for bugs/security issues and writing fixes to approve, and its always-on code alerts.",
    keywords: [
      /\bcode\b/i, /\bbug\b/i, /\bvulnerabilit\w*\b/i, /\bsecurity\b/i, /\bscan\b/i,
      /\brefactor\b/i, /\bcheck my code\b/i, /\bfunction\b/i, /\brepo\b/i,
      // Building software: apps, games, sites, APIs -- and whole projects in a programming language.
      BUILD_SOFTWARE,
      // Running things: "run the tests in my snake game project", "run `npm test`".
      /\b(run|execute|launch)\b[^.?!]*(`[^`]+`|\b(tests?|test suite|command|script|npm|pip|pytest|python3?|main\.py)\b)/i,
      /\b(add|change|update|implement|extend|convert|rewrite|modify|upgrade)\b[^.?!]*\b(my|the|this|our)\s+(?:[\w-]+\s+){0,3}(codebase|code ?base|repo|app|game|website|program)\b/i,
      // Always-on alerts: "alert me only for critical issues", "turn off code alerts".
      /\b(code|security|codepilot) alerts?\b|\balert me\b[^.?!]*\b(issues?|bugs?|vulnerab\w*|problems?)\b/i,
    ],
    buildsOn: [{ agent: "Helper", when: REVIEW_INTENT, reason: "scans the files Helper located" }],
    // generate -> test -> repair -> resample chains several model calls; don't retry the whole chain.
    budget: { timeoutMs: 60000, maxRetries: 0 },
  },
  PromptPilot: {
    description: "rewriting/refining a prompt for an AI tool.",
    keywords: [/\bprompt\b/i, /\bclarify\b/i, /\bbetter prompt\b/i, /\brephrase\b/i, /\binstructions for\b/i],
    budget: { timeoutMs: 25000, maxRetries: 1 },
  },
  ScienceLab: {
    description: "ONLY science simulations: projectile motion, free fall, pendulums, population growth, predator–prey, radioactive decay, medicine levels in the body, cooling, soil moisture, and where a soil type is found.",
    keywords: [
      /\bsimulat\w*\b/i, /\bexperiment\b/i, /\bsoil\b/i, /\benvironment\b/i, /\bprojectile\b/i,
      /\bpopulation growth\b/i, /\bmoisture\b/i,
      /\bpendulum\b/i, /\bhalf[- ]?life\b|\bradioactive\b|\bcarbon[- ]14\b/i, /\bfree[- ]?fall\b|\bdropped (from|off)\b|\bfalls? from\b/i,
      /\b(predators?|prey|lotka)\b/i, /\bnewton'?s law of cooling\b|\b(coffee|tea)\b[^.?!]*\bcool/i,
      /\b(mg|dose|medicine|drug)\b[^.?!]*\b(in (my|the) body|bloodstream|half[- ]?life|every \d+ hours?)\b/i,
      /\b(soil|dirt)\b[^.?!]*\b(where|location|region|which (place|part))\b|\bwhere\b[^.?!]*\b(soil|dirt)\b/i,
      // "a ball thrown at 20 m/s", "how far does it travel", "launched at 30 degrees"
      /\b(thrown|launched|kicked|fired|shot)\b[^.?!]*\b(m\/s|km\/h|degrees?|upward|in the air|how far|how high)\b/i,
    ],
    narrow: true,
    budget: { timeoutMs: 6000, maxRetries: 1 },
  },
  ScriptScholar: {
    description: "ONLY ancient writing systems (hieroglyphs, cuneiform, Linear A/B, Phoenician, Brahmi, runes...): comparing them, and analysing/deciphering text in an unknown or ancient script.",
    keywords: [
      /\bancient script\b/i, /\bcuneiform\b/i, /\bhieroglyph\w*\b/i, /\bphoenician\b/i,
      /\blinear [ab]\b/i, /\bbrahmi\b/i, /\bepigraph\w*\b/i, /\balphabet\b/i,
      /\bdecipher\w*\b/i, /\b(unknown|mystery|undeciphered|ancient) (script|writing|symbols|inscription)s?\b/i, /\b(runes?|runic|ogham|inscription|transliterat\w*)\b/i,
    ],
    narrow: true,
    budget: { timeoutMs: 4000, maxRetries: 1 },
  },
  LearnPilot: {
    description: "teaching -- explanations, lessons, quizzes, flashcards, study plans.",
    keywords: [
      /\bstudy\b/i, /\blearn\b/i, /\bexplain\b/i, /\bquiz\b/i, /\bflashcard\b/i,
      /\blesson\b/i, /\bconcept\b/i, /\bgrade(r)?\b/i, /\btutor\b/i, /\bhomework\b/i, /\bteach\b/i,
      /\bhow (does|do) (it|this|that|they|these|those)\b[^?.!]*\bwork/i, /\bwhy does (it|this|that) work\b/i,
    ],
    buildsOn: [
      { agent: "HardwarePilot", reason: "explains the concepts behind HardwarePilot's wiring (voltage, ground, resistors...)" },
      { agent: "CodePilot", reason: "teaches the concepts behind CodePilot's code or findings" },
      { agent: "ScienceLab", reason: "explains ScienceLab's simulation results" },
      { agent: "ScriptScholar", reason: "builds the lesson on ScriptScholar's comparison" },
      { agent: "InfraPilot", when: /\b(google drive|gdrive|my drive|google docs?)\b/i, reason: "teaches and quizzes from the Google Drive file InfraPilot reads" },
    ],
    // lesson -> answer-key vote chains several model calls.
    budget: { timeoutMs: 45000, maxRetries: 0 },
  },
  WatcherPilot: {
    description:
      "parental focus control (like GoGuardian): sets up a focus session from a parent's instruction (e.g. \"learn math, no AI\"), blocks AI sites/extensions and off-task sites, answers whether a site is allowed.",
    keywords: [
      /\bno ai\b/i, /\bblock (all )?(ai|sites?|websites?|apps?|youtube|games?|extensions?)\b/i, /\bfocus (mode|time|session)\b/i,
      /\bparental\b/i, /\bscreen ?time\b/i, /\bon[- ]task\b/i, /\bdistract\w*\b/i, /\bgoguardian\b/i, /\bwatcher\b/i,
      /\b(is|are) \S+(\s\S+)? (allowed|blocked)\b/i, /\bunblock\b/i,
    ],
    narrow: true,
    budget: { timeoutMs: 20000, maxRetries: 0 },
  },
  HardwarePilot: {
    description:
      "how to physically connect hardware: Arduino/Raspberry Pi circuits, sensors, LEDs, motors, and plugging in monitors, PCs and devices -- with an interactive step-by-step wiring diagram.",
    keywords: [new RegExp(`\\b(${HARDWARE_WORDS})\\b`, "i"), /\bhardware\b/i, /\bplug (in|into)\b/i, /\bhook (up|it up)\b/i],
    budget: { timeoutMs: 30000, maxRetries: 0 },
  },
  MathPilot: {
    description:
      "checking whether a math identity/equation is true (e.g. \"is sin(x)^2 + cos(x)^2 = 1?\"), reporting its always-on search for new formulas for constants like pi, and teaching mental-math tricks (\"a quick way to do 34 × 11\").",
    keywords: [
      /\bmathpilot\b/i, /\bidentit(y|ies)\b/i, /\bconjectures?\b/i, /\bcontinued fractions?\b/i, /\bmath(s)? discover\w*\b/i,
      // Mental-math tricks: "math trick", "mental math", "quick way to multiply by 11".
      /\b(math|maths|mental[- ]math|multiplication|arithmetic|divisibility) (tricks?|shortcuts?|hacks?)\b|\bmental math\b|\b(tricks?|shortcut) (for|to)\b[^.?!]*\b(multiply|multiplying|squar|divid|times|percent|\d)/i,
      /\bquick(ly| way)\b[^.?!]*\b(multiply|multiplying|square|squaring|times|divide|dividing)\b|\bin (your|my) head\b/i,
      /\b(new|undiscovered) (math|formulas?)\b/i, /\b(formulas?|discoveries) for (pi|π|e|zeta|catalan)\b/i,
      // "is it true that A = B", "check: A = B" -- but not "solve 2x = 6" (Helper does everyday math).
      // ...and not code that happens to contain "=" ("check my code: const q = ...").
      /^(?![^=]*\b(solve|find|what is|what's|how much|calculate)\b)(?![\s\S]*([;{}'"`]|\b(const|let|var|function|def|return|select|import)\b))[^=]*\b(is it true|check|verify|prove|test|confirm|is|does)\b[^=]*[^<>!=]=(?!=)/i,
    ],
    narrow: true,
    budget: { timeoutMs: 25000, maxRetries: 0 },
  },
  PicturePilot: {
    description: "making a picture or illustration (\"draw a cat in space\"). Still images only, no video.",
    keywords: [
      // Not "draw a wiring diagram" or "draw a graph" -- those belong to HardwarePilot / Helper.
      /\b(draw|sketch|paint|illustrate)\b(?![^.?!]*\b(diagram|circuit|wiring|schematic|graph|chart|conclusion)s?\b)/i,
      /\b(make|create|generate|design|show)\b[^.?!]*\b(picture|image|drawing|illustration|painting|poster|artwork|wallpaper)\b/i,
      /\b(picture|image|drawing|illustration|painting) of\b/i,
    ],
    narrow: true,
    describesOneThing: true,
    // The plan is one model call.
    budget: { timeoutMs: 45000, maxRetries: 0 },
  },
  SchoolPilot: {
    description:
      "school stuff: keeping track of homework, projects and tests with due dates (\"I have a science project due Friday\", \"what's due?\"), planning big assignments and study sessions before a test, and helping with essays and homework step by step.",
    keywords: [
      /\b(homework|assignments?|worksheet|science fair|school project|book report|lab report)\b/i,
      /\bwhat'?s due\b|\bdue (on |by |this |next )?(today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|in \d+ days?)\b/i,
      /\b(test|exam|quiz|midterm|final)s? (is |on |next |this |tomorrow|today|monday|tuesday|wednesday|thursday|friday)/i,
      /\b(essay|paper)\b[^.?!]*\b(outline|thesis|due|feedback|for (school|class))\b|\b(outline|thesis) for my (essay|paper)\b/i,
      /\b(school|teacher|my class(es)?)\b/i,
    ],
    // Planning a big assignment is one model call; help with an essay is one longer one.
    budget: { timeoutMs: 45000, maxRetries: 0 },
  },
  ModelPilot: {
    description:
      "interactive 3D models you can rotate, take apart (exploded view) and click part by part, exported for 3D printing (\"build a 3D model of a game console you can explore through its parts\", \"a 3D water molecule\", then \"make it blue\"). Exact ball-and-stick molecules.",
    keywords: [
      /\b3-?d\b/i, /\b(cad|stl|glb|3d print\w*)\b/i,
      /\b(model|replica|mock-?up)\b[^.?!]*\b(explore|parts?|take apart|exploded|rotate)\b/i,
      /\b(molecule|molecular model|ball[- ]and[- ]stick)\b/i,
    ],
    describesOneThing: true,
    // Designing is one long model call, plus one repair call if parts float.
    budget: { timeoutMs: 150000, maxRetries: 0 },
  },
};
