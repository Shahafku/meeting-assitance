# Meeting Copilot

A personal, **openly disclosed** meeting copilot for macOS. It listens to any call locally (no meeting bot, no Zoom/Meet integration), transcribes it in real time with speaker labels, and — only when you press a hotkey — shows one short suggestion grounded in the prep material you uploaded before the call. When the session ends you get a transcript, a summary, and action items, all stored locally.

Built as a single-user tool and portfolio piece. Design principles (from the spec):

1. **Transparent, not stealth** — the suggestion window is a normal window, visible in screen shares; a "● Listening" indicator is always shown while capturing. Disclose usage to other participants when appropriate.
2. **Local listener, not a meeting bot** — audio is captured on your Mac, so it works with Zoom, Meet, or an in-person conversation equally.
3. **Pull, not push** — silent by default; assistance appears only on the hotkey.
4. **Scenario = prompt config** — presets are editable markdown in [`prompts/`](prompts/), not code.

## How it works

```
mic ──────────────┐                       ┌─ hotkey (⌘⇧Space) ─→ Claude Haiku ─→ ≤50-word suggestion
                  ├─→ 2-channel PCM ─→ Deepgram (multichannel + diarization)
BlackHole ────────┘        │                                    (overlay window, 👍/👎 rating)
(system audio)             └─→ SQLite (write-through, crash-safe)
                                   │
                          end session ─→ Claude Sonnet ─→ summary + action items
```

- Channel 0 (your mic) is labeled **Me**; channel 1 (system audio = everyone else) is diarized into **Speaker 1 / Speaker 2 / …**
- Every finalized transcript line is written to SQLite immediately, so a crash or `kill -9` loses at most a few seconds.
- All data stays on your machine except the two inherent API paths: audio → Deepgram, text → Anthropic.

## Setup

### 1. Install dependencies

```bash
npm install
npm run rebuild:electron   # rebuilds better-sqlite3 against Electron's ABI
```

(To run the unit tests or the CLI harness afterwards, switch the native module back with `npm run rebuild:node`, and back again with `npm run rebuild:electron` before `npm run dev`.)

### 2. API keys

```bash
cp .env.example .env
# fill in DEEPGRAM_API_KEY and ANTHROPIC_API_KEY
```

### 3. System audio via BlackHole (one-time, ~10 minutes)

The app reads two input devices: your microphone, and a virtual device that carries the system audio (the other participants' voices).

1. Install [BlackHole 2ch](https://existential.audio/blackhole/) (free): `brew install blackhole-2ch`
2. Open **Audio MIDI Setup** (in /Applications/Utilities):
   - Click **+** → **Create Multi-Output Device**.
   - Check **both** your normal output (e.g. MacBook Pro Speakers or your headphones) **and** BlackHole 2ch.
3. Before a call, set the Mac's **sound output** to that Multi-Output Device (Option-click the menu-bar volume icon). You still hear everything through your speakers/headphones; BlackHole gets a copy the app can read.

> **Gotcha:** if you switch outputs (e.g. connect AirPods) the Multi-Output Device setup may need revisiting — audio only reaches the transcript while output routes through the Multi-Output Device.

### 4. Run

```bash
npm run dev
```

Grant microphone permission when prompted. In the app:

1. **New session** → title, scenario preset, mic + system-audio device (BlackHole is auto-selected when present), and your prep material (paste text and/or upload PDF/MD/TXT).
2. **Start listening** — the floating suggestion window opens and the menu bar shows **● Listening**.
3. During the call, press **⌘⇧Space** for one suggestion (≤50 words). Rate it 👍/👎 — that self-log decides what gets built next.
4. **End session** — summary and action items are generated and saved; browse everything under **History**.

## CLI harness (no UI, works on any OS)

The harness drives the exact same pipeline from the terminal — it's the tool's "Phase 0" kept as a permanent test rig.

```bash
# Fully offline: scripted transcript + mock LLM
npm run harness -- --fixture tests/fixtures/mock-meeting.json --mock-llm --auto

# Interactive mock run (press "s" to summon, "e" to end)
npm run harness -- --fixture tests/fixtures/mock-meeting.json --mock-llm

# Real pipeline: stream a 16-bit PCM WAV through Deepgram + Anthropic
npm run harness -- --wav path/to/mock-interview.wav
```

## Scenario presets

A preset is a markdown file in [`prompts/`](prompts/) — the system prompt for the summon call. `interview.md` and `general.md` ship with v1; add your own by dropping a new `.md` file (it appears in the picker automatically, and edits apply on the next summon, no restart). Every preset must keep the two hard rules: **max 50 words** and **never invent facts that aren't in the prep material**.

## Development

```bash
npm run typecheck
npm test            # vitest unit tests (needs the node ABI: npm run rebuild:node)
npm run build       # production build (out/)
```

Layout:

- `src/main/` — Electron main process: session orchestrator, SQLite store, STT client (Deepgram behind a swappable interface), LLM client, preset loader.
- `src/renderer/` — two windows: `main-window` (setup + history) and `overlay` (floating suggestions); `audio/` holds the getUserMedia → AudioWorklet capture.
- `harness/` — CLI replay rig.
- `MOCK_MODE=1 npm run dev` runs the app with mock STT/LLM (no keys, no audio) for UI work.

## First-real-call verification checklist (macOS)

- [ ] Play a YouTube video while speaking — both your words ("Me") and the video's audio appear in the transcript (R1).
- [ ] In a call with two other people, the transcript separates Me / Speaker 1 / Speaker 2 (R2).
- [ ] Upload prep material containing a fact that exists nowhere else, summon, and see the suggestion reflect it (R3).
- [ ] Summon about a topic *not* in the prep material — the suggestion says so instead of inventing specifics (R3 anti-hallucination).
- [ ] Hotkey-to-suggestion feels ≤5s; latency is recorded per suggestion in History (R5).
- [ ] `kill -9` the app mid-session; relaunch — the session is recovered as ended with its transcript intact (R7).
- [ ] Delete a session from History and confirm it's gone (R8).

## Privacy & disclosure

- Sessions live in a local SQLite database under `~/Library/Application Support/meeting-copilot/` — nothing syncs anywhere.
- Capture is never silent: menu-bar **● Listening** plus the status dot in both windows.
- **Delete session** removes every trace (transcript, context, suggestions, action items, hotkey log).
- Decide your disclosure habit before first external use — e.g. "I use a local note-taking assistant, no bot joins the call." Transparency is a hard rule of this project.

## What's deliberately not here (v1)

No meeting-bot integration, no stealth features (permanent), no proactive suggestions, no CRM/calendar enrichment, no multi-user anything. See the spec's P1/P2 lists — the hotkey-press log this version collects is the dataset that decides whether proactive mode is worth building.
