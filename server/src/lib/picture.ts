// PicturePilot's renderer. The AI model only *plans* a picture (a
// scene type plus objects from a fixed vocabulary, with positions, sizes and
// colours); this file draws it as an SVG illustration. The model never writes
// SVG itself, so its output can't inject markup, and with no model at all a
// keyword planner still produces a sensible picture.

export const SCENES = ["day", "night", "sunset", "space", "underwater", "indoor", "snow"] as const;
export type Scene = (typeof SCENES)[number];

export const KINDS = [
  "sun", "moon", "star", "cloud", "rainbow", "bird", "butterfly", "balloon", "planet", "rocket",
  "tree", "pine", "flower", "mountain", "house", "castle", "car", "boat",
  "cat", "dog", "fish", "person", "robot", "dinosaur", "snowman",
  "heart", "apple", "book", "ball", "cake", "umbrella",
] as const;
export type Kind = (typeof KINDS)[number];

export interface PictureObject {
  kind: Kind;
  /** Centre, as percentages of the picture's width/height. */
  x: number;
  y: number;
  /** Height as a percentage of the picture's height. */
  size: number;
  color?: string;
}

export interface PictureSpec {
  title: string;
  scene: Scene;
  objects: PictureObject[];
  caption: string;
}

const W = 800;
const H = 500;
const GROUND_Y = 0.72; // fraction of height where the ground starts

const NAMED_COLORS = new Set([
  "red", "orange", "yellow", "gold", "green", "lime", "teal", "cyan", "blue", "navy", "purple", "violet", "magenta", "pink",
  "brown", "tan", "black", "white", "gray", "grey", "silver", "maroon", "olive", "coral", "salmon", "turquoise", "indigo", "beige",
]);

/** Only #hex or a plain colour name ever reaches the SVG. */
export function safeColor(c: unknown, fallback: string): string {
  if (typeof c !== "string") return fallback;
  const v = c.trim().toLowerCase();
  if (/^#[0-9a-f]{3}([0-9a-f]{3})?$/.test(v)) return v;
  if (NAMED_COLORS.has(v)) return v;
  return fallback;
}

const DEFAULT_COLOR: Record<Kind, string> = {
  sun: "#ffd23f", moon: "#f4f1c9", star: "#ffe66d", cloud: "#ffffff", rainbow: "#ff5e5e", bird: "#3d5a80", butterfly: "#c77dff",
  balloon: "#ef476f", planet: "#f4a261", rocket: "#e63946", tree: "#2a9d8f", pine: "#1b7a43", flower: "#ff70a6", mountain: "#8d99ae",
  house: "#e76f51", castle: "#adb5bd", car: "#1d70b8", boat: "#8b5e34", cat: "#f4a259", dog: "#a0522d", fish: "#ff9f1c",
  person: "#457b9d", robot: "#90a4ae", dinosaur: "#52b788", snowman: "#ffffff", heart: "#e5383b", apple: "#d62828",
  book: "#3a86ff", ball: "#ff595e", cake: "#ffafcc", umbrella: "#7209b7",
};

/** Typical size (percent of height) and whether it belongs in the sky. */
const KIND_INFO: Record<Kind, { size: number; sky?: boolean }> = {
  sun: { size: 22, sky: true }, moon: { size: 20, sky: true }, star: { size: 7, sky: true }, cloud: { size: 16, sky: true },
  rainbow: { size: 45, sky: true }, bird: { size: 8, sky: true }, butterfly: { size: 10, sky: true }, balloon: { size: 20, sky: true },
  planet: { size: 24, sky: true }, rocket: { size: 34, sky: true }, tree: { size: 40 }, pine: { size: 42 }, flower: { size: 14 },
  mountain: { size: 50 }, house: { size: 36 }, castle: { size: 48 }, car: { size: 18 }, boat: { size: 26 }, cat: { size: 20 },
  dog: { size: 22 }, fish: { size: 12 }, person: { size: 32 }, robot: { size: 34 }, dinosaur: { size: 40 }, snowman: { size: 34 },
  heart: { size: 20 }, apple: { size: 14 }, book: { size: 16 }, ball: { size: 12 }, cake: { size: 22 }, umbrella: { size: 30 },
};

// --- Safety: this app is used by kids ---

const UNSAFE =
  /\b(nude|naked|nsfw|porn\w*|sex\w*|erotic|lingerie|topless|gore|gory|blood(y)?|decapitat\w*|dismember\w*|corpse|suicide|self[- ]harm|swastika|nazi|kkk|beheading|torture)\b/i;
const REAL_PERSON = /\b(photo|picture|image|deepfake)\s+of\s+(?:president\s+|the\s+)?[A-Z][a-z]+\s+[A-Z][a-z]+/;

export function unsafePictureReason(prompt: string): string | null {
  if (UNSAFE.test(prompt)) return "I can't make that kind of picture.";
  if (REAL_PERSON.test(prompt)) return "I don't make realistic pictures of real people.";
  return null;
}

// --- Planning without a model: words -> objects ---

/** Words for each object (alternatives are whole words; matched case-insensitively). */
const SYNONYMS: [string, Kind][] = [
  ["sun|sunny|sunshine", "sun"], ["moon", "moon"], ["stars?|starry", "star"], ["clouds?|cloudy", "cloud"],
  ["rainbows?", "rainbow"], ["birds?|seagulls?|parrots?", "bird"], ["butterfl(?:y|ies)", "butterfly"],
  ["balloons?", "balloon"], ["planets?|saturn|jupiter|mars", "planet"], ["rockets?|spaceships?|space ship", "rocket"],
  ["pine trees?|christmas trees?|pines?|firs?", "pine"], ["(?<!pine |christmas )trees?|forest|park", "tree"], ["flowers?|roses?|tulips?|garden", "flower"],
  ["mountains?|hills?", "mountain"], ["houses?|home|cottage|cabin", "house"], ["castles?|palace|kingdom", "castle"],
  ["cars?|trucks?|vehicles?", "car"], ["boats?|ships?|sailboats?|sailing", "boat"], ["cats?|kittens?|kitty", "cat"],
  ["dogs?|pupp(?:y|ies)|doggy", "dog"], ["fish(?:es)?|goldfish", "fish"],
  ["people|person|kids?|child(?:ren)?|boys?|girls?|man|woman|men|women|family|friends?|astronauts?", "person"],
  ["robots?", "robot"], ["dinosaurs?|dino|t-?rex", "dinosaur"], ["snowm[ae]n", "snowman"],
  ["hearts?|love", "heart"], ["apples?|fruit", "apple"], ["books?|reading|library", "book"],
  ["balls?|soccer|football|basketball", "ball"], ["cakes?|birthday", "cake"], ["umbrellas?|rainy|raining|rain", "umbrella"],
];

const COUNT_WORDS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, couple: 2, few: 3, many: 5, several: 4, lots: 5 };

