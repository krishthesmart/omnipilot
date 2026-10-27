// The requests run through OmniPilot while recording (record.mts). They're built
// to exercise every job OmniPilot gives its model: routing, follow-up rewriting,
// coordination, everyday answers, word problems, code (+ tests and repairs),
// lessons and quiz keys, prompts, pictures, wiring drafts, page checks, identity
// explanations, and composing multi-specialist answers. GSM8K *test* problems are
// never used here (they're the benchmark).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WORK = path.join(path.dirname(fileURLToPath(import.meta.url)), "work");

export interface Session {
  /** One or more messages in the same conversation (later ones are follow-ups). */
  messages: string[];
  category: string;
}

let seed = 11;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = <T,>(a: readonly T[]) => a[Math.floor(rand() * a.length)];
const sample = <T,>(a: readonly T[], k: number) => [...a].sort(() => rand() - 0.5).slice(0, k);

const FACTS = [
  "What is the capital of Australia?", "Who wrote Romeo and Juliet?", "How far is the Moon from Earth?", "What is the largest planet in our solar system?",
  "Who painted the Mona Lisa?", "What gas do plants absorb from the air?", "How many bones are in the adult human body?", "What is the boiling point of water in Fahrenheit?",
  "Who was the first person to walk on the Moon?", "What is the longest river in Africa?", "What language is spoken in Brazil?", "What is the chemical symbol for gold?",
  "Why is the sky blue?", "Why do cats purr?", "How do vaccines work?", "What causes thunder?", "Why do leaves change color in the fall?", "How does a rainbow form?",
  "What is the difference between weather and climate?", "What does DNA stand for?", "How do airplanes stay in the air?", "Why do we dream?", "What is inflation?",
  "How does Wi-Fi work?", "What's a good way to remember the planets in order?", "Give me three tips for falling asleep faster.", "How do I make a cup of green tea properly?",
  "What should I pack for a weekend camping trip?", "How can I keep my houseplants alive?", "Suggest a name for a golden retriever puppy.", "What is a black hole?",
  "Who invented the telephone?", "What is the tallest mountain in the world?", "How many continents are there?", "What is photosynthesis in one sentence?",
  "Write a short thank-you note to my teacher.", "Summarize the water cycle in three sentences.", "What are the primary colors?", "How do bees make honey?",
  "What's the difference between a virus and bacteria?", "What is the speed of light?", "Which ocean is the largest?", "How do I write a good topic sentence?",
] as const;

const WORD_PROBLEM_TEMPLATES = [
  "A store sells notebooks for ${a} each. If Maya buys {b} notebooks and pays with a ${c} bill, how much change does she get?",
  "A train travels at {a} miles per hour for {b} hours, then {c} miles per hour for 2 hours. How far does it go in total?",
  "Liam has {a} stickers. He gives {b} to his sister and then buys {c} more. How many stickers does he have now?",
  "A recipe needs {b} cups of flour for 12 cookies. How many cups are needed for {a} cookies?",
  "A shirt costs ${a}. It is on sale for {b}% off. What is the sale price?",
  "There are {a} students in a class. {b}% of them walk to school. How many students walk?",
  "A garden is {a} meters long and {b} meters wide. Fencing costs ${c} per meter. How much does it cost to fence the whole garden?",
  "Ana earns ${a} per hour and works {b} hours a week. How much does she earn in {c} weeks?",
  "A tank holds {a} liters. It is filled at {b} liters per minute. How many minutes until it is full?",
  "Tom read {a} pages on Monday, twice as many on Tuesday, and {b} pages on Wednesday. How many pages did he read in total?",
  "A pizza is cut into {b} slices. {c} friends each eat 2 slices. How many slices are left if they ordered {a} pizzas?",
  "A phone costs ${a}. Sales tax is {b}%. What is the total price?",
] as const;
const fill = (t: string) => t.replace(/\{a\}/g, () => String(10 + Math.floor(rand() * 90))).replace(/\{b\}/g, () => String(2 + Math.floor(rand() * 9))).replace(/\{c\}/g, () => String(3 + Math.floor(rand() * 20)));

