import { app, shell } from 'electron'
import { createHash } from 'crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'fs'
import { basename, dirname, join } from 'path'
import { once } from 'events'
import type { UpdateActionResult, UpdateDownloadProgress, UpdateInfo } from '../shared/types'
import {
  LICENSE_APP_NAME,
  NETWORK_TIMEOUT_MS,
  UPDATE_LATEST_URL
} from './serviceConfig'
import { verifyUpdateManifestSignature } from './updateSignature'

interface UpdateConfig {
  version: string
  minSupportedVersion?: string
  downloadUrl: string
  sha256: string
  notes: string[]
  force: boolean
}

let cachedConfig: UpdateConfig | null = null

function platformKey(): 'windows_x64' | 'mac_arm64' | 'mac_x64' | null {
  if (process.platform === 'win32' && process.arch === 'x64') return 'windows_x64'
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'mac_arm64'
  if (process.platform === 'darwin' && process.arch === 'x64') return 'mac_x64'
  return null
}

function versionParts(value: string): { main: number[]; prerelease: string[] } | null {
  const normalized = value.trim().replace(/^v/i, '')
  const match = normalized.match(/^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/)
  if (!match) return null
  return {
    main: match[1].split('.').map((part) => Number(part)),
    prerelease: match[2] ? match[2].split('.') : []
  }
}

export function compareVersions(left: string, right: string): number {
  const a = versionParts(left)
  const b = versionParts(right)
  if (!a || !b) return left.localeCompare(right, 'en', { numeric: true })
  const length = Math.max(a.main.length, b.main.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (a.main[index] || 0) - (b.main[index] || 0)
    if (difference !== 0) return difference > 0 ? 1 : -1
  }
  if (!a.prerelease.length && !b.prerelease.length) return 0
  if (!a.prerelease.length) return 1
  if (!b.prerelease.length) return -1
  const preLength = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < preLength; index += 1) {
    const av = a.prerelease[index]
    const bv = b.prerelease[index]
    if (av === undefined) return -1
    if (bv === undefined) return 1
    if (av === bv) continue
    const an = /^\d+$/.test(av) ? Number(av) : null
    const bn = /^\d+$/.test(bv) ? Number(bv) : null
    if (an !== null && bn !== null) return an > bn ? 1 : -1
    if (an !== null) return -1
    if (bn !== null) return 1
    return av > bv ? 1 : -1
  }
  return 0
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function parseNotes(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 20)
  }
  const note = asString(value)
  return note ? note.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).slice(0, 20) : []
}

function selectPlatformValue(value: unknown, key: string): string | undefined {
  const record = asRecord(value)
  return record ? asString(record[key]) : asString(value)
}

function validateArtifactUrl(value: string, key: 'windows_x64' | 'mac_arm64' | 'mac_x64'): URL {
  const parsed = new URL(value)
  if (parsed.protocol !== 'https:') throw new Error('更新下载地址必须使用 HTTPS。')
  if (parsed.hostname !== 'update.dadaozixun.com' && !parsed.hostname.endsWith('.dadaozixun.com')) {
    throw new Error('更新下载地址不属于官方服务器。')
  }
  const expectedExtension = key === 'windows_x64' ? '.exe' : '.dmg'
  if (!decodeURIComponent(parsed.pathname).toLowerCase().endsWith(expectedExtension)) {
    throw new Error(`更新配置不是当前电脑需要的 ${expectedExtension} 安装包。`)
  }
  return parsed
}

function updateRoot(): string {
  return join(app.getPath('userData'), 'updates', LICENSE_APP_NAME)
}

function safeArtifactName(url: string): string {
  try {
    const parsed = new URL(url)
    const name = basename(decodeURIComponent(parsed.pathname)).replace(/[^0-9A-Za-z._-]/g, '_')
    if (name && name !== '.' && name !== '..') return name
  } catch {
    // 下方给出受控文件名
  }
  return process.platform === 'win32' ? 'Product-Operation-Report-Update.exe' : 'Product-Operation-Report-Update.dmg'
}