export function sceneFromWords(text: string): Scene {
  if (/\b(space|galaxy|outer space|astronaut|planets?|rocket)\b/i.test(text)) return "space";
  if (/\b(underwater|under the sea|ocean floor|coral|aquarium)\b/i.test(text) || (/\bfish\b/i.test(text) && !/\b(boat|ship)\b/i.test(text))) return "underwater";
  if (/\b(snow\w*|winter|snowman|ice|frozen)\b/i.test(text)) return "snow";
  if (/\b(sunset|sunrise|dusk|dawn|evening)\b/i.test(text)) return "sunset";
  if (/\b(night|moon|starry|stars|dark)\b/i.test(text)) return "night";
  if (/\b(room|bedroom|kitchen|classroom|inside|indoors?|table|desk)\b/i.test(text)) return "indoor";
  return "day";
}

/** Objects the prompt names, with counts ("three cats"). */
export function kindsFromWords(text: string): { kind: Kind; count: number }[] {
  const out: { kind: Kind; count: number }[] = [];
  for (const [words, kind] of SYNONYMS) {
    const m = new RegExp(`(?:\\b(\\d+|${Object.keys(COUNT_WORDS).join("|")})\\s+(?:[a-z]+\\s+)?)?\\b(?:${words})\\b`, "i").exec(text);
    if (!m || out.some((o) => o.kind === kind)) continue;
    const n = m[1] ? (COUNT_WORDS[m[1].toLowerCase()] ?? Number(m[1])) : /\bforest\b/i.test(m[0]) ? 4 : /(?:s|ren|men|ies)$/i.test(m[0]) && !/(?:fish|ss|grass)$/i.test(m[0]) ? 2 : 1;
    out.push({ kind, count: Math.max(1, Math.min(5, n || 1)) });
  }
  return out;
}

