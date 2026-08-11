import { app } from 'electron'
import { createHash } from 'crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type {
  ReportResultCacheInput,
  ReportResultCacheLookupResult,
  ReportResultCacheSnapshot,
  ReportResultCacheStats,
  ReportResultCacheStoreResult
} from '../shared/types'
import { MODEL_RUNTIME_RULES_VERSION, REPORT_PROMPT_VERSION, REPORT_TEMPLATE_VERSION } from '../shared/reportVersions'
import { sourceCleanCacheKey } from './sourceCleanCache'

const CACHE_FILE_NAME = 'report-result-cache.json'
const CACHE_VERSION = 1
const CACHE_RETENTION_DAYS = 30
const MAX_CACHE_ENTRIES = 20
const MAX_CACHE_BYTES = 20 * 1024 * 1024
const MAX_SNAPSHOT_TEXT_CHARS = 8_000_000

interface StoredReportEntry {
  key: string
  createdAt: string
  lastUsedAt: string
  expiresAt: string
  model: string
  snapshot: ReportResultCacheSnapshot
}

interface StoredReportCache {
  version: 1
  totalHits: number
  entries: StoredReportEntry[]
}

const cacheFile = (): string => join(app.getPath('userData'), CACHE_FILE_NAME)
const backupFile = (): string => `${cacheFile()}.bak`

function emptyCache(): StoredReportCache {
  return { version: CACHE_VERSION, totalHits: 0, entries: [] }
}

function validDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function textWithin(value: unknown, max = MAX_SNAPSHOT_TEXT_CHARS): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

function sanitizeSnapshot(value: unknown): ReportResultCacheSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Partial<ReportResultCacheSnapshot>
  if (!textWithin(raw.cleanedData) || !textWithin(raw.reportMarkdown)) return null
  if (!Array.isArray(raw.cleanDetails) || raw.cleanDetails.length > 500) return null
  const cleanDetails = raw.cleanDetails.flatMap((detail) => {
    if (!detail || typeof detail !== 'object') return []
    const candidate = detail as { name?: unknown; text?: unknown }
    if (!textWithin(candidate.name, 500) || !textWithin(candidate.text, 2_000_000)) return []
    return [{ name: candidate.name, text: candidate.text }]
  })
  if (cleanDetails.length !== raw.cleanDetails.length) return null
  if (!raw.artifacts || typeof raw.artifacts !== 'object' || Array.isArray(raw.artifacts)) return null
  const artifacts: Record<number, string> = {}
  for (const [key, artifact] of Object.entries(raw.artifacts)) {
    const id = Number(key)
    if (!Number.isInteger(id) || id < 1 || id > 9 || !textWithin(artifact, 3_000_000)) return null
    artifacts[id] = artifact
  }
  if (!Object.keys(artifacts).length) return null
  return { cleanedData: raw.cleanedData, cleanDetails, artifacts, reportMarkdown: raw.reportMarkdown }
}

function parseCache(raw: string): StoredReportCache | null {
  try {
    const value = JSON.parse(raw) as Partial<StoredReportCache>
    if (value.version !== CACHE_VERSION || !Array.isArray(value.entries)) return null
    const entries: StoredReportEntry[] = []
    for (const entry of value.entries) {
      if (!entry || typeof entry !== 'object') continue
      const candidate = entry as Partial<StoredReportEntry>
      const snapshot = sanitizeSnapshot(candidate.snapshot)
      if (
        typeof candidate.key !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(candidate.key) ||
        typeof candidate.model !== 'string' ||
        candidate.model.length > 200 ||
        !validDate(candidate.createdAt) ||
        !validDate(candidate.lastUsedAt) ||
        !validDate(candidate.expiresAt) ||
        !snapshot
      ) continue
      entries.push({
        key: candidate.key,
        model: candidate.model,
        createdAt: candidate.createdAt,
        lastUsedAt: candidate.lastUsedAt,
        expiresAt: candidate.expiresAt,
        snapshot
      })
    }
    return {
      version: CACHE_VERSION,
      totalHits:
        typeof value.totalHits === 'number' && Number.isSafeInteger(value.totalHits) && value.totalHits >= 0
          ? value.totalHits
          : 0,
      entries
    }
  } catch {
    return null
  }
}

function readCache(): StoredReportCache {
  for (const path of [cacheFile(), backupFile()]) {
    try {
      if (!existsSync(path)) continue
      const parsed = parseCache(readFileSync(path, 'utf8'))
      if (parsed) return parsed
    } catch {
      // 完整报告缓存损坏时自动忽略，不影响正常生成。
    }
  }
  return emptyCache()
}

function expiresAtFrom(now: Date): string {
  return new Date(now.getTime() + CACHE_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()
}

function serializedBytes(cache: StoredReportCache): number {
  return Buffer.byteLength(JSON.stringify(cache), 'utf8')
}

function pruneCache(cache: StoredReportCache, now = new Date()): StoredReportCache {
  let entries = cache.entries
    .filter((entry) => Date.parse(entry.expiresAt) > now.getTime())
    .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))
    .slice(0, MAX_CACHE_ENTRIES)
  let next: StoredReportCache = { version: CACHE_VERSION, totalHits: cache.totalHits, entries }
  while (entries.length && serializedBytes(next) > MAX_CACHE_BYTES) {
    entries = entries.slice(0, -1)
    next = { version: CACHE_VERSION, totalHits: cache.totalHits, entries }
  }
  return next
}

