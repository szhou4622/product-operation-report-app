import { app } from 'electron'
import { appendFile, mkdir, readFile, rename, stat } from 'fs/promises'
import { dirname, join } from 'path'
import type {
  ChatMessage,
  ModelTaskContext,
  ModelTaskType,
  ReportTokenSummary,
  TokenStageSummary,
  TokenUsageBucketSummary,
  TokenUsageDashboard,
  TokenOptimizationMetrics,
  TokenUsageRecord,
  TokenUsageStatus
} from '../shared/types'
import { getTokenOptimizationMetrics } from './costOptimization'

const LOG_FILE_NAME = 'token-usage.jsonl'
const MAX_LOG_BYTES = 64 * 1024 * 1024
const ROTATE_LOG_BYTES = 48 * 1024 * 1024
const MAX_IDENTIFIER_LENGTH = 240
const TASK_TYPES: readonly ModelTaskType[] = [
  'source_clean',
  'summary',
  'analysis_step',
  'final_part',
  'revision_part',
  'module_product_info',
  'module_platform_audience',
  'module_material_review',
  'module_benchmark',
  'module_selling_points',
  'module_voc',
  'module_ranking',
  'module_audience_sp_scene'
]
const FINAL_PART_IDS = new Set(['part-0-4', 'part-5-8', 'part-9', 'part-10-11'])

let appendQueue: Promise<void> = Promise.resolve()
let knownLogPath = ''
let knownEventIds: Set<string> | null = null

function safeIdentifier(value: unknown, required = false): string | undefined {
  if (typeof value !== 'string') return required ? undefined : undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_IDENTIFIER_LENGTH) return undefined
  if (!/^[\w.:@/+-]+$/u.test(trimmed)) return undefined
  return trimmed
}

function boundedCount(value: unknown, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) return undefined
  return value
}

export function sanitizeModelTaskContext(input: unknown): ModelTaskContext | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const value = input as Record<string, unknown>
  const reportSessionId = safeIdentifier(value.reportSessionId, true)
  const taskKey = safeIdentifier(value.taskKey, true)
  const billingRequestId = safeIdentifier(value.billingRequestId, true) || taskKey
  const taskType = TASK_TYPES.includes(value.taskType as ModelTaskType)
    ? (value.taskType as ModelTaskType)
    : undefined
  const attempt = boundedCount(value.attempt, 20)
  const sourceCount = boundedCount(value.sourceCount, 500)
  const imageCount = boundedCount(value.imageCount, 500)
  if (!reportSessionId || !taskKey || !billingRequestId || !taskType || !attempt || sourceCount === undefined || imageCount === undefined) {
    return undefined
  }
  return {
    reportSessionId,
    taskType,
    taskKey,
    billingRequestId,
    attempt,
    isVision: value.isVision === true,
    sourceCount,
    imageCount,
    sourceId: safeIdentifier(value.sourceId),
    stepId: safeIdentifier(value.stepId),
    partId: safeIdentifier(value.partId)
  }
}

export function tokenUsageLogPath(): string {
  return join(app.getPath('userData'), LOG_FILE_NAME)
}

export function tokenUsageDashboardEnabled(): boolean {
  return !app.isPackaged || process.env.PRODUCT_REPORT_ENABLE_TOKEN_STATS === '1'
}

function utf8TokenEstimate(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3)
}

/** 估算只用于标记 usage 缺失的规模，永远不并入真实 Token 合计。 */
export function estimateRequestTokens(
  messages: ChatMessage[],
  outputChars = 0
): { inputTokens: number; outputTokens: number; totalTokens: number } {
  let inputTokens = 0
  for (const message of messages) {
    inputTokens += 4
    if (typeof message.content === 'string') {
      inputTokens += utf8TokenEstimate(message.content)
      continue
    }
    for (const part of message.content) {
      inputTokens += part.type === 'text' ? utf8TokenEstimate(part.text) : 2_000
    }
  }
  const outputTokens = Math.ceil(Math.max(0, outputChars) / 3)
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }
}

