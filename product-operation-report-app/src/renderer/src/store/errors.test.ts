import { describe, expect, it } from 'vitest'
import { friendlyError } from './errors'

describe('friendlyError', () => {
  it('maps disk and network failures to novice-readable messages', () => {
    expect(friendlyError(new Error('ENOSPC: no space left'))).toMatch(/磁盘空间不足/u)
    expect(friendlyError(new Error('fetch failed ECONNRESET'))).toMatch(/网络连接失败/u)
  })
})