function writeCache(cache: StoredReportCache): void {
  const path = cacheFile()
  const backup = backupFile()
  const temp = `${path}.tmp`
  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path)) {
    try {
      copyFileSync(path, backup)
    } catch {
      // 主文件仍会通过临时文件原子替换。
    }
  }
  writeFileSync(temp, JSON.stringify(cache), { encoding: 'utf8', mode: 0o600 })
  if (existsSync(path)) rmSync(path, { force: true })
  renameSync(temp, path)
}

function updateHash(hash: ReturnType<typeof createHash>, value: string): void {
  hash.update(String(Buffer.byteLength(value, 'utf8')))
  hash.update(':')
  hash.update(value)
  hash.update('|')
}

export function reportResultCacheKey(input: ReportResultCacheInput, model: string): string {
  if (!input || !Array.isArray(input.sources) || !input.sources.length) throw new Error('完整报告缓存缺少资料。')
  const hash = createHash('sha256')
  for (const version of [MODEL_RUNTIME_RULES_VERSION, REPORT_PROMPT_VERSION, REPORT_TEMPLATE_VERSION]) {
    updateHash(hash, version)
  }
  const cleanModel = String(model || '').trim().toLowerCase().slice(0, 200)
  updateHash(hash, cleanModel)
  updateHash(hash, String(input.userRequirements || ''))
  input.sources.forEach((source, index) => {
    updateHash(hash, String(index))
    // sourceCleanCacheKey 负责输入合法性和清洗规则版本；下列原值确保说明或内容任一字符变化都不会误命中。
    updateHash(hash, sourceCleanCacheKey(source, cleanModel))
    for (const value of [
      source.name,
      source.kind,
      source.attribution || '',
      source.platform || '',
      source.purpose || '',
      source.note || '',
      source.text || '',
      source.dataUrl || ''
    ]) updateHash(hash, String(value))
  })
  return hash.digest('hex')
}

function stats(cache: StoredReportCache): ReportResultCacheStats {
  const expiries = cache.entries.map((entry) => entry.expiresAt).sort()
  return {
    entryCount: cache.entries.length,
    totalHits: cache.totalHits,
    totalBytes: serializedBytes(cache),
    retentionDays: CACHE_RETENTION_DAYS,
    maxEntries: MAX_CACHE_ENTRIES,
    maxBytes: MAX_CACHE_BYTES,
    expiresNextAt: expiries[0]
  }
}

export function getReportResultCacheStats(): ReportResultCacheStats {
  return stats(pruneCache(readCache()))
}

export function lookupReportResultCache(
  input: ReportResultCacheInput,
  model: string
): ReportResultCacheLookupResult {
  const key = reportResultCacheKey(input, model)
  const now = new Date()
  const cache = pruneCache(readCache(), now)
  const entry = cache.entries.find((candidate) => candidate.key === key)
  if (!entry) return { hit: false, cacheKey: key, stats: stats(cache) }
  entry.lastUsedAt = now.toISOString()
  entry.expiresAt = expiresAtFrom(now)
  cache.totalHits++
  const next = pruneCache(cache, now)
  try {
    writeCache(next)
  } catch {
    // 命中结果仍然可用，最近使用时间更新失败不影响复用。
  }
  return {
    hit: true,
    cacheKey: key,
    createdAt: entry.createdAt,
    snapshot: entry.snapshot,
    stats: stats(next)
  }
}

export function storeReportResultCache(
  input: ReportResultCacheInput,
  model: string,
  snapshotValue: ReportResultCacheSnapshot
): ReportResultCacheStoreResult {
  const snapshot = sanitizeSnapshot(snapshotValue)
  const key = reportResultCacheKey(input, model)
  if (!snapshot) return { stored: false, cacheKey: key, stats: getReportResultCacheStats() }
  const now = new Date()
  const cache = pruneCache(readCache(), now)
  const existing = cache.entries.find((entry) => entry.key === key)
  if (existing) {
    existing.snapshot = snapshot
    existing.model = String(model || '').slice(0, 200)
    existing.lastUsedAt = now.toISOString()
    existing.expiresAt = expiresAtFrom(now)
  } else {
    cache.entries.push({
      key,
      model: String(model || '').slice(0, 200),
      createdAt: now.toISOString(),
      lastUsedAt: now.toISOString(),
      expiresAt: expiresAtFrom(now),
      snapshot
    })
  }
  const next = pruneCache(cache, now)
  const stored = next.entries.some((entry) => entry.key === key)
  if (stored) writeCache(next)
  return { stored, cacheKey: key, stats: stats(next) }
}

export function clearReportResultCache(): ReportResultCacheStats {
  for (const path of [cacheFile(), backupFile(), `${cacheFile()}.tmp`]) {
    try {
      rmSync(path, { force: true })
    } catch {
      // 下次仍会按过期和容量规则处理无法删除的残留。
    }
  }
  return stats(emptyCache())
}

export const reportResultCacheInternals = {
  CACHE_RETENTION_DAYS,
  MAX_CACHE_ENTRIES,
  MAX_CACHE_BYTES,
  pruneCache,
  resetForTests(): void {
    clearReportResultCache()
  }
}