export function classifyModelFailure(message: string, status: TokenUsageStatus): string | undefined {
  if (status === 'started' || status === 'success') return undefined
  if (status === 'aborted') return 'user_aborted'
  if (/HTTP\s+(401|403)\b|unauthori[sz]ed|forbidden|API\s*Key|鉴权|认证失败|授权失败/i.test(message)) return 'authentication'
  if (/content[_ -]?filter|policy[_ -]?violation|blocked|内容安全|安全限制|政策拒绝|safety/i.test(message)) return 'safety'
  if (/provider_route_unavailable/i.test(message)) return 'provider_route_unavailable'
  if (/429|额度受限|服务繁忙/i.test(message)) return 'rate_limited'
  if (/model[_ -]?(not[_ -]?found|unavailable)|unknown model|模型不存在|模型不可用/i.test(message)) return 'model_unavailable'
  if (/HTTP\s+4\d\d\b/i.test(message)) return 'client_error'
  if (/timeout|超时|长时间没有响应/i.test(message)) return 'timeout'
  if (/fetch failed|ECONN|ENOTFOUND|network|网络|terminated|socket/i.test(message)) return 'network'
  if (/不完整|提前结束|length/i.test(message)) return 'incomplete'
  if (/空内容|没有返回任何内容|没有收到有效/i.test(message)) return 'empty_output'
  if (/JSON|流式数据|HTML|Base URL/i.test(message)) return 'protocol'
  return 'provider_error'
}

function isRecord(value: unknown): value is TokenUsageRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<TokenUsageRecord>
  return (
    record.schemaVersion === 1 &&
    (record.eventType === 'started' || record.eventType === 'final') &&
    typeof record.requestId === 'string' &&
    record.requestId.length > 0 &&
    record.requestId.length <= MAX_IDENTIFIER_LENGTH &&
    Boolean(sanitizeModelTaskContext(record)) &&
    typeof record.startedAt === 'string' &&
    typeof record.endedAt === 'string' &&
    typeof record.model === 'string' &&
    ['started', 'success', 'error', 'aborted'].includes(record.status || '') &&
    ['provider', 'missing'].includes(record.usageSource || '')
  )
}

function eventId(record: Pick<TokenUsageRecord, 'requestId' | 'eventType'>): string {
  return `${record.requestId}:${record.eventType}`
}

export async function readTokenUsageRecords(path = tokenUsageLogPath()): Promise<TokenUsageRecord[]> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_LOG_BYTES) {
    console.warn('Token usage log exceeded the expected size; valid records will still be recovered.')
  }
  const records: TokenUsageRecord[] = []
  for (const line of raw.split(/\r?\n/u)) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as unknown
      if (isRecord(parsed)) {
        records.push({
          ...parsed,
          reasoningTokens:
            typeof parsed.reasoningTokens === 'number' && Number.isFinite(parsed.reasoningTokens)
              ? Math.max(0, Math.floor(parsed.reasoningTokens))
              : 0
        })
      }
    } catch {
      // 忽略崩溃时可能留下的最后一条不完整 JSON，保留此前所有有效记录。
    }
  }
  return records
}

