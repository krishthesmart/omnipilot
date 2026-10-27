# OmniPilot

**A free AI assistant with a team of specialists.** Ask anything, by
typing or by voice, and OmniPilot hands the work to a team of specialists: one
writes and tests code, one tutors, one shows how to wire up an Arduino, one
draws pictures, one keeps kids focused on homework, and one hunts for new math
formulas around the clock. Then it combines what they found into one answer.

- **Free and smart.** The AI is OpenAI's open `gpt-oss-120b`, running on
  [Groq](https://groq.com)'s free tier, so all you need is a free Groq API key.
  Your requests go to Groq to be answered; your chats and voice recordings stay on
  your computer.
- **Checks its own work.** Code is run against tests before you see it, quiz
  answer keys are double-checked, wiring diagrams are checked for short
  circuits, and anything the model wasn't sure about is labeled.
- **Remembers the conversation.** Follow-ups like "now do it in JavaScript" or
  "how do I fix the first one?" just work.
- **Talk to it.** Tap the mic, or turn on **Voice** mode for hands-free
  back-and-forth with answers read aloud.
- **Use it from your own code and devices.** A tiny SDK for JavaScript and
  Python, plus an ESP32 example ([docs/SDK.md](docs/SDK.md)).

## Quick start

Works on **Windows, macOS and Linux**. You need **Node.js 22 or newer**
([nodejs.org](https://nodejs.org), the "LTS" download) and a free **Groq API
key** ([console.groq.com/keys](https://console.groq.com/keys)). Nothing needs
compiling.

```bash
# 1. Get OmniPilot and install it
git clone <this repository's URL> omnipilot
cd omnipilot
npm install

# 2. Add your Groq key
echo "GROQ_API_KEY=<your key>" >> server/.env

# 3. Start it
npm start
```

Then open **<http://localhost:8899>**.

Something not working? Run `npm run doctor`. It checks everything and tells you
exactly what to fix. Without a Groq key OmniPilot still runs, but answers are
limited to its built-in knowledge (the app shows a banner explaining how to turn
the AI on).

## What it can do

| Specialist | Ask it to… | Example |
| --- | --- | --- |
| **Helper** | Answer questions, do everyday math, search your notes, research the web for as long as you ask | "Research the history of the bicycle for 5 minutes" |
| **SchoolPilot** | Track homework, projects and tests; plan big assignments and study sessions; help with essays | "I have a science project due Friday" · "What's due?" |
| **CodePilot** | Write code (it runs and tests it first); build whole multi-file projects (planned, written, checked, tests run in a sandbox, repaired); change an existing project across files; check code for security bugs. Changes are shown as diffs and applied only when you approve (and can be undone) | "Write a Python function that returns the nth prime" · "Build a flashcard quiz app in Python with tests" · "Add a high-score table to my snake game project" |
| **ModelPilot** | Interactive 3D models you can rotate, take apart (exploded view) and click part by part; export STL (3D printing) or GLB. Exact ball-and-stick molecules | "Build a 3D model of a Nintendo Switch you can explore through the parts" · "A 3D water molecule" |
| **LearnPilot** | Teach at any grade level, with practice, flashcards, a quiz and an interactive diagram; teach from notes you attach | "Explain the water cycle for a 5th grader" |
| **HardwarePilot** | Show how to connect things, with an interactive wiring diagram you can play step by step | "How do I connect an LED to my Arduino?" |
| **WatcherPilot** | Keep a child on task: block AI tools and off-task sites during homework time | "My kid should learn math for 1 hour, no AI" |
| **PicturePilot** | Draw a picture from your words (still images only) | "Draw a rocket flying past a planet" |
| **MathPilot** | Check whether an identity is true; teach mental-math tricks; search for new formulas in the background | "Quick way to do 34 × 11?" · "Teach me a math trick" |
| **PromptPilot** | Rewrite a prompt for another AI tool | "Refine my Midjourney prompt: a cat in space" |
| **ScienceLab** | Run physics/biology simulations | "Simulate a projectile at 30 m/s and 60°" |
| **ScriptScholar** | Compare ancient writing systems; analyse text in an unknown script (sign counts, likely script type, repeated groups) and transliterate Phoenician, runes, Ogham and Greek | "Compare Linear A and Linear B", "Decipher this: AB01 AB28 AB59 AB01 AB28" |
| **InfraPilot** | Connect Slack, GitHub, Notion, Google Calendar, Gmail (read-only) and Google Drive; do things there once you approve (post to Slack, open a GitHub issue, add to a Notion page, save a Gmail draft); add and use MCP servers; create skills, custom agents and daily routines | "Summarize my unread emails" · "Post 'standup at 10' to #general on Slack" · "Add an MCP server called files: `npx -y @modelcontextprotocol/server-filesystem ~/Documents`" |

Specialists work together: ask "How do I connect a button to my Arduino and how
does it work?" and HardwarePilot draws the circuit while LearnPilot explains
the electronics behind it.

## Keep it running (even when your computer is off)

- **On your computer:** `npm run service:install` runs OmniPilot in the background: it starts when you
  log in and restarts by itself (no terminal, no `caffeinate`). Routines missed while the computer
  slept run when it wakes.
- **Online for free, forever:** a free Oracle Cloud server with a free `https://<name>.duckdns.org` address,
  set up with one script: [deploy/oracle/README.md](deploy/oracle/README.md). Works while your computer is off.
- **A public link, free:** `npm run share` shares it at an `https://` address with a free Cloudflare
  Tunnel (visitors sign in with your password); a free Worker can make the link permanent. See
  [deploy/cloudflare-free/README.md](deploy/cloudflare-free/README.md).
- **While your computer is off:** host it on Cloudflare (a Worker in front of a Container that sleeps
  when idle, data in R2), or any always-on server with Docker (Fly.io, a Raspberry Pi, a VPS). Hosted,
  it asks for a password before anyone can use it. See [docs/DEPLOY.md](docs/DEPLOY.md).

## Running commands and browsing sites

- **Commands (E2B):** with `E2B_API_KEY`, CodePilot and routines run commands in a throwaway cloud
  machine: "run `python main.py` in my flashcard project", "run the tests in my snake game project",
  and project tests that need packages or the network. Commands never run on your computer.
- **Clicking through sites (Browser Use):** with `BROWSER_USE_API_KEY`, "go to my school's website and
  find this week's lunch menu" is done by a cloud AI browser (read-only: it never signs in, buys, posts
  or sends). Plain reading and search use Browserbase.
- **Links that need your account** (Google Docs/Sheets/Slides, GitHub, Notion) are read through that
  integration; if it isn't connected yet, you get its Connect card. Public GitHub repositories work
  without connecting.

## Approvals that actually do the work

Anything that changes something outside the chat waits for you. The card shows exactly what will
happen (a code diff, the Slack message, the GitHub issue, the MCP tool and its arguments, the
command an MCP server will run) and **Approve** carries it out once, with exactly those details.
Code changes across many files are applied all together or not at all, and **Undo** puts every file
back. If something fails (say, Slack says the app isn't in that channel), nothing is recorded as
approved and you can fix the cause and approve again.

## It tells you when something isn't possible

Some things OmniPilot never does: send email (it drafts instead), make videos, buy or book things,
make calls or texts, control devices, get into accounts that aren't yours, predict lottery numbers,
touch files outside its workspace. Ask for one and it says so, with the reason and what it can do
instead, without running agents for nothing. If it can do part of a request, it does that part and
says which part it couldn't. And if no agent managed to do the work (for example when Groq's free
daily limit is used up), the answer says that plainly instead of a confident-sounding summary.

## Gmail (read-only, free)

Connect Gmail with an **app password** (Google Account > Security > 2-Step Verification > App
passwords), not your normal password. OmniPilot reads over IMAP in read-only mode: it never marks
mail as read, moves or deletes it, and never sends. "Summarize my unread emails", "any emails from
Ms. Lee this week?", "draft a reply to Sam saying I'll be late" (saved to Drafts when you approve).

## Google Drive (Google sign-in, free)

Every integration is real; Drive uses Google's own sign-in. One-time setup: in
[Google Cloud](https://console.cloud.google.com/apis/credentials) create a project, enable the
**Google Drive API**, set up the OAuth consent screen (External, add yourself as a test user), and
create an **OAuth client ID** of type **Desktop app**. Paste its ID and secret on the Google Drive
card and click **Sign in with Google**. Then: "find my history essay in Google Drive", "summarize my
Biology notes doc in Drive", "quiz me on my Biology notes in Google Drive" (LearnPilot teaches from
the doc), "save that to my Google Drive" (a new Google Doc, after you approve). OmniPilot can read
your files and create new ones; it never changes or deletes existing files.

## MCP servers

Add any Model Context Protocol server in chat: a local program (`npx`, `uvx`, `node`, `python`...)
or an https address. You approve the exact command first. Tools the server marks read-only run right
away; anything else is shown and runs only when you approve. Local servers get no OmniPilot keys in
their environment.

## VS Code extension

`node scripts/package-vscode.mjs` builds `ide/vscode/omnipilot-1.3.0.vsix`; install it with
`code --install-extension ide/vscode/omnipilot-1.3.0.vsix`. It adds an OmniPilot chat panel,
right-click **Explain / Fix / Improve / Change as I describe / Write tests** (changes open as a
checked diff you Apply or Discard) and security scans in the Problems panel. It talks only to the
OmniPilot on your computer. See [ide/vscode/README.md](ide/vscode/README.md).

## Talk to it

Tap the **mic** next to the message box and speak; your words are sent when you
pause. Turn on **voice mode** (the sound-wave button) for a hands-free
conversation: OmniPilot reads each answer aloud, then listens for your next question.

Your speech is turned into text on your computer by Whisper, so recordings never
leave your machine; answers are read aloud by your browser.

## Research for as long as you want

Ask "research the history of the bicycle for 5 minutes" (up to 10 minutes) or
"do deep research on battery chemistry" (3 minutes). OmniPilot really spends that
time: it splits the question into parts, searches the web, reads pages, takes
notes, looks for gaps and follows new leads, then writes a report with numbered
sources. You see its progress while it works, and **Stop** ends it at any time.
Needs the Browserbase key (see "Optional: web research").

## School, skills and routines

- **SchoolPilot** keeps your homework list: "I have a math test next Tuesday"
  adds it with study sessions spread out before the day; "what's due?" lists
  everything; "I finished the math test" ticks it off. It helps with essays and
  homework by guiding you, not by doing graded work for you.
- **Skills:** "create a skill called start_my_day that tells me what's due and
  teaches me a math trick", then type `/start_my_day` whenever you want it.
- **Routines:** "run start_my_day every day at 7am" runs it by itself while
  OmniPilot is running; the results appear in your chat history.
- **Custom agents:** "create an agent called SpanishTutor that helps me practise
  Spanish", then "ask SpanishTutor how do I say good morning" or `/spanishtutor …`.
- **Calendar:** connect Google Calendar with its *secret address in iCal format*
  (Google Calendar → Settings → your calendar → Integrate calendar), then ask
  "what's on my calendar tomorrow?". It's read-only. (Gmail isn't supported: it has
  no free read-only link like this.)
- **Attach notes:** the paperclip attaches a `.txt` or `.md` file (your notes, a
  chapter); ask "quiz me on this" and LearnPilot teaches and quizzes from it.

## It learns from you (a little)

If an answer is wrong, tap 👎 and say why, or just reply "no, that's wrong
because…". OmniPilot turns that into a short, general lesson and uses it for
similar questions later. Lessons are only advice to the AI: they can't change
OmniPilot's code, settings or safety rules. At most 50 are kept, and lessons that
keep getting 👎 delete themselves. Ask "what have you learned?" to see them, and
"forget lesson 2" or "forget everything you learned" to remove them.

## Pictures

Ask PicturePilot to draw something ("draw a cat and a dog under a rainbow").
The AI plans the scene and OmniPilot draws it as a clean illustration you
can save. This needs no extra download and works on any computer.

Video generation isn't offered.

Pictures for violent, sexual or hateful requests, and realistic pictures of
real people, are refused.

## MathPilot: math discovery, around the clock

While OmniPilot is running, MathPilot searches in the background for new
formulas for famous constants (π, e, ζ(3), Catalan's constant, the golden
ratio…), in the spirit of the [Ramanujan Machine](https://www.ramanujanmachine.com/).
It tries millions of continued fractions, and any that seem to match a constant
are recomputed with 60-digit arithmetic and kept only if they agree to at least
20 digits.

- When it finds something new, the sidebar says so ("MathPilot found 2 new
  formulas"); click it to see them in the chat.
- Ask in chat: *"What has MathPilot found?"* or check an identity yourself:
  *"Is sum(1/n^2, n, 1, inf) = pi^2/6?"*
- Results are **numerically verified conjectures, not proofs**, and many turn
  out to be known already. Check the literature before calling one new.
- It runs in short bursts so it never slows down chat. Turn it off with
  `MATHPILOT=off` in `server/.env`. Progress is saved, so it
  picks up where it left off after a restart.

## For parents: WatcherPilot

WatcherPilot works like GoGuardian, at home and for free.

1. In chat, say what your child should be doing, for example *"learn math for
   1 hour, no AI"*, then click **Review & confirm**. To change or stop a
   session later, say "stop the focus session" and use **Open parent controls**.
2. The first time, choose a **parent PIN**. Only the PIN can start, change or
   stop a session, or show what was blocked. Asking in chat can't.
3. Install the **OmniPilot Watcher** browser extension once:

   | Browser | How |
   | --- | --- |
   | Chrome, Edge, Brave, Opera, Vivaldi | Open the extensions page (`chrome://extensions`, `edge://extensions`…), turn on **Developer mode**, click **Load unpacked**, choose the `extension` folder. |
   | Firefox | Open `about:debugging` → **This Firefox** → **Load Temporary Add-on**, choose `extension/manifest.json`. Firefox removes temporary add-ons on restart; for a permanent install, the extension must be signed through [addons.mozilla.org](https://addons.mozilla.org) (free). Firefox doesn't let extensions switch other extensions off, so that one feature is skipped there. |
   | Safari | Not supported yet. |

During a session:

- **Blocked:** AI chatbots and answer solvers (ChatGPT, Gemini, Claude,
  Photomath, Brainly…) and AI browser extensions.
- **Allowed:** learning sites for the subject (Khan Academy, Desmos…).
- **Judged by content:** pages like YouTube or Wikipedia, so a fractions video
  is fine and a gaming video isn't.

Blocked pages show a friendly "back to your task" screen. AI sites stay blocked
even if OmniPilot is closed, and the browser's extensions page is locked so
the extension can't just be switched off.

**What it can't do:** it only covers browsers with the extension installed. To
stop private windows or other browsers, use your computer's parental controls
(a separate child account works well), or set Chrome's
`IncognitoModeAvailability` and `BrowserGuestModeEnabled` policies.

## Optional: web research (Browserbase)

With a [Browserbase](https://browserbase.com) key, Helper can look things up on
the web when you ask for it ("visit the official Semgrep site", "find the Docling
documentation"). It searches, reads the pages, and answers with numbered sources.
For comparisons of several products, the facts are quoted straight from the pages
(so the model can't mix them up) and suggestions are clearly labelled.

- **Read-only:** it searches and reads pages; it never logs in, fills forms or
  clicks. A real cloud browser is used only for pages that need JavaScript, and is
  always closed afterwards.
- **Limited:** 10 calls, one browser and 90 seconds per question; public web pages
  only (never your network or local addresses).
- **Logged:** each search and page read appears in the run's Activity tab (what was
  looked up, never the page text).
- **Private key, but not private queries:** the key stays in `server/.env`, while
  your search queries and the pages read go through Browserbase.

Add `BROWSERBASE_API_KEY=...` to `server/.env` and restart. Web pages are treated
as untrusted: their text can't make OmniPilot take any action.

## Optional: E2B cloud sandbox

[E2B](https://e2b.dev) runs code in disposable cloud sandboxes. OmniPilot can use
it so nothing runs on your computer. For now it offers one fixed smoke test: a
fresh sandbox (no internet, no files from your computer, 60-second lifetime)
prints a message, and OmniPilot shows the output and terminates the sandbox.
Add `E2B_API_KEY=...` to `server/.env`, start OmniPilot, then:

```bash
curl -X POST http://localhost:8899/api/remote/e2b/smoke-test
```

Each run is recorded in the activity log. E2B is a paid service with a free
tier; this is the only part of OmniPilot that contacts a cloud service, and only
when you set the key.

## Privacy and security

- Everything runs on your computer. OmniPilot only accepts connections from
  this computer, and only from its own page and the Watcher extension. Other
  websites and other devices on your network can't use it.
- Your conversations, settings and the parent PIN (stored only as a salted
  hash) stay in a local database in `server/data/`.
- Voice: see [Talk to it](#talk-to-it) for where speech is processed.
- Other devices can use OmniPilot only if you turn that on with a secret token
  ([docs/SDK.md](docs/SDK.md)), and the token only opens question-answering.
- Code that CodePilot writes is run in a throwaway folder with a 5-second
  limit, no access to your environment variables, and a block on code that
  touches files, the network or other programs. Turn this off with
  `CODE_VERIFY=off`.
- Integration tokens you paste (Slack/GitHub/Notion) are verified with the
  provider and stored locally; they're never shown in logs or in the app.

Found a security problem? See [SECURITY.md](SECURITY.md).

## Smarter answers

Even a strong model makes slips, so OmniPilot gives the model
better tools:

- **Exact tools.** Counting letters, comparing decimals, primes, percentages,
  unit conversions and dates are calculated by code, not guessed ("how many r's
  in strawberry?", "which is bigger, 9.11 or 9.9?"). These work even without the
  AI model.
- **Calculated word problems.** The model writes the steps and OmniPilot does the
  arithmetic exactly, then checks the result against the model's own step-by-step answer.
- **An offline encyclopedia.** Run `npm run knowledge` once (needs
  [uv](https://docs.astral.sh/uv/); downloads 157 MB of Simple English
  Wikipedia, 183 MB on disk). Factual answers are then based on the article and
  cite it, instead of relying on the model's memory.
- **Knowing when it doesn't know.** Short factual answers are checked by asking
  again; if the model can't give the same answer twice, it tells you so.

## Private by default: the AI runs on your computer

OmniPilot answers with a model on your own computer (Qwen3 4B through Ollama, 2.5 GB:
`brew install ollama && ollama pull qwen3:4b-instruct`) and only uses Groq's stronger models when it's
really needed: building a whole project, designing a 3D model, long research write-ups, or when the
local answer isn't usable. Every answer records where it was made.

## Keys from Infisical

Keys are read from Infisical first (the project in `.infisical.json`, environment `dev`), then from
`server/.env` and `.env` as a fallback when Infisical can't be reached. On this computer, sign in once with
`infisical login`; on a server, give OmniPilot a machine identity's token as `INFISICAL_TOKEN` (the CLI must
be installed there too). `OMNIPILOT_INFISICAL_ENV=prod` reads another environment, `OMNIPILOT_INFISICAL=0`
turns Infisical off. See where each service's key came from: `cd engine && uv run python -m omnipilot_engine.tools.status`.

## Attachments and memory

Attach a PDF, Word or PowerPoint file (or notes as .txt/.md) and ask about it: PDFs are read on your
computer, and questions about a file are answered from the file itself by the model on your computer. Word
and PowerPoint files (and scanned PDFs) go to LlamaParse when it's set up. Say "remember that …" to keep a
fact (Mem0), "index my notes" then "search my notes about …" to find notes by meaning (Qdrant), or name
another app ("add a Trello card …") to use it through Arcade, with your approval for anything it changes.

## Tool services

OmniPilot can use Exa, Tavily, SerpApi and You.com (search), LlamaParse (PDFs and documents to text),
Mem0 and Zep (cloud memory, only when you ask it to remember something), Resend (email, always with your
approval), Tabstack and Browserbase (reading pages), Stagehand
and Browser Use (cloud browsers), Apify (bulk scraping), E2B and Daytona (code sandboxes), Context7
(library docs), Composio and Arcade (actions in your apps, with approval), Qdrant (searching notes you
ask it to index; the embeddings are made on your computer by Ollama's `nomic-embed-text`), Deepgram
(speech to text, only when on-device Whisper can't run; turn off with `OMNIPILOT_CLOUD_SPEECH=0`) and
Trigger.dev (background jobs). It
picks **one** service per job, with a shared budget of calls, time and estimated cost per request, a
day-long cache for repeated look-ups, a few retries, and sandboxes/browser sessions always closed.
See which are working: `cd engine && uv run python -m omnipilot_engine.tools.status verify`.

## The AI model

**Groq's free tier has limits**: about 200,000 tokens per model per day (plus per-minute limits).
Building a whole project or a detailed 3D model uses a lot of that, so on a busy day OmniPilot may
slow down (it waits for per-minute limits to reset and spreads work across the backup models) or say
the daily limit is used up and when it resets. A paid Groq tier removes this.

To make the free tier go further, OmniPilot **remembers answers for 24 hours**: asking the same
thing again (rehearsing a demo, say) is instant and costs no tokens (creative requests are always
answered fresh; `OMNIPILOT_AI_CACHE=off` turns this off). It also **tracks how much of each model's
daily allowance it has used** (`GROQ_DAILY_TOKENS`, default 200,000) and shows a warning at the top
of the page when less than a fifth is left. Building projects and 3D models waits briefly for the
strongest model instead of settling for a weaker backup.

Every agent uses one model on [Groq](https://groq.com)'s free tier: OpenAI's open
`openai/gpt-oss-120b`, the strongest model Groq offers there, set to reason before it
answers (`GROQ_REASONING=medium`). The free tier allows about 8,000 tokens a minute per
model, so when the main model is busy OmniPilot moves to `qwen/qwen3.8-27b` and then
`openai/gpt-oss-20b`, and back once the limit resets.

The only model that runs on your computer is Whisper (about 140 MB), which turns
what you say into text, so voice recordings never leave your machine.

The specialists still check the model's work: code is run against tests, math is
calculated exactly, quiz answer keys are re-checked, and facts can be looked up on the web.

## Chats

Every conversation is saved on your computer. Open **Chats** to go back to one
or delete it; the chat you were in comes back when you reload the page. Press
**Stop** to end an answer that's taking too long.

## Settings

Copy `server/.env.example` to `server/.env` to change things like the port, the
Groq models or how hard the model reasons (this works the same on every OS).

## Troubleshooting

| Problem | Fix |
| --- | --- |
| Anything | `npm run doctor` |
| "Port 8899 is already in use" | OmniPilot is probably already running: open <http://localhost:8899>. Or set `PORT=8900` in `server/.env`. |
| "Node.js … is too old" / `node:sqlite` not found | Install Node.js 22 or newer from [nodejs.org](https://nodejs.org). With nvm: `nvm install 22` then `nvm use 22` (in this folder, `nvm use` reads `.nvmrc`). |
| `vite: command not found` / build tools missing after `npm install` | Your shell has `NODE_ENV=production` set. Remove it, or run `NODE_ENV=development npm install` (macOS/Linux). |
| Answers are slow | The first answer loads the model; later ones are faster. The smaller model (`llama3.2:1b-instruct-q4_K_M`) is about three times faster but less accurate. |
| The mic button is greyed out | Your browser doesn't support voice input (Firefox). Use Chrome, Edge or Safari. |
| "Microphone access is blocked" | Click the icon in the address bar, allow the microphone for localhost, and try again. |
| Fans spin up while idle | That's MathPilot's background search. Pause it in the MathPilot panel, or set `MATHPILOT=off`. |

## Development

```bash
npm install
npm run dev:server   # API with auto-reload on http://localhost:8899
npm run dev:web      # UI with hot reload on http://localhost:5173
npm test             # server test suite (no AI model needed)
npm run build        # production build
npm run package:extension   # zips the extension into release/
```

To use OmniPilot from your own programs or hardware, see the SDK in [`sdk/`](sdk)
and the guide in [docs/SDK.md](docs/SDK.md).

How it works inside (router, coordinator, small-model techniques, security
model): [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Contributions welcome:
see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
