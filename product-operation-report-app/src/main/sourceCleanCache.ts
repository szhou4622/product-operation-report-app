import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import { dirname, join } from 'path'
import type {
  SourceCleanCacheInput,
  SourceCleanCacheLookupResult,
  SourceCleanCacheStats,
  SourceCleanCacheStoreResult
} from '../shared/types'
import { SOURCE_CLEAN_PROMPT_VERSION, TABLE_DIGEST_VERSION } from '../shared/reportVersions'

const CACHE_FILE_NAME = 'source-clean-cache.json'
const CACHE_VERSION = 1
const CACHE_RETENTION_DAYS = 30
const MAX_CACHE_ENTRIES = 200
const MAX_CACHE_BYTES = 50 * 1024 * 1024
const MAX_CLEANED_TEXT_CHARS = 2_000_000

interface StoredCacheEntry {
  key: string
  createdAt: string
  lastUsedAt: string
  expiresAt: string
  model: string
  text: string
}

interface StoredCache {
  version: 1
  totalHits: number
  entries: StoredCacheEntry[]
}

const CACHE_FILE = (): string => join(app.getPath('userData'), CACHE_FILE_NAME)
const CACHE_BACKUP_FILE = (): string => `${CACHE_FILE()}.bak`

function emptyCache(): StoredCache {
  return { version: CACHE_VERSION, totalHits: 0, entries: [] }
}

function validDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function parseCache(raw: string): StoredCache | null {
  try {
    const value = JSON.parse(raw) as Partial<StoredCache>
    if (value.version !== CACHE_VERSION || !Array.isArray(value.entries)) return null
    const entries = value.entries.filter((entry): entry is StoredCacheEntry => {
      if (!entry || typeof entry !== 'object') return false
      const candidate = entry as Partial<StoredCacheEntry>
      return (
        typeof candidate.key === 'string' &&
        /^[a-f0-9]{64}$/u.test(candidate.key) &&
        typeof candidate.model === 'string' &&
        candidate.model.length <= 200 &&
        typeof candidate.text === 'string' &&
        candidate.text.length <= MAX_CLEANED_TEXT_CHARS &&
        validDate(candidate.createdAt) &&
        validDate(candidate.lastUsedAt) &&
        validDate(candidate.expiresAt)
      )
    })
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

function readCache(): StoredCache {
  for (const path of [CACHE_FILE(), CACHE_BACKUP_FILE()]) {
    try {
      if (!existsSync(path)) continue
      const parsed = parseCache(readFileSync(path, 'utf8'))
      if (parsed) return parsed
    } catch {
      // 缓存不是项目数据；损坏时忽略并继续尝试备份。
    }
  }
  return emptyCache()
}

function expiresAtFrom(now: Date): string {
  return new Date(now.getTime() + CACHE_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()
}

function serializedBytes(cache: StoredCache): number {
  return Buffer.byteLength(JSON.stringify(cache), 'utf8')
}

function pruneCache(cache: StoredCache, now = new Date()): StoredCache {
  const nowMs = now.getTime()
  let entries = cache.entries
    .filter((entry) => Date.parse(entry.expiresAt) > nowMs)
    .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))
    .slice(0, MAX_CACHE_ENTRIES)
  let next: StoredCache = { version: CACHE_VERSION, totalHits: cache.totalHits, entries }
  while (entries.length && serializedBytes(next) > MAX_CACHE_BYTES) {
    entries = entries.slice(0, -1)
    next = { version: CACHE_VERSION, totalHits: cache.totalHits, entries }
  }
  return next
}

function writeCache(cache: StoredCache): void {
  const path = CACHE_FILE()
  const backup = CACHE_BACKUP_FILE()
  const temp = `${path}.tmp`
  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path)) {
    try {
      copyFileSync(path, backup)
    } catch {
      // 备份失败不应阻止使用缓存；主文件仍通过临时文件原子替换。
    }
  }
  writeFileSync(temp, JSON.stringify(cache), { encoding: 'utf8', mode: 0o600 })
  if (existsSync(path)) rmSync(path, { force: true })
  renameSync(temp, path)
}

