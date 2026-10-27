import type { AgentFn } from "./base.js";
import { assertNotAborted, evidence, logAgentAction } from "./base.js";

/** The first pattern that matches gives the value (its first group); otherwise the default, marked as assumed. */
function num(text: string, patterns: RegExp | RegExp[], fallback: number): { value: number; inferred: boolean } {
  for (const pattern of Array.isArray(patterns) ? patterns : [patterns]) {
    const m = text.match(pattern);
    if (m) return { value: parseFloat(m[1].replace(/,/g, "")), inferred: false };
  }
  return { value: fallback, inferred: true };
}

/** A rate written as a percent ("10%", or "rate of 10") becomes a fraction (0.1); "0.1" stays as it is. */
function fraction(text: string, patterns: RegExp[], fallback: number) {
  const r = num(text, patterns, fallback);
  if (r.inferred) return r;
  const m = patterns.map((p) => text.match(p)).find(Boolean);
  const percent = /%|percent/i.test(m?.[0] ?? "") || r.value > 1;
  return { value: percent ? r.value / 100 : r.value, inferred: false };
}

const N = String.raw`(\d[\d,]*(?:\.\d+)?)`;

type SimKind = "projectile" | "population" | "soil_moisture" | "pendulum" | "free_fall" | "decay" | "medicine" | "predator_prey" | "cooling" | "soil_location" | "unsupported";