/** Places objects without a model: sky things up top, ground things spread along the ground. */
export function layoutKinds(items: { kind: Kind; count: number }[], scene: Scene): PictureObject[] {
  const objs: PictureObject[] = [];
  const sky = items.flatMap((i) => Array.from({ length: i.count }, () => i.kind)).filter((k) => KIND_INFO[k].sky || scene === "space" || scene === "underwater");
  const ground = items.flatMap((i) => Array.from({ length: i.count }, () => i.kind)).filter((k) => !sky.includes(k));
  sky.forEach((kind, i) => {
    const x = 12 + ((i * 37 + 20) % 78);
    const y = scene === "space" || scene === "underwater" ? 25 + ((i * 29) % 50) : 14 + ((i * 17) % 26);
    objs.push({ kind, x, y, size: KIND_INFO[kind].size });
  });
  ground.forEach((kind, i) => {
    const size = KIND_INFO[kind].size;
    const x = ground.length === 1 ? 50 : 12 + (76 * i) / (ground.length - 1);
    objs.push({ kind, x, y: GROUND_Y * 100 + 6 - size / 2, size });
  });
  return objs;
}

/**
 * Fixes what a small model gets wrong about layout: objects poking out of the
 * frame, sky things buried in the ground, ground things floating, and several
 * objects stacked on the same spot.
 */
export function arrange(objects: PictureObject[], scene: Scene): void {
  const open = scene === "space" || scene === "underwater";
  const ground = GROUND_Y * 100;
  for (const o of objects) {
    // Big things stay big: a rainbow the size of a sticker doesn't read as a rainbow.
    o.size = Math.max(o.size, KIND_INFO[o.kind].size * 0.6);
    const half = o.size / 2;
    const halfW = (o.size * H) / W / 2; // objects are square: size% of the height
    if (!open && KIND_INFO[o.kind].sky) o.y = Math.min(o.y, ground - half);
    if (!open && !KIND_INFO[o.kind].sky && o.y + half < ground - 6) o.y = ground + 6 - half; // sit on the ground
    o.x = Math.max(halfW + 1, Math.min(100 - halfW - 1, o.x));
    o.y = Math.max(half + 1, Math.min(99 - half, o.y));
  }
  // Boats float on the surface, even in an underwater scene.
  for (const o of objects) if (o.kind === "boat" && scene === "underwater") o.y = o.size / 2 + 1;
  // Several of the same thing in one vertical line (a common small-model habit) get spread sideways.
  const byKind = new Map<string, PictureObject[]>();
  for (const o of objects) byKind.set(o.kind, [...(byKind.get(o.kind) ?? []), o]);
  for (const group of byKind.values()) {
    if (group.length < 2 || !group.every((o) => Math.abs(o.x - group[0].x) < 4)) continue;
    group.forEach((o, i) => {
      const halfW = (o.size * H) / W / 2;
      o.x = Math.max(halfW + 1, Math.min(100 - halfW - 1, 10 + (80 * i) / (group.length - 1)));
    });
  }
  // Spread out objects that landed on (nearly) the same spot.
  for (let i = 1; i < objects.length; i++) {
    for (let tries = 0; tries < 8; tries++) {
      const o = objects[i];
      const clash = objects.slice(0, i).some((p) => Math.abs(p.x - o.x) < Math.max(5, Math.min(p.size, o.size) * 0.35) && Math.abs(p.y - o.y) < Math.max(5, Math.min(p.size, o.size) * 0.35));
      if (!clash) break;
      const halfW = (o.size * H) / W / 2;
      o.x = halfW + 1 + ((o.x - halfW - 1 + 23) % (100 - 2 * halfW - 2));
      if (KIND_INFO[o.kind].sky || open) o.y = Math.max(o.size / 2 + 1, Math.min((open ? 99 : ground) - o.size / 2, o.y + (tries % 2 ? -9 : 7)));
    }
  }
}

export function planFromWords(prompt: string): PictureSpec {
  const scene = sceneFromWords(prompt);
  let items = kindsFromWords(prompt);
  if (items.length === 0) items = [{ kind: "tree", count: 2 }, { kind: "house", count: 1 }];
  if (scene === "day" && !items.some((i) => i.kind === "sun")) items.push({ kind: "sun", count: 1 });
  if (scene === "day" && !items.some((i) => i.kind === "cloud")) items.push({ kind: "cloud", count: 2 });
  if (scene === "night" && !items.some((i) => i.kind === "moon")) items.push({ kind: "moon", count: 1 });
  if (scene === "night" && !items.some((i) => i.kind === "star")) items.push({ kind: "star", count: 5 });
  const objects = layoutKinds(items, scene);
  arrange(objects, scene);
  return { title: titleFrom(prompt), scene, objects, caption: "" };
}