function safeString(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function validateInput(input: SourceCleanCacheInput): SourceCleanCacheInput {
  if (!input || typeof input !== 'object') throw new Error('清洗缓存输入无效。')
  if (!['image', 'doc', 'table', 'other'].includes(input.kind)) throw new Error('清洗缓存文件类型无效。')
  const text = safeString(input.text, 60_000_000)
  const dataUrl = safeString(input.dataUrl, 40_000_000)
  if (!text && !dataUrl) throw new Error('清洗缓存缺少文件内容。')
  return {
    name: safeString(input.name, 500),
    kind: input.kind,
    text,
    dataUrl,
    attribution: safeString(input.attribution, 100),
    platform: safeString(input.platform, 200),
    purpose: safeString(input.purpose, 200),
    note: safeString(input.note, 4_000)
  }
}

function updateHash(hash: ReturnType<typeof createHash>, value: string): void {
  hash.update(String(Buffer.byteLength(value, 'utf8')))
  hash.update(':')
  hash.update(value)
  hash.update('|')
}

export function sourceCleanCacheKey(input: SourceCleanCacheInput, model: string): string {
  const clean = validateInput(input)
  const hash = createHash('sha256')
  for (const value of [
    SOURCE_CLEAN_PROMPT_VERSION,
    TABLE_DIGEST_VERSION,
    safeString(model, 200).trim().toLowerCase(),
    clean.name,
    clean.kind,
    clean.attribution || '',
    clean.platform || '',
    clean.purpose || '',
    clean.note || '',
    clean.text || '',
    clean.dataUrl || ''
  ]) updateHash(hash, value)
  return hash.digest('hex')
}

function cacheStats(cache: StoredCache): SourceCleanCacheStats {
  const orderedExpiry = cache.entries.map((entry) => entry.expiresAt).sort()
  return {
    entryCount: cache.entries.length,
    totalHits: cache.totalHits,
    totalBytes: serializedBytes(cache),
    retentionDays: CACHE_RETENTION_DAYS,
    maxEntries: MAX_CACHE_ENTRIES,
    maxBytes: MAX_CACHE_BYTES,
    expiresNextAt: orderedExpiry[0]
  }
}

export function getSourceCleanCacheStats(): SourceCleanCacheStats {
  const cache = pruneCache(readCache())
  return cacheStats(cache)
}

export function lookupSourceCleanCache(
  input: SourceCleanCacheInput,
  model: string
): SourceCleanCacheLookupResult {
  const key = sourceCleanCacheKey(input, model)
  const now = new Date()
  const cache = pruneCache(readCache(), now)
  const entry = cache.entries.find((candidate) => candidate.key === key)
  if (!entry) {
    return { hit: false, cacheKey: key, stats: cacheStats(cache) }
  }
  entry.lastUsedAt = now.toISOString()
  entry.expiresAt = expiresAtFrom(now)
  cache.totalHits++
  const next = pruneCache(cache, now)
  try {
    writeCache(next)
  } catch {
    // 命中结果仍可使用；更新最近使用时间失败不影响报告生成。
  }
  return { hit: true, cacheKey: key, text: entry.text, stats: cacheStats(next) }
}

export function storeSourceCleanCache(
  input: SourceCleanCacheInput,
  model: string,
  text: string
): SourceCleanCacheStoreResult {
  const cleanText = safeString(text, MAX_CLEANED_TEXT_CHARS).trim()
  const key = sourceCleanCacheKey(input, model)
  if (!cleanText) return { stored: false, cacheKey: key, stats: getSourceCleanCacheStats() }
  const now = new Date()
  const cache = pruneCache(readCache(), now)
  const current = cache.entries.find((entry) => entry.key === key)
  if (current) {
    current.text = cleanText
    current.model = safeString(model, 200)
    current.lastUsedAt = now.toISOString()
    current.expiresAt = expiresAtFrom(now)
  } else {
    cache.entries.push({
      key,
      createdAt: now.toISOString(),
      lastUsedAt: now.toISOString(),
      expiresAt: expiresAtFrom(now),
      model: safeString(model, 200),
      text: cleanText
    })
  }
  const next = pruneCache(cache, now)
  const stored = next.entries.some((entry) => entry.key === key)
  if (stored) writeCache(next)
  return { stored, cacheKey: key, stats: cacheStats(next) }
}

export function clearSourceCleanCache(): SourceCleanCacheStats {
  for (const path of [CACHE_FILE(), CACHE_BACKUP_FILE(), `${CACHE_FILE()}.tmp`]) {
    try {
      rmSync(path, { force: true })
    } catch {
      // 清理入口应尽可能完成；残留文件下次会按过期策略处理。
    }
  }
  return cacheStats(emptyCache())
}

export const sourceCleanCacheInternals = {
  CACHE_RETENTION_DAYS,
  MAX_CACHE_ENTRIES,
  MAX_CACHE_BYTES,
  SOURCE_CLEAN_PROMPT_VERSION,
  TABLE_DIGEST_VERSION,
  pruneCache,
  resetForTests(): void {
    clearSourceCleanCache()
  }
}
