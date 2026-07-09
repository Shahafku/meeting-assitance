# Next Steps — where Shahaf is right now

> Handoff note so any Claude Code agent (CLI or VS Code) can continue without re-explaining.
> The app is **fully built, tested, and pushed to `main`** (all commits authored by Shahafku).
> What remains is **running it on the Mac for the first time** and learning the workflow.

## Status
- ✅ Code complete: Electron app + core pipeline + tests + CLI harness + README + CLAUDE.md
- ✅ On GitHub, branch `main` (and `claude/meeting-agent-brainstorm-rpdkp8`), authored by Shahafku
- ⬜ Not yet run on a real Mac
- ⬜ No API keys added yet (`.env` not created)
- ⬜ BlackHole audio not set up yet

## Remaining steps (do in order, on the Mac)
1. **Install Node.js** — https://nodejs.org (green LTS button).
2. **Get the project locally:**
   ```bash
   cd ~/Desktop
   git clone https://github.com/Shahafku/meeting-assitance.git
   cd meeting-assitance
   npm install
   ```
3. **Prove it works (no keys):**
   ```bash
   npm run harness -- --fixture tests/fixtures/mock-meeting.json --mock-llm --auto
   ```
4. **Add API keys:** sign up at console.deepgram.com and console.anthropic.com, then
   `cp .env.example .env` and paste the two keys in.
5. **One-time audio setup:** `brew install blackhole-2ch`, then Audio MIDI Setup →
   Create Multi-Output Device (tick both speakers + BlackHole 2ch). Set Mac output to it before calls.
6. **Run the app:** `npm run rebuild:electron` then `npm run dev` (grant mic permission).
7. **Use it:** New session → add prep notes → pick preset → Start listening → ⌘⇧Space for a
   suggestion → End session to save transcript + action items.

## Guidance for the assisting agent
- Shahaf is **non-technical** — give one step at a time, copy-pasteable commands, and wait for confirmation.
- Steps 5–6 (audio + first Electron launch) are the likely trouble spots. When an error appears,
  ask him to paste the red text and diagnose from there.
- Architecture, commands, and hard product constraints are in `CLAUDE.md`.