export function titleFrom(prompt: string): string {
  const t = prompt
    .replace(/^.*?\b(draw|paint|sketch|make|create|generate|show)\b\s*(me\s+)?(an?\s+)?(picture|image|drawing|illustration|painting)?\s*(of\s+)?/i, "")
    .replace(/[?.!]+$/, "")
    .trim();
  const s = t || "My picture";
  return s.charAt(0).toUpperCase() + s.slice(1, 80);
}

/** Cleans a model-drafted plan: known kinds only, numbers clamped, colours sanitised; null if unusable. */
/** Things people ask for that the shape set doesn't have, drawn as the closest shape it does. */
const KIND_ALIASES: Record<string, (typeof KINDS)[number]> = {
  dragon: "dinosaur", lizard: "dinosaur", monster: "dinosaur", kitten: "cat", kitty: "cat", lion: "cat", tiger: "cat",
  puppy: "dog", wolf: "dog", fox: "dog", ship: "boat", sailboat: "boat", yacht: "boat", truck: "car", bus: "car",
  spaceship: "rocket", plane: "rocket", airplane: "rocket", ufo: "rocket", palace: "castle", tower: "castle",
  home: "house", cottage: "house", hill: "mountain", volcano: "mountain", rose: "flower", tulip: "flower",
  child: "person", boy: "person", girl: "person", man: "person", woman: "person", astronaut: "person",
  android: "robot", earth: "planet", saturn: "planet", whale: "fish", shark: "fish", dolphin: "fish",
};
const knownKind = (kind: unknown) => {
  const k = String(kind ?? "").toLowerCase().trim().replace(/s$/, "");
  return (KINDS as readonly string[]).includes(k) ? k : KIND_ALIASES[k] ?? null;
};

export function validatePlan(raw: unknown, prompt: string): PictureSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as any;
  // Clear words in the request ("space", "underwater", "at night") beat the model's scene pick.
  const worded = sceneFromWords(prompt);
  const scene: Scene = worded !== "day" ? worded : SCENES.includes(r.scene) ? r.scene : "day";
  const clamp = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);
  const objects: PictureObject[] = (Array.isArray(r.objects) ? r.objects : [])
    .filter((o: any) => o && knownKind(o.kind))
    .slice(0, 16)
    .map((o: any) => {
      const kind = knownKind(o.kind) as Kind;
      return {
        kind,
        x: clamp(o.x, 3, 97, 50),
        y: clamp(o.y, 3, 97, 50),
        size: clamp(o.size, 4, 70, KIND_INFO[kind].size),
        color: safeColor(o.color, DEFAULT_COLOR[kind]),
      };
    });
  if (objects.length === 0) return null;
  // Anything the user asked for that the model forgot is added in.
  const missing = kindsFromWords(prompt).filter((k) => !objects.some((o) => o.kind === k.kind));
  objects.push(...layoutKinds(missing, scene));
  arrange(objects, scene);
  return {
    title: typeof r.title === "string" && r.title.trim() ? r.title.trim().slice(0, 80) : titleFrom(prompt),
    scene,
    objects,
    caption: typeof r.caption === "string" ? r.caption.slice(0, 200) : "",
  };
}

// --- Drawing ---