function artifactPath(config: UpdateConfig): string {
  return join(updateRoot(), config.version.replace(/[^0-9A-Za-z._-]/g, '_'), safeArtifactName(config.downloadUrl))
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  const reader = createReadStream(path)
  for await (const chunk of reader) hash.update(chunk)
  return hash.digest('hex')
}

async function isDownloaded(config: UpdateConfig): Promise<boolean> {
  const path = artifactPath(config)
  if (!existsSync(path)) return false
  try {
    return (await sha256File(path)).toLowerCase() === config.sha256.toLowerCase()
  } catch {
    return false
  }
}

async function toInfo(config: UpdateConfig | null, available: boolean): Promise<UpdateInfo> {
  const currentVersion = app.getVersion()
  if (!config) {
    return {
      available: false,
      appName: LICENSE_APP_NAME,
      currentVersion,
      notes: [],
      force: false,
      downloaded: false
    }
  }
  const downloaded = available && await isDownloaded(config)
  return {
    available,
    appName: LICENSE_APP_NAME,
    currentVersion,
    latestVersion: config.version,
    minSupportedVersion: config.minSupportedVersion,
    notes: config.notes,
    force: available && config.force,
    downloaded,
    downloadPath: downloaded ? artifactPath(config) : undefined
  }
}

export async function checkForUpdates(): Promise<UpdateInfo> {
  const key = platformKey()
  if (!key) {
    cachedConfig = null
    return await toInfo(null, false)
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS)
  try {
    const url = new URL(UPDATE_LATEST_URL)
    url.searchParams.set('app_name', LICENSE_APP_NAME)
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal: controller.signal
    })
    if (response.status === 404) {
      cachedConfig = null
      return await toInfo(null, false)
    }
    if (!response.ok) throw new Error(`更新服务暂时不可用（${response.status}）。`)
    const body = asRecord(await response.json())
    if (!body) throw new Error('更新服务返回了无法识别的配置。')
    const allowUnsignedDevelopmentManifest = !app.isPackaged && process.env.PRODUCT_REPORT_ALLOW_UNSIGNED_DEV_UPDATE === '1'
    if (!allowUnsignedDevelopmentManifest && !verifyUpdateManifestSignature(body)) {
      throw new Error('更新配置签名无效，为保护电脑安全已停止更新。')
    }
    const responseApp = asString(body.app_name)
    if (responseApp && responseApp !== LICENSE_APP_NAME) throw new Error('更新配置的软件标识不匹配。')
    const version = asString(body.version)
    const downloadUrl = selectPlatformValue(body.download_url, key)
    const checksum = selectPlatformValue(body.sha256, key)?.toLowerCase()
    if (!version || !versionParts(version)) throw new Error('更新配置缺少有效版本号。')
    if (!downloadUrl) throw new Error('更新配置没有当前电脑对应的下载地址。')
    validateArtifactUrl(downloadUrl, key)
    if (!checksum || !/^[a-f0-9]{64}$/.test(checksum)) throw new Error('更新配置缺少有效的 SHA256。')
    const minSupportedVersion = asString(body.min_supported_version)
    if (minSupportedVersion && !versionParts(minSupportedVersion)) {
      throw new Error('更新配置包含无效的最低支持版本号。')
    }
    const forceByMinimum = Boolean(
      minSupportedVersion && compareVersions(app.getVersion(), minSupportedVersion) < 0
    )
    cachedConfig = {
      version,
      minSupportedVersion,
      downloadUrl,
      sha256: checksum,
      notes: parseNotes(body.notes ?? body.release_notes ?? body.changelog),
      force: body.force === true || forceByMinimum
    }
    return await toInfo(cachedConfig, compareVersions(version, app.getVersion()) > 0)
  } finally {
    clearTimeout(timer)
  }
}

