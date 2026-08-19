import { app } from 'electron'
import { createHash } from 'crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import type { ContactDisplayState } from '../shared/types'
import { CONTACT_CONFIG_URL, LICENSE_APP_NAME } from './serviceConfig'
import { parseRemoteContactConfig, validateContactImage, type ContactImageMime } from './contactConfig'

const CACHE_SCHEMA_VERSION = 1
const MAX_CONFIG_BYTES = 32 * 1024
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const CONTACT_TIMEOUT_MS = 10_000
const MAX_REDIRECTS = 3

interface CachedContactConfig {
  schemaVersion: 1
  appName: string
  configured: boolean
  enabled: boolean
  updatedAt?: string
  imageMime?: ContactImageMime
  imageSha256?: string
  cachedAt: string
}

let refreshInFlight: Promise<ContactDisplayState> | null = null

function cacheDirectory(): string {
  return join(app.getPath('userData'), 'contact-cache', LICENSE_APP_NAME)
}

function configPath(): string {
  return join(cacheDirectory(), 'contact-config.json')
}

function imagePath(): string {
  return join(cacheDirectory(), 'contact-image.bin')
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function bundledState(message = '联系方式图片暂未配置'): ContactDisplayState {
  return { enabled: true, configured: false, source: 'bundled', message }
}

function stateFromCache(config: CachedContactConfig, bytes?: Uint8Array, source: 'cache' | 'remote' = 'cache'): ContactDisplayState {
  if (!config.enabled) {
    return {
      enabled: false,
      configured: true,
      updatedAt: config.updatedAt,
      source,
      message: '联系方式暂未开放'
    }
  }
  if (bytes?.length && config.imageMime) {
    return {
      enabled: true,
      configured: true,
      imageDataUrl: `data:${config.imageMime};base64,${Buffer.from(bytes).toString('base64')}`,
      updatedAt: config.updatedAt,
      source,
      message: source === 'remote' ? '联系图片已更新' : '当前使用已缓存的联系图片'
    }
  }
  return {
    enabled: true,
    configured: config.configured,
    updatedAt: config.updatedAt,
    source,
    message: '联系方式图片暂未配置'
  }
}

function parseCachedConfig(): CachedContactConfig | null {
  const path = configPath()
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path)
    if (!raw.length || raw.length > MAX_CONFIG_BYTES) return null
    const value = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
    if (
      value.schemaVersion !== CACHE_SCHEMA_VERSION || value.appName !== LICENSE_APP_NAME ||
      typeof value.configured !== 'boolean' || typeof value.enabled !== 'boolean' ||
      typeof value.cachedAt !== 'string'
    ) return null
    const updatedAt = typeof value.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt))
      ? value.updatedAt
      : undefined
    const imageMime = value.imageMime === 'image/png' || value.imageMime === 'image/jpeg' || value.imageMime === 'image/webp'
      ? value.imageMime
      : undefined
    const imageSha256 = typeof value.imageSha256 === 'string' && /^[a-f0-9]{64}$/u.test(value.imageSha256)
      ? value.imageSha256
      : undefined
    return {
      schemaVersion: 1,
      appName: LICENSE_APP_NAME,
      configured: value.configured,
      enabled: value.enabled,
      ...(updatedAt ? { updatedAt } : {}),
      ...(imageMime ? { imageMime } : {}),
      ...(imageSha256 ? { imageSha256 } : {}),
      cachedAt: value.cachedAt
    }
  } catch {
    return null
  }
}

function readCachedImage(config: CachedContactConfig): Uint8Array | undefined {
  if (!config.enabled || !config.imageMime || !config.imageSha256 || !existsSync(imagePath())) return undefined
  try {
    const bytes = readFileSync(imagePath())
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || sha256(bytes) !== config.imageSha256) return undefined
    if (validateContactImage(config.imageMime, bytes) !== config.imageMime) return undefined
    return bytes
  } catch {
    return undefined
  }
}

export function getCachedContactState(): ContactDisplayState {
  const config = parseCachedConfig()
  if (!config) return bundledState()
  const bytes = readCachedImage(config)
  if (config.enabled && config.imageMime && !bytes) return bundledState('联系方式图片暂时不可用，当前使用内置图片')
  return stateFromCache(config, bytes)
}

function atomicWrite(path: string, bytes: Uint8Array): void {
  const temp = `${path}.tmp`
  try {
    writeFileSync(temp, bytes, { mode: 0o600 })
    renameSync(temp, path)
  } finally {
    rmSync(temp, { force: true })
  }
}

function writeCache(config: CachedContactConfig, image?: Uint8Array): void {
  mkdirSync(cacheDirectory(), { recursive: true })
  if (image?.length) atomicWrite(imagePath(), image)
  atomicWrite(configPath(), Buffer.from(JSON.stringify(config, null, 2), 'utf8'))
  if (!image?.length) rmSync(imagePath(), { force: true })
}