/** Each object is drawn in a 100×100 box, then placed and scaled. */
function shape(kind: Kind, c: string): string {
  const dark = "#2b2d42";
  switch (kind) {
    case "sun":
      return `<g stroke="${c}" stroke-width="5" stroke-linecap="round">${Array.from({ length: 12 }, (_, i) => {
        const a = (i * Math.PI) / 6;
        return `<line x1="${50 + 34 * Math.cos(a)}" y1="${50 + 34 * Math.sin(a)}" x2="${50 + 47 * Math.cos(a)}" y2="${50 + 47 * Math.sin(a)}"/>`;
      }).join("")}</g><circle cx="50" cy="50" r="28" fill="${c}"/>`;
    case "moon":
      return `<path d="M62 8 A42 42 0 1 0 62 92 A34 34 0 1 1 62 8Z" fill="${c}"/>`;
    case "star":
      return `<polygon points="50,4 61,37 96,37 68,58 79,92 50,71 21,92 32,58 4,37 39,37" fill="${c}"/>`;
    case "cloud":
      return `<g fill="${c}" opacity="0.95"><circle cx="30" cy="60" r="20"/><circle cx="50" cy="48" r="26"/><circle cx="72" cy="60" r="20"/><rect x="28" y="58" width="46" height="22" rx="11"/></g>`;
    case "rainbow":
      return ["#e63946", "#f77f00", "#fcbf49", "#2a9d8f", "#457b9d", "#7209b7"]
        .map((col, i) => `<path d="M${4 + i * 6} 90 A${46 - i * 6} ${46 - i * 6} 0 0 1 ${96 - i * 6} 90" fill="none" stroke="${col}" stroke-width="6"/>`)
        .join("");
    case "bird":
      return `<path d="M10 50 Q30 30 50 50 Q70 30 90 50" fill="none" stroke="${c}" stroke-width="7" stroke-linecap="round"/>`;
    case "butterfly":
      return `<g fill="${c}"><ellipse cx="32" cy="38" rx="20" ry="24"/><ellipse cx="68" cy="38" rx="20" ry="24"/><ellipse cx="36" cy="72" rx="14" ry="16"/><ellipse cx="64" cy="72" rx="14" ry="16"/></g><rect x="47" y="25" width="6" height="62" rx="3" fill="${dark}"/>`;
    case "balloon":
      return `<path d="M50 70 Q48 85 54 98" fill="none" stroke="${dark}" stroke-width="2"/><ellipse cx="50" cy="38" rx="27" ry="34" fill="${c}"/><polygon points="46,71 54,71 50,76" fill="${c}"/><ellipse cx="40" cy="26" rx="6" ry="10" fill="#fff" opacity="0.5"/>`;
    case "planet":
      return `<circle cx="50" cy="50" r="28" fill="${c}"/><ellipse cx="50" cy="52" rx="48" ry="12" fill="none" stroke="#e9c46a" stroke-width="5" transform="rotate(-15 50 50)"/>`;
    case "rocket":
      return `<polygon points="38,78 50,100 62,78" fill="#ffb703"/><path d="M50 2 C68 20 68 55 62 80 L38 80 C32 55 32 20 50 2Z" fill="#f1faee" stroke="${dark}" stroke-width="2"/><path d="M38 62 L24 84 L38 80Z M62 62 L76 84 L62 80Z" fill="${c}"/><path d="M50 2 C58 10 62 18 63 26 L37 26 C38 18 42 10 50 2Z" fill="${c}"/><circle cx="50" cy="44" r="8" fill="#8ecae6" stroke="${dark}" stroke-width="2"/>`;
    case "tree":
      return `<rect x="43" y="55" width="14" height="45" fill="#8b5e34"/><circle cx="50" cy="38" r="30" fill="${c}"/><circle cx="32" cy="50" r="18" fill="${c}"/><circle cx="68" cy="50" r="18" fill="${c}"/>`;
    case "pine":
      return `<rect x="45" y="80" width="10" height="20" fill="#8b5e34"/><polygon points="50,2 74,38 26,38" fill="${c}"/><polygon points="50,20 82,62 18,62" fill="${c}"/><polygon points="50,40 90,84 10,84" fill="${c}"/>`;
    case "flower":
      return `<path d="M50 50 L50 100" stroke="#2d6a4f" stroke-width="5"/><ellipse cx="62" cy="78" rx="10" ry="5" fill="#40916c"/>${[0, 72, 144, 216, 288]
        .map((a) => `<circle cx="${50 + 16 * Math.cos((a * Math.PI) / 180)}" cy="${32 + 16 * Math.sin((a * Math.PI) / 180)}" r="13" fill="${c}"/>`)
        .join("")}<circle cx="50" cy="32" r="10" fill="#ffd60a"/>`;
    case "mountain":
      return `<polygon points="50,4 98,100 2,100" fill="${c}"/><polygon points="50,4 64,32 56,28 50,36 44,28 36,32" fill="#fff"/>`;
    case "house":
      return `<rect x="16" y="45" width="68" height="55" fill="#f4e1c1" stroke="${dark}" stroke-width="2"/><polygon points="8,48 50,10 92,48" fill="${c}" stroke="${dark}" stroke-width="2"/><rect x="42" y="68" width="16" height="32" fill="#8b5e34"/><rect x="22" y="56" width="14" height="14" fill="#a8dadc" stroke="${dark}" stroke-width="2"/><rect x="64" y="56" width="14" height="14" fill="#a8dadc" stroke="${dark}" stroke-width="2"/>`;
    case "castle":
      return `<g fill="${c}" stroke="${dark}" stroke-width="2"><rect x="20" y="40" width="60" height="60"/><rect x="6" y="22" width="20" height="78"/><rect x="74" y="22" width="20" height="78"/><path d="M6 22 v-8 h5 v8 h5 v-8 h5 v8 h5 v-8 M74 22 v-8 h5 v8 h5 v-8 h5 v8 h5 v-8"/></g><path d="M40 100 v-22 a10 10 0 0 1 20 0 v22Z" fill="#6b4226"/><path d="M16 22 v-14 l10 5 l-10 5" fill="#e63946"/>`;
    case "car":
      return `<rect x="4" y="44" width="92" height="30" rx="10" fill="${c}"/><path d="M24 44 L34 20 H66 L78 44Z" fill="${c}"/><path d="M30 42 L37 25 H48 V42Z M53 42 V25 H63 L72 42Z" fill="#a8dadc"/><circle cx="26" cy="76" r="12" fill="${dark}"/><circle cx="74" cy="76" r="12" fill="${dark}"/><circle cx="26" cy="76" r="5" fill="#ccc"/><circle cx="74" cy="76" r="5" fill="#ccc"/>`;
    case "boat":
      return `<path d="M4 64 H96 L80 92 H20Z" fill="${c}"/><rect x="48" y="6" width="4" height="58" fill="${dark}"/><polygon points="52,8 88,56 52,56" fill="#fff" stroke="${dark}" stroke-width="1.5"/><polygon points="48,16 18,56 48,56" fill="#f1faee" stroke="${dark}" stroke-width="1.5"/>`;
    case "cat":
      return `<path d="M78 78 Q98 60 88 40" fill="none" stroke="${c}" stroke-width="7" stroke-linecap="round"/><ellipse cx="55" cy="76" rx="28" ry="20" fill="${c}"/><circle cx="34" cy="44" r="22" fill="${c}"/><polygon points="16,32 18,8 32,24" fill="${c}"/><polygon points="52,32 50,8 36,24" fill="${c}"/><circle cx="27" cy="42" r="3.5" fill="${dark}"/><circle cx="41" cy="42" r="3.5" fill="${dark}"/><polygon points="31,50 37,50 34,54" fill="#ff8fa3"/><g stroke="${dark}" stroke-width="1.2"><line x1="10" y1="50" x2="26" y2="52"/><line x1="10" y1="56" x2="26" y2="55"/><line x1="58" y1="50" x2="42" y2="52"/><line x1="58" y1="56" x2="42" y2="55"/></g>`;
    case "dog":
      return `<path d="M84 60 Q98 46 92 36" fill="none" stroke="${c}" stroke-width="7" stroke-linecap="round"/><ellipse cx="58" cy="66" rx="30" ry="18" fill="${c}"/><rect x="36" y="74" width="9" height="24" rx="4" fill="${c}"/><rect x="72" y="74" width="9" height="24" rx="4" fill="${c}"/><circle cx="30" cy="40" r="20" fill="${c}"/><ellipse cx="14" cy="42" rx="8" ry="16" fill="#5c3317"/><ellipse cx="44" cy="30" rx="7" ry="14" fill="#5c3317" transform="rotate(-20 44 30)"/><ellipse cx="18" cy="50" rx="10" ry="8" fill="${c}"/><circle cx="10" cy="48" r="4" fill="${dark}"/><circle cx="30" cy="36" r="3.5" fill="${dark}"/>`;
    case "fish":
      return `<polygon points="70,50 98,28 98,72" fill="${c}"/><ellipse cx="44" cy="50" rx="38" ry="24" fill="${c}"/><circle cx="24" cy="44" r="5" fill="#fff"/><circle cx="23" cy="44" r="2.5" fill="${dark}"/><path d="M50 36 Q58 50 50 64" fill="none" stroke="#fff" stroke-width="2" opacity="0.6"/>`;
    case "person":
      return `<circle cx="50" cy="16" r="13" fill="#f1c27d"/><circle cx="45" cy="15" r="1.8" fill="${dark}"/><circle cx="55" cy="15" r="1.8" fill="${dark}"/><path d="M45 21 Q50 25 55 21" fill="none" stroke="${dark}" stroke-width="1.5"/><path d="M34 32 H66 L62 64 H38Z" fill="${c}"/><g stroke="#f1c27d" stroke-width="6" stroke-linecap="round"><line x1="35" y1="36" x2="20" y2="56"/><line x1="65" y1="36" x2="80" y2="56"/></g><g stroke="${dark}" stroke-width="7" stroke-linecap="round"><line x1="44" y1="64" x2="40" y2="96"/><line x1="56" y1="64" x2="60" y2="96"/></g>`;
    case "robot":
      return `<line x1="50" y1="4" x2="50" y2="14" stroke="${dark}" stroke-width="3"/><circle cx="50" cy="4" r="4" fill="#e63946"/><rect x="30" y="14" width="40" height="28" rx="6" fill="${c}" stroke="${dark}" stroke-width="2"/><circle cx="41" cy="28" r="5" fill="#8ecae6"/><circle cx="59" cy="28" r="5" fill="#8ecae6"/><rect x="24" y="46" width="52" height="36" rx="6" fill="${c}" stroke="${dark}" stroke-width="2"/><rect x="38" y="54" width="24" height="12" rx="3" fill="#ffd166"/><g stroke="${c}" stroke-width="7" stroke-linecap="round"><line x1="22" y1="52" x2="10" y2="70"/><line x1="78" y1="52" x2="90" y2="70"/><line x1="38" y1="84" x2="38" y2="98"/><line x1="62" y1="84" x2="62" y2="98"/></g>`;
    case "dinosaur":
      return `<path d="M30 70 Q8 72 2 92 Q20 80 34 82Z" fill="${c}"/><ellipse cx="50" cy="66" rx="26" ry="18" fill="${c}"/><path d="M62 56 Q72 30 76 14 Q80 8 88 10 Q96 12 94 20 Q90 24 82 22 Q78 40 72 62Z" fill="${c}"/><rect x="36" y="76" width="9" height="22" rx="3" fill="${c}"/><rect x="56" y="76" width="9" height="22" rx="3" fill="${c}"/><circle cx="87" cy="15" r="2" fill="${dark}"/><path d="M40 50 l4 -8 l4 8 M50 48 l4 -8 l4 8" fill="#2d6a4f"/>`;
    case "snowman":
      return `<circle cx="50" cy="78" r="21" fill="${c}" stroke="#ced4da" stroke-width="2"/><circle cx="50" cy="46" r="15" fill="${c}" stroke="#ced4da" stroke-width="2"/><circle cx="50" cy="22" r="11" fill="${c}" stroke="#ced4da" stroke-width="2"/><rect x="40" y="2" width="20" height="10" fill="${dark}"/><rect x="36" y="11" width="28" height="3" fill="${dark}"/><polygon points="50,23 50,27 62,25" fill="#f77f00"/><circle cx="46" cy="19" r="1.6" fill="${dark}"/><circle cx="54" cy="19" r="1.6" fill="${dark}"/><circle cx="50" cy="42" r="2" fill="${dark}"/><circle cx="50" cy="50" r="2" fill="${dark}"/>`;
    case "heart":
      return `<path d="M50 90 C10 62 4 36 22 20 C36 8 48 18 50 28 C52 18 64 8 78 20 C96 36 90 62 50 90Z" fill="${c}"/>`;
    case "apple":
      return `<path d="M50 28 C30 14 6 26 10 54 C14 82 34 98 50 88 C66 98 86 82 90 54 C94 26 70 14 50 28Z" fill="${c}"/><path d="M50 28 Q48 14 54 4" fill="none" stroke="#6b4226" stroke-width="4"/><ellipse cx="64" cy="12" rx="10" ry="5" fill="#40916c" transform="rotate(-25 64 12)"/>`;
    case "book":
      return `<path d="M50 22 Q30 12 6 18 V88 Q30 82 50 92Z" fill="#fff" stroke="${dark}" stroke-width="2"/><path d="M50 22 Q70 12 94 18 V88 Q70 82 50 92Z" fill="#fff" stroke="${dark}" stroke-width="2"/><path d="M6 88 Q30 82 50 92 Q70 82 94 88 V94 Q70 88 50 98 Q30 88 6 94Z" fill="${c}"/><g stroke="#adb5bd" stroke-width="2"><line x1="14" y1="34" x2="42" y2="38"/><line x1="14" y1="46" x2="42" y2="50"/><line x1="58" y1="38" x2="86" y2="34"/><line x1="58" y1="50" x2="86" y2="46"/></g>`;
    case "ball":
      return `<circle cx="50" cy="50" r="44" fill="${c}"/><path d="M8 40 Q50 60 92 40 M8 60 Q50 80 92 60" fill="none" stroke="#fff" stroke-width="5"/>`;
    case "cake":
      return `<rect x="47" y="6" width="6" height="18" fill="#4cc9f0"/><path d="M50 0 Q56 6 50 8 Q44 6 50 0Z" fill="#ffb703"/><rect x="14" y="26" width="72" height="30" rx="4" fill="${c}"/><rect x="6" y="56" width="88" height="38" rx="4" fill="#f4e1c1"/><path d="M6 60 Q17 70 28 60 Q39 70 50 60 Q61 70 72 60 Q83 70 94 60" fill="none" stroke="${c}" stroke-width="5"/>`;
    case "umbrella":
      return `<path d="M50 45 V88 Q50 96 42 96 Q36 96 36 90" fill="none" stroke="${dark}" stroke-width="4" stroke-linecap="round"/><path d="M4 46 Q50 -18 96 46 Q85 38 73 46 Q61 38 50 46 Q39 38 27 46 Q15 38 4 46Z" fill="${c}"/>`;
  }
}