function detectSim(text: string): SimKind {
  // "I found red clay dirt, where could I be?": the doc's soil -> location idea.
  if (/\b(soil|dirt|earth|ground)\b/i.test(text) && /\b(where|location|region|place|area|country|identify|which part)\b/i.test(text)) return "soil_location";
  if (/\bpendulum\b/i.test(text)) return "pendulum";
  if (/\b(half[- ]?life|radioactiv|decay|carbon[- ]14|isotope)\b/i.test(text) && !/\b(dose|mg|medicine|drug|pill|tablet)\b/i.test(text)) return "decay";
  if (/\b(dose|dosage|mg|medicine|medication|drug|pill|tablet|ibuprofen|paracetamol|acetaminophen|caffeine)\b/i.test(text) && /\b(half[- ]?life|every|body|bloodstream|level|concentration|hours?)\b/i.test(text)) return "medicine";
  if (/\b(predator|prey|lotka|foxes|wolves|hares)\b/i.test(text)) return "predator_prey";
  if (/\b(cool(s|ing)?|newton'?s law of cooling|coffee|tea)\b/i.test(text) && /°|degrees?|\btemp/i.test(text)) return "cooling";
  if (/\b(free[- ]?fall|dropped|falls? from|fall(ing)? from)\b/i.test(text)) return "free_fall";
  if (/projectile|launch|trajectory/i.test(text)) return "projectile";
  if (/population|growth rate|carrying capacity|logistic/i.test(text)) return "population";
  if (/soil|moisture|evaporat/i.test(text)) return "soil_moisture";
  if (/simulat|experiment/i.test(text)) return "unsupported";
  return "unsupported";
}

function runProjectile(text: string) {
  // "20 m/s", "speed of 20", "at 72 km/h" (converted), "45 degrees", "45°", "angle of 45".
  const kmh = num(text, [new RegExp(`${N}\\s*(?:km\\/h|kph|kilometers? per hour)`, "i")], NaN);
  const speed = kmh.inferred
    ? num(text, [new RegExp(`${N}\\s*(?:m\\/s|mps|meters? per second|metres? per second)`, "i"), new RegExp(`(?:speed|velocity)\\s*(?:of|=|:|is)?\\s*${N}`, "i")], 20)
    : { value: round(kmh.value / 3.6), inferred: false };
  const angleDeg = num(text, [new RegExp(`${N}\\s*(?:°|deg\\b|degrees?)`, "i"), new RegExp(`angle\\s*(?:of|=|:|is)?\\s*${N}`, "i")], 45);
  const g = 9.81;
  const rad = (angleDeg.value * Math.PI) / 180;
  const timeOfFlight = (2 * speed.value * Math.sin(rad)) / g;
  const range = (speed.value ** 2 * Math.sin(2 * rad)) / g;
  const maxHeight = (speed.value ** 2 * Math.sin(rad) ** 2) / (2 * g);
  return {
    inputs: { initialSpeedMs: speed.value, launchAngleDeg: angleDeg.value, gravity: g },
    inferred: { initialSpeedMs: speed.inferred, launchAngleDeg: angleDeg.inferred },
    outputs: {
      timeOfFlightSec: round(timeOfFlight),
      rangeMeters: round(range),
      maxHeightMeters: round(maxHeight),
    },
    note: `Projectile launched at ${speed.value} m/s, ${angleDeg.value}° (no air resistance, flat ground).`,
  };
}

function runPopulation(text: string) {
  // "initial population of 50", "starting with 50 rabbits", "50 rabbits"; "growth rate of 10%" (or 0.1); "carrying capacity of 500", "capacity 500".
  const initial = num(text, [new RegExp(`(?:initial|starting)(?: population)?\\s*(?:of|=|:|is)?\\s*${N}`, "i"), new RegExp(`(?:start(?:s|ing)? (?:with|at)|begin(?:s|ning)? with)\\s*${N}`, "i"), new RegExp(`${N}\\s+(?:rabbits|deer|bacteria|cells|animals|fish|birds|people|individuals|organisms|insects|wolves|mice)`, "i")], 100);
  const rate = fraction(text, [new RegExp(`(?:growth )?rate\\s*(?:of|=|:|is)?\\s*${N}\\s*(?:%|percent)?`, "i"), new RegExp(`(?:grows?|growing|increases?) (?:by|at)\\s*${N}\\s*(?:%|percent)?`, "i")], 0.1);
  const capacity = num(text, [new RegExp(`(?:carrying )?capacity\\s*(?:of|=|:|is)?\\s*${N}`, "i"), new RegExp(`(?:max(?:imum)?|limit) (?:of|=|:|is)?\\s*${N}`, "i")], 1000);
  const steps = 10;
  const series: number[] = [initial.value];
  for (let t = 1; t <= steps; t++) {
    const prev = series[t - 1];
    const next = prev + rate.value * prev * (1 - prev / capacity.value);
    series.push(round(next));
  }
  return {
    inputs: { initialPopulation: initial.value, growthRate: rate.value, carryingCapacity: capacity.value, steps },
    inferred: { initialPopulation: initial.inferred, growthRate: rate.inferred, carryingCapacity: capacity.inferred },
    outputs: { series },
    note: `Logistic growth over ${steps} steps; population approaches carrying capacity ${capacity.value}.`,
  };
}

function runSoilMoisture(text: string) {
  const initialMoisture = num(text, [new RegExp(`moisture\\s*(?:of|=|:|is|at)?\\s*${N}`, "i"), new RegExp(`${N}\\s*%\\s*(?:soil )?moisture`, "i")], 35); // percent
  const evapRate = fraction(text, [new RegExp(`evaporat\\w*\\s*(?:rate)?\\s*(?:of|=|:|is)?\\s*${N}\\s*(?:%|percent)?`, "i")], 0.05); // fraction/day
  const rainfallMm = num(text, [new RegExp(`rain(?:fall)?\\s*(?:of|=|:|is)?\\s*${N}`, "i"), new RegExp(`${N}\\s*mm(?: of)? rain`, "i")], 0);
  const days = 7;
  const series: number[] = [initialMoisture.value];
  for (let d = 1; d <= days; d++) {
    const prev = series[d - 1];
    const next = Math.max(0, prev * (1 - evapRate.value) + rainfallMm.value * 0.3);
    series.push(round(next));
  }
  return {
    inputs: { initialMoisturePct: initialMoisture.value, evaporationRate: evapRate.value, rainfallMm: rainfallMm.value, days },
    inferred: { initialMoisturePct: initialMoisture.inferred, evaporationRate: evapRate.inferred, rainfallMm: rainfallMm.inferred },
    outputs: { moistureSeriesPct: series },
    note: `Soil moisture projected over ${days} days with ${rainfallMm.value}mm/day rainfall input; simplified single-layer bucket model.`,
  };
}

function round(n: number) {
  return Math.round(n * 100) / 100;
}

/** Surface gravity, so "on the Moon" or "on Mars" changes the physics. */
function gravityFor(text: string): { g: number; where: string } {
  if (/\bmoon\b/i.test(text)) return { g: 1.62, where: "the Moon" };
  if (/\bmars\b/i.test(text)) return { g: 3.71, where: "Mars" };
  if (/\bjupiter\b/i.test(text)) return { g: 24.79, where: "Jupiter" };
  return { g: 9.81, where: "Earth" };
}

type Sim = { inputs: Record<string, unknown>; inferred: Record<string, boolean>; outputs: Record<string, unknown>; note: string; table?: [string, string][] };

const METERS = String.raw`\s*(?:m\b|meters?|metres?)`;

function runPendulum(text: string): Sim {
  const L = num(text, [new RegExp(`${N}${METERS}`, "i"), new RegExp(`(?:length|long)\\s*(?:of|=|:|is)?\\s*${N}`, "i")], 1);
  const { g, where } = gravityFor(text);
  const period = 2 * Math.PI * Math.sqrt(L.value / g);
  return {
    inputs: { lengthM: L.value, gravity: g },
    inferred: { lengthM: L.inferred },
    outputs: { periodSec: round(period), swingsPerMinute: round(60 / period), frequencyHz: round(1 / period) },
    note: `A ${L.value} m pendulum on ${where} (small swings, no friction): period T = 2π√(L/g).`,
    table: [["One full swing (there and back)", `${round(period)} s`], ["Swings per minute", `${round(60 / period)}`], ["Frequency", `${round(1 / period)} Hz`]],
  };
}

function runFreeFall(text: string): Sim {
  const h = num(text, [new RegExp(`(?:from|height of)\\s*(?:a\\s+)?${N}${METERS}`, "i"), new RegExp(`${N}${METERS}\\s*(?:high|tall|up|building|tower|cliff)`, "i"), new RegExp(`${N}${METERS}`, "i")], 20);
  const { g, where } = gravityFor(text);
  const t = Math.sqrt((2 * h.value) / g);
  const v = g * t;
  return {
    inputs: { heightM: h.value, gravity: g },
    inferred: { heightM: h.inferred },
    outputs: { fallTimeSec: round(t), impactSpeedMs: round(v), impactSpeedKmh: round(v * 3.6) },
    note: `Dropped from ${h.value} m on ${where}, no air resistance: t = √(2h/g), v = g·t.`,
    table: [["Time to hit the ground", `${round(t)} s`], ["Speed at impact", `${round(v)} m/s (${round(v * 3.6)} km/h)`]],
  };
}

/** "5730 years", "8 days", "6 hours" -> value and unit. */
function duration(text: string, pattern: RegExp, fallback: { value: number; unit: string }) {
  const m = pattern.exec(text);
  return m ? { value: parseFloat(m[1].replace(/,/g, "")), unit: (m[2] ?? fallback.unit).toLowerCase().replace(/s$/, ""), inferred: false } : { ...fallback, inferred: true };
}

const TIME_UNITS = "(years?|days?|hours?|minutes?|seconds?)";

function runDecay(text: string): Sim {
  const half = duration(text, new RegExp(`half[- ]?life\\s*(?:of|=|:|is)?\\s*${N}\\s*${TIME_UNITS}`, "i"), { value: 5730, unit: "year" });
  const N0 = num(text, [new RegExp(`${N}\\s*(?:g\\b|grams?|kg|atoms?)`, "i"), new RegExp(`(?:start(?:ing)? with|initial(?: amount)?(?: of)?)\\s*${N}`, "i")], 100);
  const elapsed = duration(text, new RegExp(`(?:after|in|over)\\s*${N}\\s*${TIME_UNITS}`, "i"), { value: half.value * 3, unit: half.unit });
  const remaining = (t: number) => N0.value * Math.pow(0.5, t / half.value);
  const steps = [0, 1, 2, 3, 4].map((k) => k * half.value);
  return {
    inputs: { halfLife: `${half.value} ${half.unit}s`, initialAmount: N0.value, elapsed: `${elapsed.value} ${elapsed.unit}s` },
    inferred: { halfLife: half.inferred, initialAmount: N0.inferred, elapsed: elapsed.inferred },
    outputs: { remainingAfterElapsed: round(remaining(elapsed.value)), percentLeft: round((remaining(elapsed.value) / N0.value) * 100) },
    note: `Radioactive decay: N(t) = N₀ · (1/2)^(t / half-life). Every ${half.value} ${half.unit}s, half of what's left decays.`,
    table: [
      [`Left after ${elapsed.value} ${elapsed.unit}s`, `${round(remaining(elapsed.value))} (${round((remaining(elapsed.value) / N0.value) * 100)}%)`],
      ...steps.map((t): [string, string] => [`After ${t} ${half.unit}s`, `${round(remaining(t))}`]),
    ],
  };
}

function runMedicine(text: string): Sim {
  const dose = num(text, [new RegExp(`${N}\\s*mg\\b`, "i")], 200);
  const half = duration(text, new RegExp(`half[- ]?life\\s*(?:of|=|:|is)?\\s*${N}\\s*(hours?|hrs?|h\\b|minutes?)`, "i"), { value: 4, unit: "hour" });
  const halfH = /min/.test(half.unit) ? half.value / 60 : half.value;
  const every = num(text, [new RegExp(`every\\s*${N}\\s*(?:hours?|hrs?|h\\b)`, "i")], NaN);
  const interval = Number.isNaN(every.value) ? null : every.value;
  const k = Math.LN2 / halfH;
  // One-compartment model, instant absorption: each dose adds `dose` mg, and everything leaves at rate k.
  const hours = interval ? Math.max(24, interval * 6) : Math.max(12, Math.ceil(halfH * 5));
  const step = Math.max(1, Math.round(hours / 12));
  const amountAt = (t: number) => {
    let a = 0;
    if (interval) for (let d = 0; d <= t + 1e-9; d += interval) a += dose.value * Math.exp(-k * (t - d));
    else a = dose.value * Math.exp(-k * t);
    return a;
  };
  const points: [number, number][] = [];
  for (let t = 0; t <= hours; t += step) points.push([t, amountAt(t)]);
  const steadyPeak = interval ? dose.value / (1 - Math.exp(-k * interval)) : dose.value;
  const steadyTrough = interval ? steadyPeak * Math.exp(-k * interval) : 0;
  return {
    inputs: { doseMg: dose.value, halfLifeHours: round(halfH), everyHours: interval },
    inferred: { doseMg: dose.inferred, halfLifeHours: half.inferred },
    outputs: interval ? { steadyStatePeakMg: round(steadyPeak), steadyStateTroughMg: round(steadyTrough) } : { mgLeftAfter24h: round(dose.value * Math.exp(-k * 24)) },
    note: `How much of a ${dose.value} mg dose stays in the body (half-life ${round(halfH)} h${interval ? `, taken every ${interval} h` : ", one dose"}). A simplified one-compartment model for learning only, not medical advice: follow the label and your doctor.`,
    table: [
      ...(interval ? ([["Highest level once it settles", `${round(steadyPeak)} mg`], ["Lowest level once it settles", `${round(steadyTrough)} mg`]] as [string, string][]) : []),
      ...points.map(([t, a]): [string, string] => [`${t} h`, `${round(a)} mg`]),
    ],
  };
}

function runPredatorPrey(text: string): Sim {
  const prey = num(text, [new RegExp(`${N}\\s*(?:rabbits|hares|prey|deer|mice|fish)`, "i")], 40);
  const pred = num(text, [new RegExp(`${N}\\s*(?:foxes|wolves|predators|lynx|owls|sharks)`, "i")], 9);
  // Lotka-Volterra with classroom constants, integrated with RK4 (stable over the cycles it makes).
  const a = 0.1;
  const b = 0.02;
  const c = 0.3;
  const d = 0.01;
  const f = (x: number, y: number) => [a * x - b * x * y, d * x * y - c * y];
  let x = prey.value;
  let y = pred.value;
  const dt = 0.1;
  const rows: [string, string][] = [];
  let maxX = x, maxY = y, minX = x, minY = y;
  for (let i = 0; i <= 2000; i++) {
    if (i % 250 === 0) rows.push([`t = ${round(i * dt)}`, `${Math.round(x)} prey, ${Math.round(y)} predators`]);
    const [k1x, k1y] = f(x, y);
    const [k2x, k2y] = f(x + (dt / 2) * k1x, y + (dt / 2) * k1y);
    const [k3x, k3y] = f(x + (dt / 2) * k2x, y + (dt / 2) * k2y);
    const [k4x, k4y] = f(x + dt * k3x, y + dt * k3y);
    x = Math.max(0, x + (dt / 6) * (k1x + 2 * k2x + 2 * k3x + k4x));
    y = Math.max(0, y + (dt / 6) * (k1y + 2 * k2y + 2 * k3y + k4y));
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
  }
  return {
    inputs: { prey: prey.value, predators: pred.value, preyBirth: a, predation: b, predatorDeath: c, predatorGrowth: d },
    inferred: { prey: prey.inferred, predators: pred.inferred },
    outputs: { preyRange: [Math.round(minX), Math.round(maxX)], predatorRange: [Math.round(minY), Math.round(maxY)] },
    note: "Predator–prey cycles (Lotka–Volterra): prey grow, predators feast and multiply, prey crash, predators starve, and it repeats, with predators peaking just after prey.",
    table: [["Prey swing between", `${Math.round(minX)} and ${Math.round(maxX)}`], ["Predators swing between", `${Math.round(minY)} and ${Math.round(maxY)}`], ...rows],
  };
}

function runCooling(text: string): Sim {
  const temps = [...text.matchAll(/(-?\d+(?:\.\d+)?)\s*(?:°\s*c?|degrees?(?:\s*c(?:elsius)?)?|c\b)/gi)].map((m) => Number(m[1]));
  const T0 = { value: temps[0] ?? 90, inferred: temps.length < 1 };
  const room = temps.length > 1 ? { value: temps[1], inferred: false } : { value: 20, inferred: true };
  const target = temps.length > 2 ? temps[2] : 60;
  const k = 0.05; // per minute: a mug of coffee in still air
  const T = (t: number) => room.value + (T0.value - room.value) * Math.exp(-k * t);
  const toTarget = target > room.value && target < T0.value ? Math.log((T0.value - room.value) / (target - room.value)) / k : null;
  return {
    inputs: { startC: T0.value, roomC: room.value, coolingRatePerMin: k },
    inferred: { startC: T0.inferred, roomC: room.inferred },
    outputs: { minutesToReachTarget: toTarget === null ? null : round(toTarget), targetC: target },
    note: "Newton's law of cooling: T(t) = room + (start − room)·e^(−kt). The hotter it is compared with the room, the faster it cools.",
    table: [...(toTarget !== null ? ([[`Reaches ${target}°C`, `after about ${Math.round(toTarget)} min`]] as [string, string][]) : []), ...[0, 5, 10, 20, 30, 60].map((t): [string, string] => [`${t} min`, `${round(T(t))}°C`])],
  };
}

/** Soil types and where they're typically found: the doc's "find location from types of dirt". */
const SOILS: { names: RegExp; type: string; where: string; clues: string }[] = [
  { names: /\b(red|laterite|lateritic|rusty)\b/i, type: "Laterite / red soil (Oxisols, Ultisols)", where: "warm, wet tropics and subtropics: the southeastern US, Brazil, central Africa, southern India, northern Australia", clues: "red or orange from iron oxides, often clayey, low in nutrients" },
  { names: /\b(black|chernozem|prairie|crumbly)\b/i, type: "Chernozem / black prairie soil (Mollisols)", where: "temperate grasslands: the US Great Plains and Midwest, Ukraine, southern Russia, the Argentine Pampas", clues: "very dark, crumbly and rich in organic matter" },
  { names: /\b(sand|sandy)\b/i, type: "Sandy soil (Aridisols, Entisols)", where: "deserts and dry regions, coasts and river deltas: the Sahara, Arabian Peninsula, US Southwest, coastal dunes", clues: "gritty, drains fast, pale, holds little water" },
  { names: /\b(peat|peaty|bog|boggy|spongy)\b/i, type: "Peat (Histosols)", where: "cool, waterlogged places: Ireland, Scotland, Scandinavia, Canada, Siberia, wetlands", clues: "dark brown, spongy, made of partly rotted plants" },
  { names: /\b(chalk|chalky|limestone|white|pale)\b/i, type: "Chalky / limestone soil (Rendzina)", where: "over limestone: southern England, northern France, parts of Texas and Florida, the Mediterranean", clues: "pale, stony, alkaline, fizzes with vinegar" },
  { names: /\b(clay|sticky|cracked|cracks)\b/i, type: "Clay soil (Vertisols when it cracks)", where: "river floodplains and some dry regions: the Nile valley, Texas Blackland Prairie, India's Deccan, eastern Australia", clues: "sticky when wet, cracks when dry, holds water" },
  { names: /\b(silt|silty|loess|powdery|floury)\b/i, type: "Silt / loess", where: "river valleys and wind-blown deposits: the Mississippi valley, China's Loess Plateau, the Rhine and Danube basins", clues: "smooth and floury, very fertile, erodes easily" },
  { names: /\b(loam|loamy)\b/i, type: "Loam (Alfisols)", where: "temperate forests and farmland: much of Europe, the eastern and midwestern US, eastern China", clues: "a balanced mix of sand, silt and clay; good for farming" },
  { names: /\b(frozen|permafrost|tundra)\b/i, type: "Tundra / permafrost soil (Gelisols)", where: "the Arctic: northern Alaska, Canada, Greenland, Siberia, Scandinavia's far north", clues: "frozen below the surface all year" },
  { names: /\b(ash|volcanic|andisol)\b/i, type: "Volcanic ash soil (Andisols)", where: "near volcanoes: Japan, Indonesia, the Pacific Northwest, Iceland, the Andes, Hawaii", clues: "light, porous, very fertile, often dark" },
];

export function soilLocation(text: string): { findings: string[]; matched: number } {
  const hits = SOILS.filter((s) => s.names.test(text));
  if (hits.length === 0) {
    return {
      findings: [`Describe the soil (colour, feel, what it's made of) and I'll suggest where it's typically found. For example: "red clay dirt", "black crumbly soil", "pale chalky soil with stones". Types I know: ${SOILS.map((s) => s.type.split(" (")[0]).join(", ")}.`],
      matched: 0,
    };
  }
  return {
    findings: [
      `**Where this kind of soil is typically found**\n${hits.map((s) => `- **${s.type}**: ${s.where}. _Clues: ${s.clues}._`).join("\n")}`,
      "Soil narrows the region down, but it can't pinpoint a location by itself: combine it with climate, plants and landforms (and a soil map such as the USDA Web Soil Survey or the FAO World Soil Map) to get closer.",
    ],
    matched: hits.length,
  };
}


export const scienceLabAgent: AgentFn = async (input, ctx) => {
  assertNotAborted(ctx);
  const kind = detectSim(input.requestText);
  logAgentAction(input.runId, "ScienceLab", "select_simulation", { kind }, "selected");

  if (kind === "soil_location") {
    const r = soilLocation(input.requestText);
    logAgentAction(input.runId, "ScienceLab", "soil_location", { matched: r.matched }, "completed");
    return { status: r.matched ? "success" : "partial_success", findings: r.findings, evidence: [evidence("sciencelab-soil-reference", "USDA soil orders and where they occur")], confidence: r.matched ? 0.75 : 0.4, limitations: [], proposedActions: [] };
  }

  if (kind === "unsupported") {
    logAgentAction(input.runId, "ScienceLab", "run_simulation", { kind }, "not_implemented");
    return {
      status: "failed_safe",
      findings: ["Not implemented: ScienceLab supports projectile motion, free fall, pendulums, population growth, predator–prey cycles, radioactive decay, how medicine levels change in the body, cooling, soil moisture, and where a soil type is found; the requested simulation isn't one of those."],
      evidence: [],
      confidence: 1,
      limitations: ["No simulation was run because the requested type is outside the supported set."],
      proposedActions: [],
    };
  }

  const runners: Record<Exclude<SimKind, "unsupported" | "soil_location">, (t: string) => Sim> = {
    projectile: runProjectile,
    population: runPopulation,
    soil_moisture: runSoilMoisture,
    pendulum: runPendulum,
    free_fall: runFreeFall,
    decay: runDecay,
    medicine: runMedicine,
    predator_prey: runPredatorPrey,
    cooling: runCooling,
  };
  const sim: Sim = runners[kind](input.requestText);

  logAgentAction(input.runId, "ScienceLab", "run_simulation", { kind, inputs: sim.inputs }, "completed");

  const inferredKeys = Object.entries(sim.inferred).filter(([, v]) => v).map(([k]) => k);
  const limitations = [
    "Model is simplified (no air resistance / predator limits / multi-layer soil physics, as applicable) and intended for educational exploration, not field-accurate prediction.",
  ];
  if (inferredKeys.length) {
    limitations.push(`No explicit value was given for: ${inferredKeys.join(", ")}; sensible defaults were used — adjust and re-run for different inputs.`);
  }

  return {
    status: inferredKeys.length ? "partial_success" : "success",
    findings: [
      `Ran ${kind.replace("_", " ")} simulation. ${sim.note}`,
      `Inputs: ${JSON.stringify(sim.inputs)}`,
      `Outputs: ${JSON.stringify(sim.outputs)}`,
      ...(sim.table ? [`| | |\n|---|---|\n${sim.table.map(([k, v]) => `| ${k} | ${v} |`).join("\n")}`] : []),
    ],
    evidence: [evidence("sciencelab-simulation-log", `${kind}: inputs=${JSON.stringify(sim.inputs)} outputs=${JSON.stringify(sim.outputs)}`)],
    confidence: inferredKeys.length ? 0.6 : 0.85,
    limitations,
    proposedActions: [],
  };
};