async function rotateTokenLogIfNeeded(path: string, nextBytes: number): Promise<void> {
  let bytes = 0
  try {
    bytes = (await stat(path)).size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (bytes + nextBytes <= ROTATE_LOG_BYTES) return
  const month = new Date().toISOString().slice(0, 7).replace('-', '')
  let archive = join(dirname(path), `token-usage-${month}.jsonl.archive`)
  for (let index = 2; index < 100; index++) {
    try {
      await stat(archive)
      archive = join(dirname(path), `token-usage-${month}-${index}.jsonl.archive`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break
      throw error
    }
  }
  await rename(path, archive)
  knownLogPath = path
  knownEventIds = new Set()
}

async function loadKnownEventIds(path: string): Promise<Set<string>> {
  if (knownEventIds && knownLogPath === path) return knownEventIds
  knownLogPath = path
  knownEventIds = new Set((await readTokenUsageRecords(path)).map(eventId))
  return knownEventIds
}

export async function appendTokenUsageRecord(record: TokenUsageRecord): Promise<boolean> {
  if (!isRecord(record)) throw new Error('Token 计量记录格式无效。')
  const path = tokenUsageLogPath()
  let appended = false
  appendQueue = appendQueue.then(async () => {
    const id = eventId(record)
    await mkdir(dirname(path), { recursive: true })
    const line = `${JSON.stringify(record)}\n`
    await rotateTokenLogIfNeeded(path, Buffer.byteLength(line, 'utf8'))
    const activeIds = await loadKnownEventIds(path)
    if (activeIds.has(id)) return
    await appendFile(path, line, { encoding: 'utf8', mode: 0o600 })
    activeIds.add(id)
    appended = true
  })
  await appendQueue
  return appended
}

function coalesceAttempts(records: TokenUsageRecord[]): TokenUsageRecord[] {
  const attempts = new Map<string, TokenUsageRecord>()
  for (const record of records) {
    const current = attempts.get(record.requestId)
    if (!current || (current.eventType === 'started' && record.eventType === 'final')) {
      attempts.set(record.requestId, record)
    }
  }
  return [...attempts.values()].map((record) => {
    if (record.eventType === 'final') return record
    return {
      ...record,
      eventType: 'final',
      status: 'aborted',
      failureKind: 'process_ended',
      endedAt: record.startedAt,
      durationMs: 0
    }
  })
}

function emptyStage(taskType: ModelTaskType): TokenStageSummary {
  return {
    taskType,
    attempts: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    totalTokens: 0
  }
}

function sumProviderTokens(target: TokenStageSummary | ReportTokenSummary, record: TokenUsageRecord): void {
  if (record.usageSource !== 'provider') return
  target.inputTokens += record.inputTokens
  target.outputTokens += record.outputTokens
  target.reasoningTokens += record.reasoningTokens || 0
  target.cachedInputTokens += record.cachedInputTokens
  target.cacheCreationInputTokens += record.cacheCreationInputTokens
  target.totalTokens += record.totalTokens
}

function summarizeReport(reportSessionId: string, records: TokenUsageRecord[]): ReportTokenSummary {
  const ordered = [...records].sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  const stages = new Map<ModelTaskType, TokenStageSummary>(TASK_TYPES.map((type) => [type, emptyStage(type)]))
  const successfulFinalParts = new Set<string>()
  const summary: ReportTokenSummary = {
    reportSessionId,
    startedAt: ordered[0]?.startedAt || '',
    endedAt: ordered.at(-1)?.endedAt || '',
    completed: false,
    exact: true,
    sourceCount: 0,
    imageCount: 0,
    attempts: ordered.length,
    successAttempts: 0,
    failedAttempts: 0,
    abortedAttempts: 0,
    retryAttempts: 0,
    missingUsageAttempts: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    totalTokens: 0,
    successfulTokens: 0,
    failedTokens: 0,
    abortedTokens: 0,
    retryTokens: 0,
    estimatedMissingTokens: 0,
    stages: []
  }
  for (const record of ordered) {
    summary.sourceCount = Math.max(summary.sourceCount, record.sourceCount)
    summary.imageCount = Math.max(summary.imageCount, record.imageCount)
    if (record.status === 'success') summary.successAttempts++
    else if (record.status === 'aborted') summary.abortedAttempts++
    else summary.failedAttempts++
    if (record.attempt > 1) summary.retryAttempts++
    if (record.usageSource === 'missing') {
      summary.missingUsageAttempts++
      summary.exact = false
      summary.estimatedMissingTokens += record.estimatedTotalTokens || 0
    }
    sumProviderTokens(summary, record)
    if (record.usageSource === 'provider') {
      if (record.status === 'success') summary.successfulTokens += record.totalTokens
      else if (record.status === 'aborted') summary.abortedTokens += record.totalTokens
      else summary.failedTokens += record.totalTokens
      if (record.attempt > 1) summary.retryTokens += record.totalTokens
    }
    const stage = stages.get(record.taskType)!
    stage.attempts++
    sumProviderTokens(stage, record)
    if (record.status === 'success' && record.taskType === 'final_part' && record.partId) {
      successfulFinalParts.add(record.partId)
    }
  }
  summary.completed = [...FINAL_PART_IDS].every((partId) => successfulFinalParts.has(partId))
  summary.stages = TASK_TYPES.map((type) => stages.get(type)!)
  return summary
}

function percentile(values: number[], ratio: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)]
}

