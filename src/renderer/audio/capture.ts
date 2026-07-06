/**
 * Dual-source audio capture (R1), no native code:
 *   input 0: the physical microphone           → transcript channel 0 ("Me")
 *   input 1: the BlackHole virtual device      → transcript channel 1 (everyone else)
 *
 * Both sources feed one AudioContext so their samples stay aligned, get
 * merged into a 2-channel stream, and an AudioWorklet ships interleaved
 * 16-bit PCM to the main process every ~100 ms.
 */

const WORKLET_SOURCE = `
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.frames = []
    this.samples = 0
    this.flushAt = 1600 // 100ms at 16kHz
  }
  process(inputs) {
    const input = inputs[0]
    if (input && input.length > 0) {
      const left = input[0]
      const right = input.length > 1 ? input[1] : input[0]
      const copyL = new Float32Array(left)
      const copyR = new Float32Array(right)
      this.frames.push([copyL, copyR])
      this.samples += left.length
      if (this.samples >= this.flushAt) {
        const out = new Int16Array(this.samples * 2)
        let i = 0
        for (const [l, r] of this.frames) {
          for (let s = 0; s < l.length; s++) {
            out[i++] = Math.max(-32768, Math.min(32767, Math.round(l[s] * 32767)))
            out[i++] = Math.max(-32768, Math.min(32767, Math.round((r[s] ?? 0) * 32767)))
          }
        }
        this.port.postMessage(out.buffer, [out.buffer])
        this.frames = []
        this.samples = 0
      }
    }
    return true
  }
}
registerProcessor('pcm-capture', PcmCapture)
`

export interface CaptureHandles {
  stop: () => void
}

export async function startCapture(opts: {
  micDeviceId?: string
  systemDeviceId?: string
  sampleRate?: number
  onChunk: (buf: ArrayBuffer) => void
}): Promise<CaptureHandles> {
  const sampleRate = opts.sampleRate ?? 16_000

  const micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...(opts.micDeviceId ? { deviceId: { exact: opts.micDeviceId } } : {}),
      // Echo cancellation keeps the far side's voice out of the mic channel,
      // so "Me" doesn't double-transcribe the other participants.
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  })
  const systemStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...(opts.systemDeviceId ? { deviceId: { exact: opts.systemDeviceId } } : {}),
      // The virtual device carries clean system audio — don't process it.
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    }
  })

  const ctx = new AudioContext({ sampleRate })
  const workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }))
  await ctx.audioWorklet.addModule(workletUrl)
  URL.revokeObjectURL(workletUrl)

  const micSource = ctx.createMediaStreamSource(micStream)
  const sysSource = ctx.createMediaStreamSource(systemStream)
  const merger = ctx.createChannelMerger(2)
  micSource.connect(merger, 0, 0)
  sysSource.connect(merger, 0, 1)

  const worklet = new AudioWorkletNode(ctx, 'pcm-capture', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 2,
    channelCountMode: 'explicit',
    channelInterpretation: 'discrete'
  })
  merger.connect(worklet)
  // Route through a muted gain so the graph stays live without audible output.
  const mute = ctx.createGain()
  mute.gain.value = 0
  worklet.connect(mute)
  mute.connect(ctx.destination)

  worklet.port.onmessage = (e: MessageEvent<ArrayBuffer>) => opts.onChunk(e.data)

  return {
    stop: () => {
      worklet.port.onmessage = null
      for (const t of micStream.getTracks()) t.stop()
      for (const t of systemStream.getTracks()) t.stop()
      void ctx.close()
    }
  }
}

/** Lists audio inputs, prompting for mic permission once so labels are readable. */
export async function listAudioInputs(): Promise<MediaDeviceInfo[]> {
  try {
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true })
    for (const t of probe.getTracks()) t.stop()
  } catch {
    // Permission denied — labels will be blank but enumeration still works.
  }
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices.filter((d) => d.kind === 'audioinput')
}

/** Best-effort default for the system-audio device: anything BlackHole-ish. */
export function guessSystemDevice(devices: MediaDeviceInfo[]): MediaDeviceInfo | undefined {
  return devices.find((d) => /blackhole/i.test(d.label))
}