const CODE_TASKS = [
  "reverses a string", "checks if a word is a palindrome", "returns the nth Fibonacci number", "counts the vowels in a string", "finds the largest number in a list",
  "removes duplicates from a list while keeping order", "checks if a number is prime", "converts Celsius to Fahrenheit", "returns the factorial of n", "flattens a nested list",
  "counts how often each word appears in a sentence", "checks if two strings are anagrams", "returns the second largest number in a list", "merges two sorted lists",
  "computes the average of a list of numbers", "capitalizes the first letter of each word", "returns all even numbers from a list", "checks if a year is a leap year",
  "finds the greatest common divisor of two numbers", "converts a binary string to an integer", "returns the sum of the digits of a number", "rotates a list by k positions",
  "checks if brackets in a string are balanced", "returns the longest word in a sentence", "chunks a list into groups of size n", "converts a number to Roman numerals",
] as const;

const TOPICS = [
  "fractions", "photosynthesis", "the water cycle", "gravity", "volcanoes", "the solar system", "multiplication", "magnets", "the American Revolution", "ecosystems",
  "electric circuits", "the human heart", "decimals", "plate tectonics", "states of matter", "the French Revolution", "probability", "simple machines", "climate change", "cells",
] as const;
const GRADES = ["a 3rd grader", "a 5th grader", "a 7th grader", "a high school student", "a beginner"] as const;
const LEARN_FORMS = ["Explain {t} for {g}", "Teach me {t} with a short quiz", "Make flashcards about {t}", "Give me a study plan for {t}", "Explain {t} like I'm {g}, with practice questions"] as const;

const HARDWARE = [
  "How do I connect an LED to my Arduino?", "How do I wire a push button to an Arduino?", "How do I connect a servo to my Arduino?", "How do I use an ultrasonic distance sensor with Arduino?",
  "How do I connect a DHT11 temperature sensor to an Arduino?", "How do I hook up a buzzer to my Arduino?", "How do I connect a light sensor to my Arduino?", "How do I connect an LED to a Raspberry Pi?",
  "How do I connect a potentiometer to my Arduino?", "How do I wire an I2C LCD screen to my Arduino?", "How do I connect a soil moisture sensor to my Arduino?", "How do I connect my laptop to a monitor with HDMI?",
  "How do I connect a PIR motion sensor to an Arduino?", "How do I wire a relay module to an Arduino?", "How do I connect an RGB LED to my Arduino?", "How do I connect a joystick module to my Arduino?",
] as const;

const PICTURES = [
  "Draw a cat sitting under a tree", "Draw a rocket flying past the moon", "Make a picture of a house with a red car", "Draw a snowman in a winter forest",
  "Draw three fish swimming in the ocean", "Make a picture of a castle on a mountain at sunset", "Draw a robot and a dog in a park", "Draw a birthday cake with balloons",
  "Draw a boat on the sea with birds", "Make a picture of a dinosaur next to a volcano", "Draw a girl reading a book under a rainbow", "Draw a night sky with stars and a planet",
  "Draw a butterfly garden with flowers", "Make a picture of a family having a picnic", "Draw an astronaut in space",
] as const;

const PROMPTS = [
  "Refine my Midjourney prompt: a cat in space", "Make my ChatGPT prompt better: help me with homework", "Improve this Stable Diffusion prompt: a castle at night",
  "Rewrite my prompt for an AI coding assistant: make a website", "Better prompt for DALL-E: a dog on a beach at sunset", "Refine my prompt for Claude: summarize this article",
  "Improve my prompt: write a story about dragons", "Make this prompt clearer: explain quantum physics",
] as const;

const IDENTITIES = [
  "Is it true that (a+b)^2 = a^2 + 2ab + b^2?", "Is sin(x)^2 + cos(x)^2 = 1?", "Check: (a-b)^2 = a^2 - b^2", "Is it true that 2^10 = 1000?", "Is sum(k, k, 1, n) = n(n+1)/2?",
  "Verify that sqrt(a*b) = sqrt(a)*sqrt(b)", "Is it true that (x+1)(x-1) = x^2 - 1?", "Check whether ln(a*b) = ln(a) + ln(b)", "Is 1/2 + 1/3 = 2/5?", "Is it true that 0.999... = 1?",
  "What has MathPilot found so far?",
] as const;

