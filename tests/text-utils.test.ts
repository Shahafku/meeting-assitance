import { describe, expect, it } from 'vitest'
import { capWords, extractJsonObject } from '../src/main/llm/text-utils'
import { BoundedByteQueue } from '../src/main/stt/bounded-queue'
import { wordsToSpeakerRuns } from '../src/main/stt/deepgram'

describe('capWords', () => {
  it('leaves short text untouched', () => {
    expect(capWords('two words', 60)).toBe('two words')
  })
  it('truncates at the cap with ellipsis', () => {
    const long = Array.from({ length: 80 }, (_, i) => `w${i}`).join(' ')
    const capped = capWords(long, 60)
    expect(capped.split(/\s+/)).toHaveLength(60)
    expect(capped.endsWith('…')).toBe(true)
  })
})

describe('extractJsonObject', () => {
  it('parses a bare object', () => {
    expect(extractJsonObject('{"a": 1}')).toEqual({ a: 1 })
  })
  it('parses an object wrapped in prose and fences', () => {
    const raw = 'Here you go:\n```json\n{"summary": "ok", "action_items": []}\n```\nDone.'
    expect(extractJsonObject(raw)).toEqual({ summary: 'ok', action_items: [] })
  })
  it('handles braces inside strings', () => {
    expect(extractJsonObject('x {"s": "a { b } c"} y')).toEqual({ s: 'a { b } c' })
  })
  it('returns null for garbage', () => {
    expect(extractJsonObject('no json here')).toBeNull()
  })
})

describe('BoundedByteQueue', () => {
  it('buffers and drains in order', () => {
    const q = new BoundedByteQueue(100)
    q.push(new Uint8Array([1]))
    q.push(new Uint8Array([2]))
    expect(q.drain().map((c) => c[0])).toEqual([1, 2])
    expect(q.size).toBe(0)
  })
  it('drops oldest audio past the cap', () => {
    const q = new BoundedByteQueue(10)
    q.push(new Uint8Array(6).fill(1))
    q.push(new Uint8Array(6).fill(2))
    const out = q.drain()
    expect(out).toHaveLength(1)
    expect(out[0][0]).toBe(2)
  })
})

describe('wordsToSpeakerRuns', () => {
  it('splits a result into per-speaker runs', () => {
    const runs = wordsToSpeakerRuns([
      { word: 'hi', punctuated_word: 'Hi,', start: 0, end: 0.5, speaker: 0 },
      { word: 'dana', punctuated_word: 'Dana.', start: 0.5, end: 1, speaker: 0 },
      { word: 'hello', punctuated_word: 'Hello!', start: 1.2, end: 1.8, speaker: 1 }
    ])
    expect(runs).toEqual([
      { speaker: 0, text: 'Hi, Dana.', start: 0, end: 1 },
      { speaker: 1, text: 'Hello!', start: 1.2, end: 1.8 }
    ])
  })
})