async function writeResponseToFile(
  response: Response,
  path: string,
  onProgress?: (progress: UpdateDownloadProgress) => void
): Promise<string> {
  if (!response.body) throw new Error('下载没有返回文件内容。')
  const totalHeader = response.headers.get('content-length')
  const total = totalHeader && /^\d+$/.test(totalHeader) ? Number(totalHeader) : undefined
  const maximumBytes = 1024 * 1024 * 1024
  if (total && total > maximumBytes) throw new Error('更新包超过 1GB，已停止下载。')
  const writer = createWriteStream(path, { flags: 'wx', mode: 0o600 })
  const reader = response.body.getReader()
  const hash = createHash('sha256')
  let received = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (!value?.byteLength) continue
      received += value.byteLength
      if (received > maximumBytes) throw new Error('更新包超过 1GB，已停止下载。')
      hash.update(value)
      if (!writer.write(value)) await once(writer, 'drain')
      onProgress?.({
        receivedBytes: received,
        totalBytes: total,
        percent: total ? Math.min(100, Math.round((received / total) * 100)) : undefined
      })
    }
    writer.end()
    await once(writer, 'finish')
    return hash.digest('hex')
  } catch (error) {
    writer.destroy()
    throw error
  } finally {
    reader.releaseLock()
  }
}

export async function downloadUpdate(
  onProgress?: (progress: UpdateDownloadProgress) => void
): Promise<UpdateActionResult> {
  const info = cachedConfig
    ? await toInfo(cachedConfig, compareVersions(cachedConfig.version, app.getVersion()) > 0)
    : await checkForUpdates()
  if (!info.available || !cachedConfig) return { ok: false, message: '当前已经是最新版本。', info }
  if (info.downloaded) return { ok: true, message: '更新包已经下载并校验完成。', info }

  const destination = artifactPath(cachedConfig)
  const directory = dirname(destination)
  const partial = `${destination}.part`
  mkdirSync(directory, { recursive: true })
  rmSync(partial, { force: true })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30 * 60 * 1000)
  try {
    const response = await fetch(cachedConfig.downloadUrl, { redirect: 'follow', signal: controller.signal })
    if (!response.ok) throw new Error(`下载失败（${response.status}）。`)
    const finalUrl = new URL(response.url)
    if (finalUrl.protocol !== 'https:' || (finalUrl.hostname !== 'update.dadaozixun.com' && !finalUrl.hostname.endsWith('.dadaozixun.com'))) {
      throw new Error('更新下载被重定向到非官方地址。')
    }
    const checksum = await writeResponseToFile(response, partial, onProgress)
    if (checksum.toLowerCase() !== cachedConfig.sha256.toLowerCase()) {
      throw new Error('更新包校验失败，文件可能不完整，已停止安装。')
    }
    rmSync(destination, { force: true })
    renameSync(partial, destination)
    const completed = await toInfo(cachedConfig, true)
    return { ok: true, message: '下载完成并已通过安全校验。', info: completed }
  } catch (error) {
    rmSync(partial, { force: true })
    return {
      ok: false,
      message: error instanceof Error && error.name === 'AbortError'
        ? '更新下载超时，请稍后重试。旧版本仍可继续使用。'
        : `${error instanceof Error ? error.message : '更新下载失败。'} 旧版本仍可继续使用。`,
      info: await toInfo(cachedConfig, true)
    }
  } finally {
    clearTimeout(timer)
  }
}

export async function installDownloadedUpdate(): Promise<UpdateActionResult> {
  if (!cachedConfig) return { ok: false, message: '请先检查并下载更新。' }
  const path = artifactPath(cachedConfig)
  if (!existsSync(path)) {
    return { ok: false, message: '没有找到已下载的更新包，请重新下载。', info: await toInfo(cachedConfig, true) }
  }
  if ((await sha256File(path)).toLowerCase() !== cachedConfig.sha256.toLowerCase()) {
    rmSync(path, { force: true })
    return { ok: false, message: '安装前校验失败，已删除损坏的更新包，请重新下载。', info: await toInfo(cachedConfig, true) }
  }
  const error = await shell.openPath(path)
  if (error) return { ok: false, message: `无法启动安装程序：${error}`, info: await toInfo(cachedConfig, true) }
  setTimeout(() => app.quit(), 800)
  return { ok: true, message: '安装程序已启动，软件即将关闭。', info: await toInfo(cachedConfig, true) }
}

export function getUpdateDownloadDirectory(): string {
  return updateRoot()
}
