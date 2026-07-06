export const SUMMON_HOTKEY = 'CommandOrControl+Shift+Space'

/** How much trailing transcript a summon sees (R5: "last ~2 minutes"). */
export const TRANSCRIPT_WINDOW_MS = 120_000

/** Context above roughly this size (~6k tokens) gets summarized once at session start. */
export const CONTEXT_SUMMARIZE_THRESHOLD_CHARS = 24_000

export const AUDIO_SAMPLE_RATE = 16_000
export const AUDIO_CHANNELS = 2
