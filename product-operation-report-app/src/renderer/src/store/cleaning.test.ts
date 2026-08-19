import { describe, expect, it } from 'vitest'
import {
  cleaningBatchConcurrency,
  isTemporaryReservationContention,
  planCleaningConcurrency
} from './cleaning'

describe('cleaning batch concurrency', () => {
  it('uses spare report slots without exceeding the server-wide limit', () => {
    expect(cleaningBatchConcurrency(1)).toBe(3)
    expect(cleaningBatchConcurrency(2)).toBe(2)
    expect(cleaningBatchConcurrency(3)).toBe(1)
    expect(cleaningBatchConcurrency(4)).toBe(1)
    for (const sourceWorkers of [1, 2, 3, 4]) {
      expect(sourceWorkers * cleaningBatchConcurrency(sourceWorkers)).toBeLessThanOrEqual(4)
    }
  })

  it('keeps the maximum 50-file and 600-batch workload within four active requests', () => {
    const plan = planCleaningConcurrency(50)
    expect(plan).toEqual({
      sourceWorkers: 4,
      batchWorkersPerSource: 1,
      maximumActiveRequests: 4
    })
    const totalBatches = 50 * 12
    const minimumWaves = Math.ceil(totalBatches / plan.maximumActiveRequests)
    expect(totalBatches).toBe(600)
    expect(minimumWaves).toBe(150)
  })

  it('waits for concurrent reservations but reports a real exhausted balance', () => {
    expect(isTemporaryReservationContention('HTTP 402 Payment Required：积分不足', 2)).toBe(true)
    expect(isTemporaryReservationContention('积分不足，本批需要预留积分', 1)).toBe(true)
    expect(isTemporaryReservationContention('积分不足，本批需要预留积分', 0)).toBe(false)
    expect(isTemporaryReservationContention('模型线路不可用', 3)).toBe(false)
  })
})
