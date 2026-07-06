/**
 * Bounded FIFO byte queue used to hold audio while the STT socket is
 * down. Oldest audio is dropped first once the cap is hit, so a long
 * outage degrades gracefully instead of exhausting memory.
 */
export class BoundedByteQueue {
  private chunks: Uint8Array[] = []
  private bytes = 0

  constructor(private readonly maxBytes: number) {}

  push(chunk: Uint8Array): void {
    this.chunks.push(chunk)
    this.bytes += chunk.byteLength
    while (this.bytes > this.maxBytes && this.chunks.length > 0) {
      const dropped = this.chunks.shift()!
      this.bytes -= dropped.byteLength
    }
  }

  /** Returns all buffered chunks (oldest first) and empties the queue. */
  drain(): Uint8Array[] {
    const out = this.chunks
    this.chunks = []
    this.bytes = 0
    return out
  }

  get size(): number {
    return this.bytes
  }
}
