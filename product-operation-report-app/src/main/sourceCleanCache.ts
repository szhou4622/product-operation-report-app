import { app } from 'electron'
import { createHash } from 'crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import type {
  SourceCleanCacheInput,
  SourceCleanCacheLookupResult,
  SourceCleanCacheStats,
  SourceCleanCacheStoreResult
} from '../shared/types'
import { SOURCE_CLEAN_PROMPT_VERSION, TABLE_DIGEST_VERSION } from '../shared/reportVersions'

const LEGACY_CACHE_FILE_NAME = 'source-clean-cache.json'
const CACHE_DIRECTORY_NAME = 'source-clean-cache-v2'
const CACHE_VERSION = 2
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
  bytes: number
}

interface StoredCache {
  version: 2
  totalHits: number
  entries: StoredCacheEntry[]
}

interface LegacyCacheEntry extends Omit<StoredCacheEntry, 'bytes'> {
  text: string
}

const cacheDirectory = (): string => join(app.getPath('userData'), CACHE_DIRECTORY_NAME)
const indexFile = (): string => join(cacheDirectory(), 'index.json')
const entryFile = (key: string): string => join(cacheDirectory(), `${key}.txt`)
const legacyFile = (): string => join(app.getPath('userData'), LEGACY_CACHE_FILE_NAME)

function emptyCache(): StoredCache {
  return { version: CACHE_VERSION, totalHits: 0, entries: [] }
}

function validDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function parseIndex(raw: string): StoredCache | null {
  try {
    const value = JSON.parse(raw) as Partial<StoredCache>
    if (value.version !== CACHE_VERSION || !Array.isArray(value.entries)) return null
    const entries = value.entries.filter((entry): entry is StoredCacheEntry => {
      if (!entry || typeof entry !== 'object') return false
      const candidate = entry as Partial<StoredCacheEntry>
      return (
        typeof candidate.key === 'string' && /^[a-f0-9]{64}$/u.test(candidate.key) &&
        typeof candidate.model === 'string' && candidate.model.length <= 200 &&
        typeof candidate.bytes === 'number' && Number.isSafeInteger(candidate.bytes) && candidate.bytes >= 0 &&
        validDate(candidate.createdAt) && validDate(candidate.lastUsedAt) && validDate(candidate.expiresAt)
      )
    })
    return {
      version: CACHE_VERSION,
      totalHits: typeof value.totalHits === 'number' && Number.isSafeInteger(value.totalHits) && value.totalHits >= 0
        ? value.totalHits
        : 0,
      entries
    }
  } catch {
    return null
  }
}

