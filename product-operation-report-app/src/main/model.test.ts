import { describe, expect, it } from 'vitest'
import { modelStreamTimeouts } from './model'

describe('stream timeout policy', () => {
  it('allows a slower first response while retaining idle and absolute protection', () => {
    expect(modelStreamTimeouts.firstByteMs).toBe(180_000)
    expect(modelStreamTimeouts.idleMs).toBe(90_000)
    expect(modelStreamTimeouts.absoluteMs).toBe(15 * 60_000)
    expect(modelStreamTimeouts.absoluteMs).toBeGreaterThan(modelStreamTimeouts.firstByteMs)
  })
})