async function fetchHttps(url: string, redirects = 0): Promise<Response> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('联系配置地址无效。')
  }
  if (parsed.protocol !== 'https:') throw new Error('联系配置只允许 HTTPS。')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CONTACT_TIMEOUT_MS)
  try {
    const response = await fetch(parsed, {
      method: 'GET',
      headers: { accept: 'application/json, image/png, image/jpeg, image/webp' },
      cache: 'no-store',
      redirect: 'manual',
      signal: controller.signal
    })
    if (response.status >= 300 && response.status < 400) {
      if (redirects >= MAX_REDIRECTS) throw new Error('联系方式图片重定向次数过多。')
      const location = response.headers.get('location')
      if (!location) throw new Error('联系方式图片重定向地址缺失。')
      const next = new URL(location, parsed)
      if (next.protocol !== 'https:') throw new Error('联系方式图片重定向必须使用 HTTPS。')
      return fetchHttps(next.toString(), redirects + 1)
    }
    return response
  } finally {
    clearTimeout(timer)
  }
}

async function readLimitedBytes(response: Response, limit: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) throw new Error('联系方式图片超过5MB限制。')
  if (!response.body) throw new Error('联系方式图片没有返回内容。')
  const reader = response.body.getReader()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    void reader.cancel().catch(() => undefined)
  }, CONTACT_TIMEOUT_MS)
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const result = await reader.read()
      if (timedOut) throw new Error('获取联系方式图片超时。')
      if (result.done) break
      total += result.value.length
      if (total > limit) {
        await reader.cancel().catch(() => undefined)
        throw new Error('联系方式图片超过5MB限制。')
      }
      chunks.push(result.value)
    }
  } finally {
    clearTimeout(timer)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes
}

async function validateDecodableImage(bytes: Uint8Array, expectedMime: ContactImageMime): Promise<void> {
  const sharp = (await import('sharp')).default
  const metadata = await sharp(bytes, { limitInputPixels: 25_000_000 }).metadata()
  const actualMime = metadata.format === 'jpeg' ? 'image/jpeg' : `image/${metadata.format || ''}`
  if (!metadata.width || !metadata.height || actualMime !== expectedMime) {
    throw new Error('联系方式图片无法正常解码。')
  }
}

async function performRefresh(): Promise<ContactDisplayState> {
  const configUrl = new URL(CONTACT_CONFIG_URL)
  configUrl.searchParams.set('app_name', LICENSE_APP_NAME)
  const response = await fetchHttps(configUrl.toString())
  if (response.status === 404) {
    const cached: CachedContactConfig = {
      schemaVersion: 1,
      appName: LICENSE_APP_NAME,
      configured: false,
      enabled: true,
      cachedAt: new Date().toISOString()
    }
    writeCache(cached)
    return stateFromCache(cached, undefined, 'remote')
  }
  if (!response.ok) throw new Error(`联系配置暂时不可用（${response.status}）。`)
  const configBytes = await readLimitedBytes(response, MAX_CONFIG_BYTES)
  const remote = parseRemoteContactConfig(JSON.parse(Buffer.from(configBytes).toString('utf8')), LICENSE_APP_NAME)
  const base: CachedContactConfig = {
    schemaVersion: 1,
    appName: LICENSE_APP_NAME,
    configured: true,
    enabled: remote.enabled,
    updatedAt: remote.updatedAt,
    cachedAt: new Date().toISOString()
  }
  if (!remote.enabled || !remote.imageUrl) {
    writeCache(base)
    return stateFromCache(base, undefined, 'remote')
  }
  const imageResponse = await fetchHttps(remote.imageUrl)
  if (!imageResponse.ok) throw new Error(`联系方式图片暂时不可用（${imageResponse.status}）。`)
  const image = await readLimitedBytes(imageResponse, MAX_IMAGE_BYTES)
  const imageMime = validateContactImage(imageResponse.headers.get('content-type') || '', image)
  await validateDecodableImage(image, imageMime)
  const cached: CachedContactConfig = {
    ...base,
    imageMime,
    imageSha256: sha256(image)
  }
  writeCache(cached, image)
  return stateFromCache(cached, image, 'remote')
}

export function refreshContactConfig(): Promise<ContactDisplayState> {
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = performRefresh()
    .catch(() => {
      const cached = getCachedContactState()
      return cached.source === 'cache'
        ? cached
        : bundledState('暂时无法获取最新联系方式，当前使用内置图片')
    })
    .finally(() => {
      refreshInFlight = null
    })
  return refreshInFlight
}

export const contactInternals = {
  MAX_CONFIG_BYTES,
  MAX_IMAGE_BYTES,
  CONTACT_TIMEOUT_MS,
  MAX_REDIRECTS,
  cacheDirectory,
  configPath,
  imagePath,
  parseCachedConfig,
  readCachedImage,
  validateDecodableImage,
  writeCache,
  performRefresh,
  resetInFlight: (): void => { refreshInFlight = null }
}
