# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Meeting Copilot: a macOS Electron app that captures call audio locally, transcribes it live with speaker labels, and — only on a global hotkey — returns one short, context-grounded suggestion. On session end it generates a transcript, summary, and action items. Single-user personal tool. See `README.md` for the product spec and design principles (transparent/not-stealth, local listener/not a meeting bot, pull-not-push, presets = prompt config).

## Commands

```bash
npm run dev            # run the Electron app (electron-vite dev)
npm run build          # production build → out/
npm run typecheck      # tsc --noEmit
npm test               # vitest run (all tests)
npx vitest run tests/session.test.ts          # single test file
npx vitest run -t "debounces rapid double"    # single test by name
npm run harness -- --fixture tests/fixtures/mock-meeting.json --mock-llm --auto  # e2e pipeline, offline
```

**Native module ABI gotcha:** `better-sqlite3` must be compiled against the right runtime.
- Before `npm run dev`/`build`: `npm run rebuild:electron` (Electron ABI).
- Before `npm test`/`npm run harness`: `npm run rebuild:node` (Node ABI).
Switching between running the app and running tests/harness requires re-running the matching rebuild. The tests and harness are the primary way to validate changes in a headless/Linux environment — the Electron binary download is often blocked there, so `npm run dev` may only work on the target Mac.

## Architecture

Three-layer Electron app. The **core logic is UI-free and lives entirely in `src/main/`**, orchestrated by `SessionManager`; the Electron shell and React renderers are a thin layer on top. This separation is deliberate — it's why the CLI harness can exercise the whole pipeline without a UI.

**`SessionManager` (`src/main/session.ts`) is the heart.** It owns one live session's lifecycle and emits events (`transcript`, `status`, `suggestion`, `ended`). Everything flows through it:
- Audio in → `SttProvider` → transcript events → **written through to SQLite immediately** (crash-safety: transcript must survive `kill -9`).
- Hotkey → `summon()` → windowed transcript + context + preset → LLM → one suggestion.
- End → `finalizeSession()` → LLM artifacts (summary + action items) → stored.

**Provider interfaces make everything swappable and testable.** Both STT and LLM are behind interfaces with real + mock implementations:
- `SttProvider` (`src/main/stt/types.ts`): `DeepgramProvider` (live, Deepgram v5 SDK) and `MockSttProvider` (scripted/manual). Deepgram is called with `multichannel + diarize`; **channel 0 = the user's mic ("Me"), channel 1 = system audio (everyone else), diarized into "Speaker N".** `wordsToSpeakerRuns` splits one result into per-speaker runs. A `BoundedByteQueue` buffers audio during socket drops and replays on reconnect (drives the "degraded" status).
- `LlmClient` (`src/main/llm/types.ts`): `AnthropicLlm` and `MockLlm`. Two call types with different models — **summon uses a fast model (Haiku, hard word-cap), artifacts + context-summarization use a larger model (Sonnet).** Model ids are in `src/main/llm/anthropic.ts` (overridable via `SUGGEST_MODEL`/`ARTIFACT_MODEL` env vars).

When adding a feature, prefer extending `SessionManager` and the provider interfaces over touching the Electron/React layer. Test against the mocks.

### Key behaviors to preserve
- **Write-through storage** (`src/main/store/store.ts`, WAL mode): every finalized transcript chunk is persisted on arrival, not on session end. `recoverOrphanSessions()` closes sessions left `active` by a crash and generates their artifacts from stored chunks (called at app startup).
- **Summon windowing/debounce** (`SessionManager.summon`): only the last `TRANSCRIPT_WINDOW_MS` of transcript is sent (measured against latest audio time, not wall clock — see `Store.getRecentChunks`). A second concurrent press is ignored (not queued). **Every press is logged via `logHotkey` even when ignored** — this log is the intended dataset for a future proactive mode, do not remove it.
- **Word cap** enforced both in the preset prompt and defensively via `capWords`.
- **Context summarization**: prep material over `CONTEXT_SUMMARIZE_THRESHOLD_CHARS` is summarized once at session start and cached; summons use the cached summary.
- **`cleanedTranscript`** merges consecutive same-speaker chunks locally (deterministic, no LLM call) — this is the "cleaned transcript" artifact.

### Scenarios are config, not code
Presets live as markdown in `prompts/*.md` (`interview.md`, `general.md`). Each file's first `#` heading is its display title; the whole file is the summon system prompt. `prompts.ts` re-reads them on every summon (free hot-reload). **Every preset must keep the two hard rules: max ~50 words, and never invent facts absent from the prep material** (anti-hallucination) — the `tests/prompts.test.ts` suite asserts this. Adding a scenario = dropping a new `.md` file; it appears in the picker automatically.

### Electron layer
- `src/main/index.ts`: app lifecycle, tray ("● Listening" indicator reflects capture status — the app must never listen silently), two `BrowserWindow`s, global hotkey (`config.ts:SUMMON_HOTKEY`), and all IPC handlers. `MOCK_MODE=1` runs the app with mock STT/LLM (no keys, no audio) for UI work.
- `src/preload/index.ts` exposes the typed `CopilotApi` bridge (`src/shared/api.ts`) to both renderers. All renderer↔main calls go through this; audio chunks use a fire-and-forget `ipcRenderer.send`.
- `src/renderer/audio/capture.ts`: **the only place real audio is captured.** Pure `getUserMedia` + an inline AudioWorklet — no native code. Captures mic + BlackHole virtual device, merges to 2-channel interleaved PCM16, ships to main. BlackHole setup is a documented one-time manual step (README).
- Renderer windows: `main-window/` (session setup + history browser) and `overlay/` (small always-on-top suggestion window with 👍/👎 rating). The overlay is deliberately a normal, screen-shareable window (transparency principle) — do not add stealth/hidden-window behavior.

## Constraints from the product spec (do not violate)
- No stealth or screen-share-hiding features, ever.
- No meeting-platform/bot integration, no proactive suggestions, no CRM/calendar/contact enrichment in v1 — these are explicitly deferred (see README P1/P2).
- Secrets only via `.env` (gitignored); `.env.example` documents the two required keys.
