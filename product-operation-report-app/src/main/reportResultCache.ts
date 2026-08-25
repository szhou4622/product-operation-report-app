import { app } from 'electron'
import { createHash } from 'crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import type {
  ReportResultCacheInput,
  ReportResultCacheLookupResult,
  ReportResultCacheSnapshot,
  ReportResultCacheStats,
  ReportResultCacheStoreResult
} from '../shared/types'
import {
  MODEL_RUNTIME_RULES_VERSION,
  REPORT_PROMPT_VERSION,
  REPORT_TEMPLATE_VERSION,
  SOURCE_CLEAN_PROMPT_VERSION,
  TABLE_DIGEST_VERSION
} from '../shared/reportVersions'
import { sourceCleanCacheKey } from './sourceCleanCache'

const LEGACY_CACHE_FILE_NAME = 'report-result-cache.json'
const CACHE_DIRECTORY_NAME = 'report-result-cache-v2'
const CACHE_VERSION = 2
const CACHE_RETENTION_DAYS = 30
const MAX_CACHE_ENTRIES = 20
const MAX_CACHE_BYTES = 100 * 1024 * 1024
const MAX_SNAPSHOT_TEXT_CHARS = 8_000_000

interface StoredReportEntry {
  key: string
  createdAt: string
  lastUsedAt: string
  expiresAt: string
  model: string
  bytes: number
}

interface StoredReportCache {
  version: 2
  totalHits: number
  entries: StoredReportEntry[]
}

interface LegacyReportEntry extends Omit<StoredReportEntry, 'bytes'> {
  snapshot: ReportResultCacheSnapshot
}

const cacheDirectory = (): string => join(app.getPath('userData'), CACHE_DIRECTORY_NAME)
const indexFile = (): string => join(cacheDirectory(), 'index.json')
const entryFile = (key: string): string => join(cacheDirectory(), `${key}.json`)
const legacyFile = (): string => join(app.getPath('userData'), LEGACY_CACHE_FILE_NAME)

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