const SCENE_BG: Record<Scene, { sky: [string, string]; ground?: string; extra?: string }> = {
  day: { sky: ["#8ecae6", "#e0f4ff"], ground: "#74c69d" },
  night: { sky: ["#0b1a3a", "#27407a"], ground: "#2d6a4f" },
  sunset: { sky: ["#ff7b54", "#ffd56f"], ground: "#6a994e" },
  space: { sky: ["#03031a", "#1b1b4b"] },
  underwater: { sky: ["#0077b6", "#48cae4"], ground: "#e9c46a" },
  indoor: { sky: ["#f8edeb", "#fae1dd"], ground: "#c9a27e" },
  snow: { sky: ["#a9d6e5", "#e8f4f8"], ground: "#ffffff" },
};

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

export function renderSvg(spec: PictureSpec): string {
  const bg = SCENE_BG[spec.scene];
  const gy = H * GROUND_Y;
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(spec.title)}">`,
    `<title>${esc(spec.title)}</title>`,
    `<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${bg.sky[0]}"/><stop offset="1" stop-color="${bg.sky[1]}"/></linearGradient></defs>`,
    `<rect width="${W}" height="${H}" fill="url(#sky)"/>`,
  ];
  // Scene details: a few fixed "random" stars at night and in space, bubbles underwater, a window indoors.
  if (spec.scene === "space" || spec.scene === "night") {
    for (let i = 0; i < 40; i++) parts.push(`<circle cx="${(i * 197) % W}" cy="${(i * 113) % (spec.scene === "night" ? gy : H)}" r="${1 + (i % 3) * 0.6}" fill="#fff" opacity="${0.4 + (i % 5) / 10}"/>`);
  }
  if (spec.scene === "underwater") {
    for (let i = 0; i < 14; i++) parts.push(`<circle cx="${(i * 151) % W}" cy="${(i * 89) % gy}" r="${3 + (i % 4) * 2}" fill="none" stroke="#fff" stroke-opacity="0.5" stroke-width="2"/>`);
  }
  if (bg.ground) {
    parts.push(
      spec.scene === "indoor"
        ? `<rect x="0" y="${gy}" width="${W}" height="${H - gy}" fill="${bg.ground}"/><rect x="560" y="60" width="160" height="130" fill="#bde0fe" stroke="#fff" stroke-width="8"/><line x1="640" y1="60" x2="640" y2="190" stroke="#fff" stroke-width="6"/>`
        : `<path d="M0 ${gy} Q${W * 0.25} ${gy - 30} ${W * 0.5} ${gy} T${W} ${gy - 10} V${H} H0Z" fill="${bg.ground}"/>`
    );
  }
  // Draw back to front: bigger/higher things first.
  const ordered = [...spec.objects].sort((a, b) => a.y + a.size / 2 - (b.y + b.size / 2));
  for (const o of ordered) {
    const s = (o.size / 100) * H;
    const x = (o.x / 100) * W - s / 2;
    const y = (o.y / 100) * H - s / 2;
    parts.push(`<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${(s / 100).toFixed(3)})">${shape(o.kind, safeColor(o.color, DEFAULT_COLOR[o.kind]))}</g>`);
  }
  parts.push("</svg>");
  return parts.join("");
}

export const svgDataUri = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