function sourceBucket(sourceCount: number): TokenUsageBucketSummary['label'] {
  if (sourceCount <= 5) return '1–5份'
  if (sourceCount <= 10) return '6–10份'
  if (sourceCount <= 20) return '11–20份'
  return '21份以上'
}

export function buildTokenUsageDashboard(
  rawRecords: TokenUsageRecord[],
  enabled = true,
  logPath?: string,
  optimization: TokenOptimizationMetrics = {
    localCompletedFiles: 0,
    sourceCacheHits: 0,
    skippedModelRequests: 0,
    reusedReports: 0
  }
): TokenUsageDashboard {
  const attempts = coalesceAttempts(rawRecords)
  const grouped = new Map<string, TokenUsageRecord[]>()
  for (const record of attempts) {
    const list = grouped.get(record.reportSessionId) || []
    list.push(record)
    grouped.set(record.reportSessionId, list)
  }
  const reports = [...grouped.entries()]
    .map(([id, records]) => summarizeReport(id, records))
    .sort((a, b) => b.endedAt.localeCompare(a.endedAt))
  const exactCompleted = reports.filter((report) => report.completed && report.exact)
  const totals = exactCompleted.map((report) => report.totalTokens)
  const labels: TokenUsageBucketSummary['label'][] = ['1–5份', '6–10份', '11–20份', '21份以上']
  const buckets = labels.map((label) => {
    const bucketReports = reports.filter((report) => sourceBucket(report.sourceCount) === label)
    const exact = bucketReports.filter((report) => report.completed && report.exact)
    return {
      label,
      reportCount: bucketReports.length,
      exactCompletedCount: exact.length,
      averageTotalTokens: exact.length
        ? Math.round(exact.reduce((sum, report) => sum + report.totalTokens, 0) / exact.length)
        : 0
    }
  })
  return {
    enabled,
    logPath,
    recordCount: attempts.length,
    providerRecordCount: attempts.filter((record) => record.usageSource === 'provider').length,
    missingUsageRecordCount: attempts.filter((record) => record.usageSource === 'missing').length,
    completedExactReports: exactCompleted.length,
    percentiles: {
      sampleSize: totals.length,
      p50: percentile(totals, 0.5),
      p75: percentile(totals, 0.75),
      p95: percentile(totals, 0.95)
    },
    buckets,
    reports,
    optimization
  }
}

export async function getTokenUsageDashboard(): Promise<TokenUsageDashboard> {
  const enabled = tokenUsageDashboardEnabled()
  if (!enabled) return buildTokenUsageDashboard([], false)
  const path = tokenUsageLogPath()
  const [records, optimization] = await Promise.all([
    readTokenUsageRecords(path),
    getTokenOptimizationMetrics()
  ])
  return buildTokenUsageDashboard(records, true, path, optimization)
}

export const tokenUsageInternals = {
  MAX_LOG_BYTES,
  ROTATE_LOG_BYTES,
  rotateTokenLogIfNeeded,
  coalesceAttempts,
  resetForTests(): void {
    appendQueue = Promise.resolve()
    knownLogPath = ''
    knownEventIds = null
  }
}