function parseIndex(raw: string): StoredReportCache | null {
  try {
    const value = JSON.parse(raw) as Partial<StoredReportCache>
    if (value.version !== CACHE_VERSION || !Array.isArray(value.entries)) return null
    const entries = value.entries.filter((entry): entry is StoredReportEntry => {
      if (!entry || typeof entry !== 'object') return false
      const item = entry as Partial<StoredReportEntry>
      return typeof item.key === 'string' && /^[a-f0-9]{64}$/u.test(item.key) &&
        typeof item.model === 'string' && item.model.length <= 200 &&
        typeof item.bytes === 'number' && Number.isSafeInteger(item.bytes) && item.bytes >= 0 &&
        validDate(item.createdAt) && validDate(item.lastUsedAt) && validDate(item.expiresAt)
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

function parseLegacy(raw: string): { totalHits: number; entries: LegacyReportEntry[] } | null {
  try {
    const value = JSON.parse(raw) as { version?: unknown; totalHits?: unknown; entries?: unknown }
    if (value.version !== 1 || !Array.isArray(value.entries)) return null
    const entries: LegacyReportEntry[] = []
    for (const rawEntry of value.entries) {
      if (!rawEntry || typeof rawEntry !== 'object') continue
      const item = rawEntry as Partial<LegacyReportEntry>
      const snapshot = sanitizeSnapshot(item.snapshot)
      if (typeof item.key !== 'string' || !/^[a-f0-9]{64}$/u.test(item.key) ||
        typeof item.model !== 'string' || !validDate(item.createdAt) || !validDate(item.lastUsedAt) ||
        !validDate(item.expiresAt) || !snapshot) continue
      entries.push({
        key: item.key,
        model: item.model,
        createdAt: item.createdAt,
        lastUsedAt: item.lastUsedAt,
        expiresAt: item.expiresAt,
        snapshot
      })
    }
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

async function writeIndex(cache: StoredReportCache): Promise<void> {
  await atomicWrite(indexFile(), JSON.stringify(cache))
}

async function migrateLegacy(): Promise<StoredReportCache | null> {
  try {
    const parsed = parseLegacy(await readFile(legacyFile(), 'utf8'))
    if (!parsed) return null
    const entries: StoredReportEntry[] = []
    for (const item of parsed.entries) {
      const content = JSON.stringify(item.snapshot)
      const bytes = Buffer.byteLength(content, 'utf8')
      await atomicWrite(entryFile(item.key), content)
      entries.push({
        key: item.key, model: item.model, createdAt: item.createdAt,
        lastUsedAt: item.lastUsedAt, expiresAt: item.expiresAt, bytes
      })
    }
    const cache: StoredReportCache = { version: CACHE_VERSION, totalHits: parsed.totalHits, entries }
    await writeIndex(cache)
    await rm(legacyFile(), { force: true })
    await rm(`${legacyFile()}.bak`, { force: true })
    return cache
  } catch {
    return null
  }
}

async function readCache(): Promise<StoredReportCache> {
  try {
    const parsed = parseIndex(await readFile(indexFile(), 'utf8'))
    if (parsed) return parsed
  } catch {
    // 索引损坏时自动忽略，必要时迁移旧缓存。
  }
  return (await migrateLegacy()) || emptyCache()
}

function expiresAtFrom(now: Date): string {
  return new Date(now.getTime() + CACHE_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()
}

function totalBytes(cache: StoredReportCache): number {
  return Buffer.byteLength(JSON.stringify(cache), 'utf8') + cache.entries.reduce((sum, entry) => sum + entry.bytes, 0)
}

function pruneCache(cache: StoredReportCache, now = new Date()): StoredReportCache {
  let entries = cache.entries
    .filter((entry) => Date.parse(entry.expiresAt) > now.getTime())
    .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))
    .slice(0, MAX_CACHE_ENTRIES)
  let next: StoredReportCache = { version: CACHE_VERSION, totalHits: cache.totalHits, entries }
  while (entries.length && totalBytes(next) > MAX_CACHE_BYTES) {
    entries = entries.slice(0, -1)
    next = { version: CACHE_VERSION, totalHits: cache.totalHits, entries }
  }
  return next
}

async function removePrunedFiles(before: StoredReportCache, after: StoredReportCache): Promise<void> {
  const keep = new Set(after.entries.map((entry) => entry.key))
  await Promise.all(before.entries.filter((entry) => !keep.has(entry.key)).map((entry) =>
    rm(entryFile(entry.key), { force: true }).catch(() => undefined)
  ))
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
  updateHash(hash, input.engineVersion || 'v1')
  for (const version of [
    MODEL_RUNTIME_RULES_VERSION, REPORT_PROMPT_VERSION, REPORT_TEMPLATE_VERSION,
    SOURCE_CLEAN_PROMPT_VERSION, TABLE_DIGEST_VERSION
  ]) updateHash(hash, version)
  const cleanModel = String(model || '').trim().toLowerCase().slice(0, 200)
  updateHash(hash, cleanModel)
  updateHash(hash, String(input.userRequirements || ''))
  input.sources.forEach((source, index) => {
    updateHash(hash, String(index))
    updateHash(hash, sourceCleanCacheKey(source, cleanModel))
    for (const value of [
      source.name, source.kind, source.attribution || '', source.platform || '', source.purpose || '',
      source.note || '', source.text || '', source.dataUrl || ''
    ]) updateHash(hash, String(value))
  })
  return hash.digest('hex')
}

function stats(cache: StoredReportCache): ReportResultCacheStats {
  const expiries = cache.entries.map((entry) => entry.expiresAt).sort()
  return {
    entryCount: cache.entries.length,
    totalHits: cache.totalHits,
    totalBytes: totalBytes(cache),
    retentionDays: CACHE_RETENTION_DAYS,
    maxEntries: MAX_CACHE_ENTRIES,
    maxBytes: MAX_CACHE_BYTES,
    expiresNextAt: expiries[0]
  }
}

let operationQueue: Promise<void> = Promise.resolve()
function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const result = operationQueue.then(operation, operation)
  operationQueue = result.then(() => undefined, () => undefined)
  return result
}

export function getReportResultCacheStats(): Promise<ReportResultCacheStats> {
  return serialized(async () => stats(pruneCache(await readCache())))
}

export function lookupReportResultCache(input: ReportResultCacheInput, model: string): Promise<ReportResultCacheLookupResult> {
  return serialized(async () => {
    const key = reportResultCacheKey(input, model)
    const now = new Date()
    const original = await readCache()
    const cache = pruneCache(original, now)
    const entry = cache.entries.find((candidate) => candidate.key === key)
    if (!entry) {
      await removePrunedFiles(original, cache)
      if (cache.entries.length !== original.entries.length) await writeIndex(cache)
      return { hit: false, cacheKey: key, stats: stats(cache) }
    }
    try {
      const info = await stat(entryFile(key))
      if (info.size !== entry.bytes) throw new Error('size mismatch')
      const snapshot = sanitizeSnapshot(JSON.parse(await readFile(entryFile(key), 'utf8')) as unknown)
      if (!snapshot) throw new Error('invalid snapshot')
      entry.lastUsedAt = now.toISOString()
      entry.expiresAt = expiresAtFrom(now)
      cache.totalHits++
      await writeIndex(cache)
      return { hit: true, cacheKey: key, createdAt: entry.createdAt, snapshot, stats: stats(cache) }
    } catch {
      const next = { ...cache, entries: cache.entries.filter((candidate) => candidate.key !== key) }
      await rm(entryFile(key), { force: true }).catch(() => undefined)
      await writeIndex(next)
      return { hit: false, cacheKey: key, stats: stats(next) }
    }
  })
}

export function storeReportResultCache(
  input: ReportResultCacheInput,
  model: string,
  snapshotValue: ReportResultCacheSnapshot
): Promise<ReportResultCacheStoreResult> {
  return serialized(async () => {
    const snapshot = sanitizeSnapshot(snapshotValue)
    const key = reportResultCacheKey(input, model)
    if (!snapshot) return { stored: false, cacheKey: key, stats: stats(pruneCache(await readCache())) }
    const now = new Date()
    const original = await readCache()
    const cache = pruneCache(original, now)
    const content = JSON.stringify(snapshot)
    const bytes = Buffer.byteLength(content, 'utf8')
    const existing = cache.entries.find((entry) => entry.key === key)
    if (existing) {
      Object.assign(existing, {
        bytes, model: String(model || '').slice(0, 200),
        lastUsedAt: now.toISOString(), expiresAt: expiresAtFrom(now)
      })
    } else {
      cache.entries.push({
        key, bytes, model: String(model || '').slice(0, 200), createdAt: now.toISOString(),
        lastUsedAt: now.toISOString(), expiresAt: expiresAtFrom(now)
      })
    }
    await atomicWrite(entryFile(key), content)
    const next = pruneCache(cache, now)
    await removePrunedFiles(original, next)
    if (!next.entries.some((entry) => entry.key === key)) {
      await rm(entryFile(key), { force: true }).catch(() => undefined)
    }
    await writeIndex(next)
    return { stored: next.entries.some((entry) => entry.key === key), cacheKey: key, stats: stats(next) }
  })
}

export function clearReportResultCache(): Promise<ReportResultCacheStats> {
  return serialized(async () => {
    await rm(cacheDirectory(), { recursive: true, force: true }).catch(() => undefined)
    await rm(legacyFile(), { force: true }).catch(() => undefined)
    await rm(`${legacyFile()}.bak`, { force: true }).catch(() => undefined)
    return stats(emptyCache())
  })
}

export const reportResultCacheInternals = {
  CACHE_RETENTION_DAYS,
  MAX_CACHE_ENTRIES,
  MAX_CACHE_BYTES,
  pruneCache,
  resetForTests(): Promise<ReportResultCacheStats> {
    return clearReportResultCache()
  }
}
