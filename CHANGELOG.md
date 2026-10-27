# Changelog

## 1.4.0 (unreleased)

- **omnipilot-mini:** OmniPilot's own model, about 400 MB, trained on this
  computer (`npm run train`). It learned every job OmniPilot gives its model
  (routing, each specialist, composing answers) from verified recordings of
  OmniPilot itself, plus 6,947 word problems in exact-calculation format.
- **Exact tools:** letter counts, decimal comparisons, primes, factors,
  GCD/LCM, percentages, unit conversions and dates are calculated, not guessed.
- **Word problems:** the model writes steps; OmniPilot computes them exactly
  and takes the majority of three tries.
- **Offline encyclopedia:** `npm run knowledge` builds a 183 MB search index of
  Simple English Wikipedia; factual answers cite the article.
- **Knows when it's guessing:** short factual answers are checked by asking
  again; disagreement is flagged.
- One model choice in the app now drives routing as well as the specialists.

## 1.3.0 (2026-10-13)

- **AI model panel** (brain icon): switch between OmniPilot's small models,
  all under 1 GB (`qwen2.5:1.5b` default, `qwen2.5:0.5b` fastest), with an
  in-app download and progress bar, no restart needed. Models of 1 GB or more
  can't be downloaded or selected.
- **Chat history:** past conversations are kept on this computer and listed
  under **Chats**; the current chat comes back after a reload, and old answers
  display even after a restart. Delete any chat from the list.
- **Stop button:** ends an answer in progress, including running specialists.
- Answers no longer mention a specialist that wasn't relevant ("Not implemented")
  when another one answered.

## 1.2.0 (2026-10-13)

- **Voice:** a mic button for speaking a message, and a hands-free Voice mode
  that reads answers aloud and listens for the next question. Uses the
  browser's built-in speech features (on-device recognition where available).
- **PicturePilot:** draws pictures from a description. The local model plans
  the scene and OmniPilot renders a clean SVG illustration, with no extra
  download. Optional photo-style images through a local Stable Diffusion
  server (`IMAGE_API_URL`). No video generation, by design.
- **MathPilot:** checks whether identities are true (counterexamples when
  they're not), and runs an always-on, resumable search for new continued-
  fraction formulas for π, e, ζ(3), Catalan's constant and more. Each hit is
  verified to at least 20 digits with 60-digit arithmetic. New results show as
  a badge, in the MathPilot panel and as optional desktop notifications.
- **SDK:** dependency-free JavaScript and Python clients, an ESP32 example,
  a one-call `POST /api/ask` endpoint, and opt-in token access for devices on
  your network (`OMNIPILOT_API_TOKEN`). Guide: docs/SDK.md, including running
  everything on a Raspberry Pi.
- Follow-up questions answered more reliably by the small model; general
  answers no longer carry a "no matches in your files" note in the text.
- A picture description is no longer split into separate tasks at "and".

## 1.1.0 (2026-10-12)

- **Runs anywhere Node.js 22+ runs:** the database now uses Node's built-in
  SQLite, so nothing is compiled during install (no more "compiled against a
  different Node.js version" errors). Windows-safe paths and code sandbox;
  consistent line endings via `.gitattributes`; `.nvmrc`.
- **Watcher extension in every major browser:** Chrome, Edge, Brave, Opera,
  Vivaldi and Firefox (Manifest V3). Tested in a real Chromium: AI sites,
  games and the extensions page are blocked, math sites load, and AI sites stay
  blocked while OmniPilot is off.
- **Works on phones and tablets:** responsive header, wide content scrolls in
  place, compact wiring diagrams on narrow screens.
- Clearer, non-technical welcome screen and specialist descriptions.
- npm 11's install-script review is pre-answered (esbuild and fsevents don't
  need their scripts).

## 1.0.0 (2026-10-12)

First public release.

- Nine specialists: Helper, CodePilot, LearnPilot, HardwarePilot, WatcherPilot,
  PromptPilot, ScienceLab, ScriptScholar, InfraPilot.
- Coordinator: per-agent sub-tasks, agents building on each other's results,
  a re-check after the first round, and gap cover.
- Conversation memory with follow-up rewriting; streamed answers.
- Small-model techniques: structured outputs, few-shot examples,
  self-consistency voting, hidden reasoning, retrieval grounding, and
  execute → repair → resample for code.
- WatcherPilot with the OmniPilot Watcher browser extension and parent PIN.
- HardwarePilot with interactive, step-by-step wiring diagrams and electrical
  safety checks on drafted circuits.
- Local-only API (127.0.0.1, origin and host checks), security headers, rate
  limiting; `npm start`, `npm run doctor`, status banner.