function parseLegacy(raw: string): { totalHits: number; entries: LegacyCacheEntry[] } | null {
  try {
    const value = JSON.parse(raw) as { version?: unknown; totalHits?: unknown; entries?: unknown }
    if (value.version !== 1 || !Array.isArray(value.entries)) return null
    const entries = value.entries.filter((entry): entry is LegacyCacheEntry => {
      if (!entry || typeof entry !== 'object') return false
      const item = entry as Partial<LegacyCacheEntry>
      return typeof item.key === 'string' && /^[a-f0-9]{64}$/u.test(item.key) &&
        typeof item.model === 'string' && typeof item.text === 'string' && item.text.length <= MAX_CLEANED_TEXT_CHARS &&
        validDate(item.createdAt) && validDate(item.lastUsedAt) && validDate(item.expiresAt)
    })
    return {
      totalHits: typeof value.totalHits === 'number' && Number.isSafeInteger(value.totalHits) && value.totalHits >= 0
        ? value.totalHits
        : 0,
      entries
    }
  } catch {
    return null
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(cacheDirectory(), { recursive: true })
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`
  try {
    await writeFile(temp, content, { encoding: 'utf8', mode: 0o600 })
    await rename(temp, path)
  } finally {
    await rm(temp, { force: true }).catch(() => undefined)
  }
}

async function writeIndex(cache: StoredCache): Promise<void> {
  await atomicWrite(indexFile(), JSON.stringify(cache))
}

async function migrateLegacy(): Promise<StoredCache | null> {
  try {
    const parsed = parseLegacy(await readFile(legacyFile(), 'utf8'))
    if (!parsed) return null
    const entries: StoredCacheEntry[] = []
    for (const item of parsed.entries) {
      const text = item.text.trim()
      if (!text) continue
      const bytes = Buffer.byteLength(text, 'utf8')
      await atomicWrite(entryFile(item.key), text)
      entries.push({
        key: item.key,
        model: item.model,
        createdAt: item.createdAt,
        lastUsedAt: item.lastUsedAt,
        expiresAt: item.expiresAt,
        bytes
      })
    }
    const cache: StoredCache = { version: CACHE_VERSION, totalHits: parsed.totalHits, entries }
    await writeIndex(cache)
    await rm(legacyFile(), { force: true })
    await rm(`${legacyFile()}.bak`, { force: true })
    return cache
  } catch {
    return null
  }
}

async function readCache(): Promise<StoredCache> {
  try {
    const parsed = parseIndex(await readFile(indexFile(), 'utf8'))
    if (parsed) return parsed
  } catch {
    // 索引缺失或损坏时继续尝试一次旧版迁移。
  }
  return (await migrateLegacy()) || emptyCache()
}

function expiresAtFrom(now: Date): string {
  return new Date(now.getTime() + CACHE_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()
}

function indexBytes(cache: StoredCache): number {
  return Buffer.byteLength(JSON.stringify(cache), 'utf8')
}

function totalBytes(cache: StoredCache): number {
  return indexBytes(cache) + cache.entries.reduce((sum, entry) => sum + entry.bytes, 0)
}

function pruneCache(cache: StoredCache, now = new Date()): StoredCache {
  let entries = cache.entries
    .filter((entry) => Date.parse(entry.expiresAt) > now.getTime())
    .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))
    .slice(0, MAX_CACHE_ENTRIES)
  let next: StoredCache = { version: CACHE_VERSION, totalHits: cache.totalHits, entries }
  while (entries.length && totalBytes(next) > MAX_CACHE_BYTES) {
    entries = entries.slice(0, -1)
    next = { version: CACHE_VERSION, totalHits: cache.totalHits, entries }
  }
  return next
}

async function removePrunedFiles(before: StoredCache, after: StoredCache): Promise<void> {
  const keep = new Set(after.entries.map((entry) => entry.key))
  await Promise.all(before.entries.filter((entry) => !keep.has(entry.key)).map((entry) =>
    rm(entryFile(entry.key), { force: true }).catch(() => undefined)
  ))
}

function safeString(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function validateInput(input: SourceCleanCacheInput): SourceCleanCacheInput {
  if (!input || typeof input !== 'object') throw new Error('清洗缓存输入无效。')
  if (!['image', 'doc', 'table', 'other'].includes(input.kind)) throw new Error('清洗缓存文件类型无效。')
  const text = safeString(input.text, 60_000_000)
  const dataUrl = safeString(input.dataUrl, 40_000_000)
  const attachments = Array.isArray(input.attachments)
    ? input.attachments.slice(0, 100).flatMap((item) => {
        if (!item || typeof item !== 'object') return []
        const attachmentDataUrl = safeString(item.dataUrl, 40_000_000)
        if (!attachmentDataUrl) return []
        return [{ name: safeString(item.name, 500), size: Number.isFinite(item.size) ? item.size : undefined, dataUrl: attachmentDataUrl }]
      })
    : []
  if (!text && !dataUrl && !attachments.length) throw new Error('清洗缓存缺少文件内容。')
  return {
    name: safeString(input.name, 500), kind: input.kind, text, dataUrl, attachments,
    attribution: safeString(input.attribution, 100), platform: safeString(input.platform, 200),
    purpose: safeString(input.purpose, 200), kindV1: input.kindV1, note: safeString(input.note, 4_000)
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
    SOURCE_CLEAN_PROMPT_VERSION, TABLE_DIGEST_VERSION, safeString(model, 200).trim().toLowerCase(),
    clean.name, clean.kind, clean.attribution || '', clean.platform || '', clean.purpose || '', clean.kindV1 || '', clean.note || '',
    clean.text || '', clean.dataUrl || ''
  ]) updateHash(hash, value)
  for (const attachment of clean.attachments || []) {
    updateHash(hash, attachment.name)
    updateHash(hash, attachment.dataUrl || '')
  }
  return hash.digest('hex')
}

function cacheStats(cache: StoredCache): SourceCleanCacheStats {
  const orderedExpiry = cache.entries.map((entry) => entry.expiresAt).sort()
  return {
    entryCount: cache.entries.length,
    totalHits: cache.totalHits,
    totalBytes: totalBytes(cache),
    retentionDays: CACHE_RETENTION_DAYS,
    maxEntries: MAX_CACHE_ENTRIES,
    maxBytes: MAX_CACHE_BYTES,
    expiresNextAt: orderedExpiry[0]
  }
}

let operationQueue: Promise<void> = Promise.resolve()
function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const result = operationQueue.then(operation, operation)
  operationQueue = result.then(() => undefined, () => undefined)
  return result
}

export function getSourceCleanCacheStats(): Promise<SourceCleanCacheStats> {
  return serialized(async () => cacheStats(pruneCache(await readCache())))
}

export function lookupSourceCleanCache(input: SourceCleanCacheInput, model: string): Promise<SourceCleanCacheLookupResult> {
  return serialized(async () => {
    const key = sourceCleanCacheKey(input, model)
    const now = new Date()
    const original = await readCache()
    const cache = pruneCache(original, now)
    const entry = cache.entries.find((candidate) => candidate.key === key)
    if (!entry) {
      await removePrunedFiles(original, cache)
      if (cache.entries.length !== original.entries.length) await writeIndex(cache)
      return { hit: false, cacheKey: key, stats: cacheStats(cache) }
    }
    try {
      const info = await stat(entryFile(key))
      if (info.size !== entry.bytes) throw new Error('size mismatch')
      const text = await readFile(entryFile(key), 'utf8')
      if (!text.trim() || text.length > MAX_CLEANED_TEXT_CHARS) throw new Error('invalid cache entry')
      entry.lastUsedAt = now.toISOString()
      entry.expiresAt = expiresAtFrom(now)
      cache.totalHits++
      await writeIndex(cache)
      return { hit: true, cacheKey: key, text, stats: cacheStats(cache) }
    } catch {
      const next = { ...cache, entries: cache.entries.filter((candidate) => candidate.key !== key) }
      await rm(entryFile(key), { force: true }).catch(() => undefined)
      await writeIndex(next)
      return { hit: false, cacheKey: key, stats: cacheStats(next) }
    }
  })
}

export function storeSourceCleanCache(
  input: SourceCleanCacheInput,
  model: string,
  text: string
): Promise<SourceCleanCacheStoreResult> {
  return serialized(async () => {
    const cleanText = safeString(text, MAX_CLEANED_TEXT_CHARS).trim()
    const key = sourceCleanCacheKey(input, model)
    if (!cleanText) return { stored: false, cacheKey: key, stats: cacheStats(pruneCache(await readCache())) }
    const now = new Date()
    const original = await readCache()
    const cache = pruneCache(original, now)
    const bytes = Buffer.byteLength(cleanText, 'utf8')
    const current = cache.entries.find((entry) => entry.key === key)
    if (current) {
      Object.assign(current, { bytes, model: safeString(model, 200), lastUsedAt: now.toISOString(), expiresAt: expiresAtFrom(now) })
    } else {
      cache.entries.push({
        key, bytes, createdAt: now.toISOString(), lastUsedAt: now.toISOString(),
        expiresAt: expiresAtFrom(now), model: safeString(model, 200)
      })
    }
    await atomicWrite(entryFile(key), cleanText)
    const next = pruneCache(cache, now)
    await removePrunedFiles(original, next)
    if (!next.entries.some((entry) => entry.key === key)) {
      await rm(entryFile(key), { force: true }).catch(() => undefined)
    }
    await writeIndex(next)
    return { stored: next.entries.some((entry) => entry.key === key), cacheKey: key, stats: cacheStats(next) }
  })
}

export function clearSourceCleanCache(): Promise<SourceCleanCacheStats> {
  return serialized(async () => {
    await rm(cacheDirectory(), { recursive: true, force: true }).catch(() => undefined)
    await rm(legacyFile(), { force: true }).catch(() => undefined)
    await rm(`${legacyFile()}.bak`, { force: true }).catch(() => undefined)
    return cacheStats(emptyCache())
  })
}

export const sourceCleanCacheInternals = {
  CACHE_RETENTION_DAYS,
  MAX_CACHE_ENTRIES,
  MAX_CACHE_BYTES,
  SOURCE_CLEAN_PROMPT_VERSION,
  TABLE_DIGEST_VERSION,
  pruneCache,
  resetForTests(): Promise<SourceCleanCacheStats> {
    return clearSourceCleanCache()
  }
}
