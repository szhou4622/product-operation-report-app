import { app } from 'electron'
import { appendFile, mkdir, readFile, rm } from 'fs/promises'
import { dirname, join } from 'path'
import type { CostOptimizationEvent, TokenOptimizationMetrics } from '../shared/types'

const LOG_FILE_NAME = 'cost-optimization.jsonl'
const MAX_LOG_BYTES = 16 * 1024 * 1024
const MAX_IDENTIFIER_LENGTH = 240
let appendQueue: Promise<void> = Promise.resolve()
let knownIds: Set<string> | null = null
let knownPath = ''

export function costOptimizationLogPath(): string {
  return join(app.getPath('userData'), LOG_FILE_NAME)
}

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_IDENTIFIER_LENGTH && /^[\w.:@/+-]+$/u.test(value)
}

function validCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 10_000
}

function isEvent(value: unknown): value is CostOptimizationEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const event = value as Partial<CostOptimizationEvent>
  return (
    event.schemaVersion === 1 &&
    validIdentifier(event.id) &&
    validIdentifier(event.reportSessionId) &&
    ['local_source_clean', 'source_cache_hit', 'report_cache_reuse'].includes(event.type || '') &&
    typeof event.createdAt === 'string' &&
    Number.isFinite(Date.parse(event.createdAt)) &&
    validCount(event.localCompletedFiles) &&
    validCount(event.sourceCacheHits) &&
    validCount(event.skippedModelRequests) &&
    validCount(event.reusedReports)
  )
}

export async function readCostOptimizationEvents(path = costOptimizationLogPath()): Promise<CostOptimizationEvent[]> {
  let raw = ''
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_LOG_BYTES) throw new Error('成本优化统计文件过大，请先归档。')
  const events: CostOptimizationEvent[] = []
  for (const line of raw.split(/\r?\n/u)) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as unknown
      if (isEvent(parsed)) events.push(parsed)
    } catch {
      // 忽略崩溃留下的最后一行不完整数据。
    }
  }
  return events
}

export async function appendCostOptimizationEvent(event: CostOptimizationEvent): Promise<boolean> {
  if (!isEvent(event)) throw new Error('成本优化统计记录格式无效。')
  const path = costOptimizationLogPath()
  let appended = false
  appendQueue = appendQueue.then(async () => {
    if (!knownIds || knownPath !== path) {
      knownPath = path
      knownIds = new Set((await readCostOptimizationEvents(path)).map((item) => item.id))
    }
    if (knownIds.has(event.id)) return
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 })
    knownIds.add(event.id)
    appended = true
  })
  await appendQueue
  return appended
}

export async function getTokenOptimizationMetrics(): Promise<TokenOptimizationMetrics> {
  const metrics: TokenOptimizationMetrics = {
    localCompletedFiles: 0,
    sourceCacheHits: 0,
    skippedModelRequests: 0,
    reusedReports: 0
  }
  for (const event of await readCostOptimizationEvents()) {
    metrics.localCompletedFiles += event.localCompletedFiles
    metrics.sourceCacheHits += event.sourceCacheHits
    metrics.skippedModelRequests += event.skippedModelRequests
    metrics.reusedReports += event.reusedReports
  }
  return metrics
}

export const costOptimizationInternals = {
  async resetForTests(): Promise<void> {
    try {
      await rm(costOptimizationLogPath(), { force: true })
    } finally {
      knownIds = null
      knownPath = ''
    }
  }
}