const WATCHER = [
  "My kid should learn math for 1 hour, no AI", "Block games and YouTube while my daughter does reading homework for 45 minutes", "Set up focus time for science homework, no AI tools",
  "Is khanacademy.org allowed during math time?", "My son needs to study history for 2 hours without distractions",
] as const;

const SCIENCE = [
  "Simulate a projectile launched at 25 m/s at 45 degrees", "How far does a ball thrown at 15 m/s at 30 degrees travel?", "Simulate population growth of rabbits starting with 50",
  "Simulate soil moisture over a week with no rain", "Simulate a projectile at 40 m/s and 60 degrees",
] as const;

const SCRIPTS = ["Compare Linear A and Linear B", "What is cuneiform?", "How were Egyptian hieroglyphs deciphered?", "Compare the Phoenician and Greek alphabets"] as const;

const COMPOUND = [
  "How do I connect a button to my Arduino and how does it work?", "Write a Python function that checks if a number is prime and explain how it works for a beginner",
  "Explain photosynthesis for a 5th grader and draw a picture of a tree in the sun", "Simulate a projectile at 20 m/s and 45 degrees and explain the physics",
  "Compare Linear A and Linear B and make a short quiz about them", "Draw a rocket and explain how rockets work for a 4th grader",
  "Write JavaScript code to reverse a string and teach me the concepts behind it", "How do I wire an LED to my Raspberry Pi and write the Python code to blink it?",
] as const;

const FOLLOWUPS: [string, string][] = [
  ["Write a Python function that reverses a string", "now do it in JavaScript"], ["What is the capital of France?", "and what is its population?"],
  ["Explain fractions for a 3rd grader", "can you make a quiz about it?"], ["How do I connect an LED to my Arduino?", "why do I need the resistor?"],
  ["Draw a cat under a tree", "now make it night time"], ["Who painted the Mona Lisa?", "when did he paint it?"], ["Write a function that checks for palindromes in Python", "add comments to it"],
  ["What causes earthquakes?", "explain it more simply"], ["Give me a study plan for the solar system", "make it shorter"], ["A shirt costs $40 and is 25% off. What do I pay?", "what if it was 40% off?"],
];

export function buildSessions(): Session[] {
  const sessions: Session[] = [];
  const add = (category: string, ...messages: string[]) => sessions.push({ category, messages });
  for (const f of FACTS) add("everyday", f);
  for (let i = 0; i < 36; i++) add("word problem", fill(pick(WORD_PROBLEM_TEMPLATES)));
  // A few GSM8K *training* questions (never test ones) for realistic phrasing.
  const gsmTrain = fs.readFileSync(path.join(WORK, "candidates", "gsm8k-train.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).question as string);
  for (const q of sample(gsmTrain, 24)) add("word problem", q);
  for (const task of CODE_TASKS) add("code", `Write a ${rand() < 0.75 ? "Python" : "JavaScript"} function that ${task}`);
  for (const t of TOPICS) add("learning", pick(LEARN_FORMS).replace("{t}", t).replace("{g}", pick(GRADES)));
  for (const h of HARDWARE) add("hardware", h);
  for (const p of PICTURES) add("picture", p);
  for (const p of PROMPTS) add("prompt", p);
  for (const q of IDENTITIES) add("math", q);
  for (const w of WATCHER) add("watcher", w);
  for (const s of SCIENCE) add("science", s);
  for (const s of SCRIPTS) add("scripts", s);
  for (const c of COMPOUND) add("compound", c);
  for (const [a, b] of FOLLOWUPS) add("follow-up", a, b);
  return sessions;
}

if (process.argv[1]?.endsWith("prompts.mts")) {
  const s = buildSessions();
  const byCat = s.reduce<Record<string, number>>((acc, x) => ((acc[x.category] = (acc[x.category] ?? 0) + 1), acc), {});
  console.log(`${s.length} sessions, ${s.reduce((n, x) => n + x.messages.length, 0)} messages`, byCat);
}
