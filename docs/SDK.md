# OmniPilot SDK: use it from your own code and devices

OmniPilot runs on your computer (or a Raspberry Pi) and answers over a small
HTTP API. The SDK wraps that API so a script, an app or a microcontroller can
ask questions, stream answers, make pictures and use MathPilot. Everything
still runs on your own hardware, for free.

| Folder | For |
| --- | --- |
| [`sdk/js`](../sdk/js) | JavaScript: Node 18+, Deno, Bun, browsers. No dependencies. |
| [`sdk/python`](../sdk/python) | Python 3.8+. One file, standard library only, ideal for a Raspberry Pi. |
| [`sdk/arduino`](../sdk/arduino) | ESP32 sketch: ask from the Serial Monitor over Wi-Fi. |

## On the same computer

Nothing to configure: start OmniPilot (`npm start`) and use the SDK.

```js
import { OmniPilot } from "./sdk/js/index.mjs"; // or: npm install ./sdk/js

const op = new OmniPilot(); // http://localhost:8899
const { answer } = await op.ask("Explain photosynthesis for a 5th grader");
console.log(answer);

// Stream the answer as it's written
await op.stream("Write a haiku about the sea", { onDelta: (text) => process.stdout.write(text) });

// Follow-ups that refer back
const chat = op.conversation();
await chat.ask("What is the capital of Australia?");
console.log((await chat.ask("And roughly how many people live there?")).answer);

// MathPilot
console.log(await op.checkIdentity("sin(x)^2 + cos(x)^2 = 1")); // { verdict: "true", ... }
console.log(await op.discoveries({ limit: 5 }));
```

```python
from omnipilot import OmniPilot   # copy sdk/python/omnipilot.py next to your script

op = OmniPilot()
print(op.ask("How do I connect a button to my Arduino?")["answer"])
for piece in op.stream("Tell me a fun fact about octopuses"):
    print(piece, end="", flush=True)
print(op.check_identity("(a+b)^2 = a^2 + b^2")["detail"])
```

The Python file is also a command-line tool:

```bash
python3 sdk/python/omnipilot.py "Is it true that 2^10 = 1024?"
python3 sdk/python/omnipilot.py                 # chat, with follow-ups
python3 sdk/python/omnipilot.py --check "sum(1/n^2, n, 1, inf) = pi^2/6"
python3 sdk/python/omnipilot.py --discoveries
```

## From another device (Raspberry Pi, ESP32, another computer)

OmniPilot only accepts connections from its own computer until you turn on
token access. In `server/.env` on the OmniPilot computer:

```bash
HOST=0.0.0.0
OMNIPILOT_API_TOKEN=paste-16-or-more-random-characters
```

Make a token with:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

Restart OmniPilot. It refuses to listen on the network without a token. On the
other device, point the SDK at the OmniPilot computer's IP address:

```bash
export OMNIPILOT_URL=http://192.168.1.20:8899
export OMNIPILOT_TOKEN=paste-the-same-token
python3 omnipilot.py "Hello from my Raspberry Pi"
```

```js
const op = new OmniPilot({ baseUrl: "http://192.168.1.20:8899", token: process.env.OMNIPILOT_TOKEN });
```

**What a token can do:** ask questions (`/api/ask`, `/api/chat`, the answer
stream), read status, and use MathPilot's check, status and discoveries. It
can't touch integrations, approvals or Watcher settings, and it's refused for
requests coming from a web page. Keep it secret like a password; anyone on
your network who has it can ask OmniPilot questions (including asking
CodePilot to write and run code in its sandbox).

### ESP32

Open [`sdk/arduino/OmniPilotAsk/OmniPilotAsk.ino`](../sdk/arduino/OmniPilotAsk/OmniPilotAsk.ino)
in the Arduino IDE, install **ArduinoJson** (v7) from the Library Manager, fill
in your Wi-Fi, the OmniPilot computer's address and the token, and upload. Type
a question in the Serial Monitor (115200 baud). The ESP32 is far too small to
run a language model itself. It sends the question to OmniPilot on your
network and prints the answer, using `textOnly: true` so replies stay small.

## Running OmniPilot itself on a Raspberry Pi

A Raspberry Pi 4 or 5 runs all of OmniPilot: the AI runs on Groq, so the Pi only
needs Node.js, an internet connection and a free Groq key.

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

git clone <this repository's URL> omnipilot && cd omnipilot
npm install
echo "GROQ_API_KEY=<your key from https://console.groq.com/keys>" >> server/.env
npm start
```

MathPilot's background search also runs there; set `MATHPILOT=off` if you'd
rather keep the CPU free.

## The HTTP API

The SDK is a thin layer over these endpoints, so any language can use them
directly. Send `Authorization: Bearer <token>` when calling from another device.

| Method and path | Body | Returns |
| --- | --- | --- |
| `POST /api/ask` | `{ message, conversationId?, textOnly? }` | `{ runId, status, answer, confidence, agents, limitations, attachments? }` after the whole run |
| `POST /api/chat` | `{ message, conversationId? }` | `{ runId }` immediately (202) |
| `GET /api/runs/:runId/events` | | Server-sent events: `answer_delta`, `agent_complete`, ..., ending in `final_response`, `clarification_needed` or `run_failed` |
| `GET /api/status` | | `{ version, localModel: { reachable, ready, models }, codeVerify }` |
| `POST /api/math/check` | `{ equation }` or `{ left, right }` | `{ verdict: "true" \| "false" \| "unclear", detail, counterexample?, pointsTested?, digits? }` |
| `GET /api/math/status` | | Search progress: `{ running, checked, discoveries, stage, stages, ... }` |
| `GET /api/math/discoveries?after=&limit=` | | `{ discoveries: [...] }`, newest first |

`/api/ask` and `/api/chat` allow 30 requests a minute.

Attachments carry the rich parts of an answer: `picture` (`src` is a `data:`
URL with an SVG illustration), `wiring-diagram` (HardwarePilot's diagram spec),
`watcher-setup` and `html-preview` (a web page CodePilot wrote).
