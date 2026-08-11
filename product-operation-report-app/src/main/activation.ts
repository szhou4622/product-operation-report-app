import { app } from 'electron'
import { execFileSync } from 'child_process'
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes
} from 'crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { arch, hostname, platform, userInfo } from 'os'
import type {
  ActivationDeactivationResult,
  ActivationResult,
  ActivationStatus,
  LicenseUsageResult
} from '../shared/types'
import { ACTIVATION_CODE_COUNT, ACTIVATION_CODE_HASHES } from './activationCodes'
import {
  LICENSE_ACTIVATE_URL,
  LICENSE_APP_NAME,
  LICENSE_DEVICE_STATUS_URL,
  LICENSE_DEVICE_UNBIND_URL,
  LICENSE_OFFLINE_GRACE_MS,
  NETWORK_TIMEOUT_MS
} from './serviceConfig'

const ACTIVATION_FILE = () => join(app.getPath('userData'), 'activation.json')
const ACTIVATION_BACKUP_FILE = () => `${ACTIVATION_FILE()}.bak`
const CODE_NAMESPACE = 'product-operation-report:activation:v1:'
const DEVICE_NAMESPACE = 'product-operation-report:device:v1:'
const ENCRYPTION_NAMESPACE = 'product-operation-report:server-code:v1:'
const allowedCodeHashes = new Set<string>(ACTIVATION_CODE_HASHES)
export const LEGACY_ACTIVATION_POINTS = 2_000
let machineGuidLoaded = false
let cachedMachineGuid = ''
let systemMachineIdLoaded = false
let cachedSystemMachineId = ''
let cachedLegacyDeviceId = ''
let cachedDeviceId = ''

interface LegacyStoredActivation {
  version: 1
  codeHash: string
  deviceId: string
  activatedAt: string
}

interface ServerStoredActivation {
  version: 2
  appName: string
  source: 'server' | 'legacy'
  codeHash: string
  encryptedCode?: string
  deviceId: string
  activatedAt: string
  licenseId?: string
  licenseType: 'credits' | 'unlimited' | 'standard'
  unlimited: boolean
  creditsRemaining?: number
  usedOperationIds?: string[]
  expiresAt?: string
  lastValidatedAt?: string
  offlineUntil?: string
  offlineSince?: string
  encryptedDeviceCredential?: string
  encryptedDeviceSession?: string
  bindingStatus?: 'active' | 'unbound'
  transferCount?: number
  revokedReason?: string
  serverMessage?: string
}

type StoredActivation = LegacyStoredActivation | ServerStoredActivation

interface ServerLicense {
  ok: boolean
  message: string
  unavailable: boolean
  hasLicenseDetails: boolean
  licenseId?: string
  licenseType: 'credits' | 'unlimited' | 'standard'
  unlimited: boolean
  creditsRemaining?: number
  creditsGranted?: number
  expiresAt?: string
  deviceCredential?: string
  deviceSession?: string
  bindingStatus?: 'active' | 'unbound'
  transferCount?: number
}

interface ServerDeviceUnbind {
  ok: boolean
  unavailable: boolean
  message: string
  unbindId?: string
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

function hashActivationCode(code: string): string {
  return sha256(`${CODE_NAMESPACE}${normalizeCode(code)}`)
}

function getWindowsMachineGuid(): string {
  if (process.platform !== 'win32') return ''
  if (machineGuidLoaded) return cachedMachineGuid
  machineGuidLoaded = true
  try {
    const output = execFileSync(
      'reg',
      ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
      { encoding: 'utf8', timeout: 2000, windowsHide: true }
    )
    const match = output.match(/MachineGuid\s+REG_SZ\s+([^\r\n]+)/i)
    cachedMachineGuid = match?.[1]?.trim() ?? ''
    return cachedMachineGuid
  } catch {
    cachedMachineGuid = ''
    return ''
  }
}

function getSystemMachineId(): string {
  if (systemMachineIdLoaded) return cachedSystemMachineId
  systemMachineIdLoaded = true
  if (process.platform === 'win32') {
    cachedSystemMachineId = getWindowsMachineGuid()
    return cachedSystemMachineId
  }
  if (process.platform === 'darwin') {
    try {
      const output = execFileSync(
        '/usr/sbin/ioreg',
        ['-rd1', '-c', 'IOPlatformExpertDevice'],
        { encoding: 'utf8', timeout: 2500 }
      )
      cachedSystemMachineId = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/i)?.[1]?.trim() || ''
      return cachedSystemMachineId
    } catch {
      cachedSystemMachineId = ''
      return ''
    }
  }
  try {
    cachedSystemMachineId = readFileSync('/etc/machine-id', 'utf8').trim()
  } catch {
    cachedSystemMachineId = ''
  }
  return cachedSystemMachineId
}

function getLegacyDeviceId(): string {
  if (cachedLegacyDeviceId) return cachedLegacyDeviceId
  let user = ''
  try {
    user = userInfo().username
  } catch {
    user = ''
  }
  const seed = [platform(), arch(), hostname(), user, getWindowsMachineGuid()].join('|')
  cachedLegacyDeviceId = sha256(`${DEVICE_NAMESPACE}${seed}`).slice(0, 32)
  return cachedLegacyDeviceId
}

export function getDeviceId(): string {
  if (cachedDeviceId) return cachedDeviceId
  const systemMachineId = getSystemMachineId()
  if (systemMachineId) {
    const kind = process.platform === 'win32' ? 'windows-machine-guid' : `${process.platform}-hardware-id`
    cachedDeviceId = sha256(`${DEVICE_NAMESPACE}${kind}|${systemMachineId}`).slice(0, 32)
    return cachedDeviceId
  }
  cachedDeviceId = getLegacyDeviceId()
  return cachedDeviceId
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function asFiniteNumber(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : undefined
}

function asFinitePoints(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(number) || number < 0 || number > 10_000_000) return undefined
  return Math.round(number * 1_000) / 1_000
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1' || value === 'true') return true
  if (value === 0 || value === '0' || value === 'false') return false
  return undefined
}

function readStoredActivationFile(file: string): StoredActivation | null {
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    if (
      parsed?.version === 1 &&
      typeof parsed.codeHash === 'string' &&
      typeof parsed.deviceId === 'string' &&
      typeof parsed.activatedAt === 'string'
    ) {
      return parsed as unknown as LegacyStoredActivation
    }
    if (
      parsed?.version === 2 &&
      parsed.appName === LICENSE_APP_NAME &&
      (parsed.source === 'server' || parsed.source === 'legacy') &&
      typeof parsed.codeHash === 'string' &&
      typeof parsed.deviceId === 'string' &&
      typeof parsed.activatedAt === 'string' &&
      (parsed.licenseType === 'credits' || parsed.licenseType === 'unlimited' || parsed.licenseType === 'standard') &&
      typeof parsed.unlimited === 'boolean'
    ) {
      return parsed as unknown as ServerStoredActivation
    }
  } catch {
    return null
  }
  return null
}

function readStoredActivation(): StoredActivation | null {
  return readStoredActivationFile(ACTIVATION_FILE()) ?? readStoredActivationFile(ACTIVATION_BACKUP_FILE())
}

function writeStoredActivation(record: StoredActivation): void {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const file = ACTIVATION_FILE()
  const temp = `${file}.tmp`
  const backup = ACTIVATION_BACKUP_FILE()
  const backupTemp = `${backup}.tmp`
  try {
    writeFileSync(temp, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, file)
    try {
      copyFileSync(file, backupTemp)
      renameSync(backupTemp, backup)
    } catch {
      if (existsSync(backupTemp)) rmSync(backupTemp, { force: true })
    }
  } finally {
    if (existsSync(temp)) rmSync(temp, { force: true })
    if (existsSync(backupTemp)) rmSync(backupTemp, { force: true })
  }
}

function encryptionKey(deviceId: string): Buffer {
  return createHash('sha256').update(`${ENCRYPTION_NAMESPACE}${deviceId}`, 'utf8').digest()
}

function encryptActivationCode(code: string, deviceId: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(deviceId), iv)
  const encrypted = Buffer.concat([cipher.update(code, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${encrypted.toString('base64url')}`
}

function decryptActivationCode(value: string | undefined, deviceId: string): string | null {
  if (!value) return null
  try {
    const [version, ivValue, tagValue, encryptedValue] = value.split(':')
    if (version !== 'v1' || !ivValue || !tagValue || !encryptedValue) return null
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(deviceId), Buffer.from(ivValue, 'base64url'))
    decipher.setAuthTag(Buffer.from(tagValue, 'base64url'))
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedValue, 'base64url')),
      decipher.final()
    ]).toString('utf8')
  } catch {
    return null
  }
}

function encryptServerSecret(value: string | undefined, deviceId: string): string | undefined {
  return value ? encryptActivationCode(value, deviceId) : undefined
}

function decryptServerSecret(value: string | undefined, deviceId: string): string | null {
  return decryptActivationCode(value, deviceId)
}

function recordMatchesDevice(record: StoredActivation, deviceId: string): boolean {
  return record.deviceId === deviceId || record.deviceId === getLegacyDeviceId()
}

function isExpired(expiresAt?: string): boolean {
  if (!expiresAt) return false
  const timestamp = Date.parse(expiresAt)
  return Number.isFinite(timestamp) && timestamp <= Date.now()
}

function legacyLicenseId(codeHash: string): string {
  return `LEGACY-${codeHash.slice(0, 12).toUpperCase()}`
}

function toStatus(record: StoredActivation | null, deviceId = getDeviceId()): ActivationStatus {
  const common = {
    deviceId,
    codeCount: ACTIVATION_CODE_COUNT,
    appName: LICENSE_APP_NAME,
    unlimited: false,
    offline: false
  }
  if (!record || !recordMatchesDevice(record, deviceId)) return { ...common, activated: false }

  if (record.version === 1) {
    const valid = allowedCodeHashes.has(record.codeHash)
    return {
      ...common,
      activated: valid,
      activatedAt: valid ? record.activatedAt : undefined,
      licenseId: valid ? legacyLicenseId(record.codeHash) : undefined,
      source: valid ? 'legacy' : undefined,
      licenseType: valid ? 'credits' : undefined,
      unlimited: false,
      creditsRemaining: valid ? LEGACY_ACTIVATION_POINTS : undefined,
      message: valid ? `旧版激活码已转换为 ${LEGACY_ACTIVATION_POINTS} 积分授权` : undefined
    }
  }

  const bundledLegacy = allowedCodeHashes.has(record.codeHash) && (
    record.source === 'legacy' ||
    (record.licenseType === 'unlimited' && !record.encryptedDeviceCredential)
  )
  const remaining = bundledLegacy ? LEGACY_ACTIVATION_POINTS : record.creditsRemaining
  const licenseType = bundledLegacy ? 'credits' : record.licenseType
  const unlimited = bundledLegacy ? false : record.unlimited
  const offline = record.source === 'server' && Boolean(record.offlineSince)
  const offlineExpired = record.source === 'server' && Boolean(record.offlineUntil) && Date.now() > Date.parse(record.offlineUntil || '')
  const valid =
    record.appName === LICENSE_APP_NAME &&
    record.bindingStatus !== 'unbound' &&
    !record.revokedReason &&
    !isExpired(record.expiresAt) &&
    !offlineExpired &&
    (record.source === 'server' || allowedCodeHashes.has(record.codeHash))

  let message = record.serverMessage
  if (record.bindingStatus === 'unbound') message = '本机已解除绑定，请在需要使用的电脑输入原激活码。'
  else if (record.revokedReason) message = record.revokedReason
  else if (isExpired(record.expiresAt)) message = '授权已过期，请联系管理员。'
  else if (licenseType === 'credits' && remaining !== undefined && remaining <= 0) message = '积分已用完，请输入新的激活码后再开始分析。'
  else if (offlineExpired) message = '离线授权时间已超过 72 小时，请联网后重新检查。'
  else if (offline) message = '服务器暂时不可用，当前处于离线可用状态。'
  else if (bundledLegacy) message = `旧版激活码已转换为 ${LEGACY_ACTIVATION_POINTS} 积分授权`

  return {
    ...common,
    activated: valid,
    activatedAt: valid ? record.activatedAt : undefined,
    licenseId: valid ? (bundledLegacy ? legacyLicenseId(record.codeHash) : record.licenseId || record.codeHash.slice(0, 10).toUpperCase()) : undefined,
    activationCode: valid ? decryptActivationCode(record.encryptedCode, deviceId) || undefined : undefined,
    source: record.source,
    licenseType,
    unlimited,
    creditsRemaining: remaining,
    expiresAt: record.expiresAt,
    offline,
    offlineUntil: record.offlineUntil,
    bindingStatus: record.bindingStatus,
    transferCount: record.transferCount,
    message
  }
}

function pickPayload(body: Record<string, unknown>): Record<string, unknown> {
  let current = body
  for (let depth = 0; depth < 3; depth += 1) {
    let next: Record<string, unknown> | null = null
    for (const key of ['license', 'authorization', 'data', 'result']) {
      const nested = current[key]
      if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
        next = nested as Record<string, unknown>
        break
      }
    }
    if (!next) return current
    current = next
  }
  return current
}

function pickFirst(source: Record<string, unknown>, body: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (source[key] !== undefined) return source[key]
    if (body[key] !== undefined) return body[key]
  }
  return undefined
}

function pickFirstDeep(body: Record<string, unknown>, keys: string[], depth = 0): unknown {
  for (const key of keys) {
    if (body[key] !== undefined) return body[key]
  }
  if (depth >= 4) return undefined
  for (const value of Object.values(body)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const found = pickFirstDeep(value as Record<string, unknown>, keys, depth + 1)
    if (found !== undefined) return found
  }
  return undefined
}

function normalizeBindingStatus(value: unknown): 'active' | 'unbound' | undefined {
  const status = String(value || '').trim().toLowerCase()
  if (status === 'active' || status === 'bound') return 'active'
  if (status === 'unbound' || status === 'unbind') return 'unbound'
  return undefined
}

function normalizeServerMessage(value: unknown, fallback: string): string {
  const message = asString(value)?.replace(/\s+/g, ' ').slice(0, 240)
  return message || fallback
}

function parseServerLicense(body: Record<string, unknown>, httpOk: boolean): ServerLicense {
  const payload = pickPayload(body)
  const bindingStatus = normalizeBindingStatus(pickFirstDeep(body, ['binding_status']))
  const message = normalizeServerMessage(
    pickFirst(payload, body, ['message', 'error', 'detail', 'msg']),
    bindingStatus === 'unbound'
      ? '当前设备已经解除绑定。'
      : httpOk
        ? '授权验证成功。'
        : '激活码校验失败。'
  )
  const explicitOk = pickFirst(payload, body, ['ok', 'success', 'activated', 'valid'])
  const status = String(pickFirst(payload, body, ['status', 'license_status']) || '').toLowerCase()
  const rejectedStatus =
    bindingStatus === 'unbound' ||
    ['disabled', 'expired', 'invalid', 'revoked', 'blocked', 'machine_mismatch'].some((item) => status.includes(item))
  const ok = httpOk && explicitOk !== false && explicitOk !== 0 && explicitOk !== 'false' && !rejectedStatus

  const typeText = String(pickFirst(payload, body, ['license_type', 'type', 'code_type']) || '').toLowerCase()
  const unlimitedValue = pickFirst(payload, body, ['unlimited', 'is_unlimited', 'permanent'])
  const unlimited =
    asBoolean(unlimitedValue) === true ||
    /unlimited|permanent|lifetime|无限|永久/.test(typeText)
  const creditsRemaining = asFinitePoints(
    pickFirstDeep(body, [
      'remaining_credits',
      'credits_remaining',
      'remaining_points',
      'wallet_balance',
      'points_balance',
      'balance'
    ])
  )
  const creditsGranted = asFinitePoints(
    pickFirstDeep(body, [
      'credits',
      'points',
      'quota',
      'initial_credits',
      'granted_credits'
    ])
  )
  const licenseType: ServerLicense['licenseType'] = unlimited
    ? 'unlimited'
    : creditsRemaining !== undefined || creditsGranted !== undefined || /credit|point|积分/.test(typeText)
      ? 'credits'
      : 'standard'

  return {
    ok,
    message,
    unavailable: false,
    hasLicenseDetails:
      Boolean(typeText) || unlimitedValue !== undefined || creditsRemaining !== undefined || creditsGranted !== undefined,
    licenseId: asString(pickFirst(payload, body, ['license_id', 'code_id', 'id', 'activation_id'])),
    licenseType,
    unlimited,
    creditsRemaining,
    creditsGranted,
    expiresAt: asString(pickFirstDeep(body, ['expires_at', 'expiresAt', 'expiry', 'valid_until'])),
    deviceCredential: asString(pickFirstDeep(body, ['device_credential', 'deviceCredential'])),
    deviceSession: asString(pickFirstDeep(body, [
      'device_session',
      'device_session_token',
      'session_token',
      'session',
      'access_token',
      'accessToken',
      'device_access_token'
    ])),
    bindingStatus,
    transferCount: asFiniteNumber(pickFirstDeep(body, ['transfer_count']))
  }
}

async function requestServerActivation(code: string, deviceId: string): Promise<ServerLicense> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS)
  try {
    const response = await fetch(LICENSE_ACTIVATE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        app_name: LICENSE_APP_NAME,
        activation_code: code,
        machine_code: deviceId,
        software_version: app.getVersion(),
        platform: `${process.platform}-${process.arch}`,
        // 兼容统一服务当前 v2 字段；新版服务可直接读取上面的标准字段。
        code,
        machine_id: deviceId
      }),
      signal: controller.signal
    })
    const text = await response.text()
    let body: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(text) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>
    } catch {
      body = { error: response.ok ? '服务器返回了无法识别的结果。' : `服务器校验失败（${response.status}）。` }
    }
    return parseServerLicense(body, response.ok)
  } catch (error) {
    const timeout = error instanceof Error && error.name === 'AbortError'
    return {
      ok: false,
      message: timeout ? '连接激活服务器超时。' : '暂时无法连接激活服务器。',
      unavailable: true,
      hasLicenseDetails: false,
      licenseType: 'standard',
      unlimited: false
    }
  } finally {
    clearTimeout(timer)
  }
}

async function requestServerDeviceStatus(
  deviceId: string,
  licenseId: string | undefined,
  deviceCredential: string,
  deviceSession: string
): Promise<ServerLicense> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS)
  try {
    const url = new URL(LICENSE_DEVICE_STATUS_URL)
    url.searchParams.set('app_name', LICENSE_APP_NAME)
    url.searchParams.set('machine_code', deviceId)
    if (licenseId) url.searchParams.set('license_id', licenseId)
    url.searchParams.set('software_version', app.getVersion())
    url.searchParams.set('platform', `${process.platform}-${process.arch}`)
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${deviceSession}`,
        'x-device-credential': deviceCredential
      },
      signal: controller.signal
    })
    const text = await response.text()
    let body: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(text) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>
    } catch {
      body = { error: response.ok ? '服务器返回了无法识别的授权状态。' : `授权状态检查失败（${response.status}）。` }
    }
    return parseServerLicense(body, response.ok)
  } catch (error) {
    const timeout = error instanceof Error && error.name === 'AbortError'
    return {
      ok: false,
      message: timeout ? '检查设备授权状态超时。' : '暂时无法检查设备授权状态。',
      unavailable: true,
      hasLicenseDetails: false,
      licenseType: 'standard',
      unlimited: false
    }
  } finally {
    clearTimeout(timer)
  }
}

async function requestServerDeviceUnbind(
  deviceId: string,
  licenseId: string | undefined,
  deviceCredential: string,
  deviceSession: string
): Promise<ServerDeviceUnbind> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS)
  try {
    const response = await fetch(LICENSE_DEVICE_UNBIND_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${deviceSession}`,
        'x-device-credential': deviceCredential
      },
      body: JSON.stringify({
        app_name: LICENSE_APP_NAME,
        machine_code: deviceId,
        license_id: licenseId,
        device_credential: deviceCredential,
        software_version: app.getVersion(),
        platform: `${process.platform}-${process.arch}`
      }),
      signal: controller.signal
    })
    const text = await response.text()
    let body: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(text) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>
    } catch {
      body = {}
    }
    const payload = pickPayload(body)
    const unavailable = response.status === 404 || response.status >= 500
    const fallback = response.status === 404
      ? '服务器尚未开通新版设备解绑接口，请联系管理员更新授权服务。'
      : response.ok
        ? '本机已解除绑定。'
        : `解除绑定失败（${response.status}）。`
    const message = normalizeServerMessage(
      pickFirst(payload, body, ['message', 'error', 'detail', 'msg']),
      fallback
    )
    const explicitOk = pickFirst(payload, body, ['ok', 'success', 'unbound'])
    const bindingStatus = normalizeBindingStatus(pickFirstDeep(body, ['binding_status']))
    const ok = response.ok &&
      explicitOk !== false &&
      explicitOk !== 0 &&
      explicitOk !== 'false' &&
      bindingStatus !== 'active'
    return {
      ok,
      unavailable,
      message,
      unbindId: ok
        ? asString(pickFirstDeep(body, ['unbind_id', 'operation_id', 'event_id', 'id']))
        : undefined
    }
  } catch (error) {
    const timeout = error instanceof Error && error.name === 'AbortError'
    return {
      ok: false,
      unavailable: true,
      message: timeout
        ? '连接授权服务器超时，本机仍保持激活，请稍后再试。'
        : '暂时无法连接授权服务器，本机仍保持激活，请稍后再试。'
    }
  } finally {
    clearTimeout(timer)
  }
}

function migrateLegacyDevice(record: StoredActivation, deviceId: string): StoredActivation {
  if (record.deviceId === deviceId) return record
  const migrated = { ...record, deviceId } as StoredActivation
  try {
    writeStoredActivation(migrated)
  } catch {
    return record
  }
  return migrated
}

export function getActivationStatus(): ActivationStatus {
  const deviceId = getDeviceId()
  const record = readStoredActivation()
  const migrated = record && recordMatchesDevice(record, deviceId) ? migrateLegacyDevice(record, deviceId) : record
  return toStatus(migrated, deviceId)
}

export async function getActivationStatusWithServerCheck(): Promise<ActivationStatus> {
  const deviceId = getDeviceId()
  const record = readStoredActivation()
  if (!record || !recordMatchesDevice(record, deviceId) || record.version === 1) {
    return getActivationStatus()
  }

  const current = migrateLegacyDevice(record, deviceId) as ServerStoredActivation
  const code = decryptActivationCode(current.encryptedCode, deviceId)
  const deviceCredential = decryptServerSecret(current.encryptedDeviceCredential, deviceId)
  const deviceSession = decryptServerSecret(current.encryptedDeviceSession, deviceId)
  if (!code && (!deviceCredential || !deviceSession)) {
    const revoked = { ...current, revokedReason: '本地授权记录不完整，请重新输入激活码。' }
    writeStoredActivation(revoked)
    return toStatus(revoked, deviceId)
  }

  const result = deviceCredential && deviceSession
    ? await requestServerDeviceStatus(deviceId, current.licenseId, deviceCredential, deviceSession)
    : await requestServerActivation(code || '', deviceId)
  if (result.ok) {
    const now = new Date()
    const serverRemaining = result.creditsRemaining
    const currentRemaining = current.creditsRemaining
    const creditsRemaining =
      serverRemaining === undefined
        ? currentRemaining
        : currentRemaining === undefined
          ? serverRemaining
          : Math.min(currentRemaining, serverRemaining)
    const baseUpdated: ServerStoredActivation = {
      ...current,
      source: 'server',
      licenseId: result.licenseId || current.licenseId,
      licenseType: result.hasLicenseDetails
          ? result.licenseType
          : current.licenseType,
      unlimited: result.hasLicenseDetails
          ? result.unlimited
          : current.unlimited,
      creditsRemaining,
      expiresAt: result.expiresAt ?? current.expiresAt,
      lastValidatedAt: now.toISOString(),
      offlineUntil: new Date(now.getTime() + LICENSE_OFFLINE_GRACE_MS).toISOString(),
      offlineSince: undefined,
      encryptedDeviceCredential:
        encryptServerSecret(result.deviceCredential, deviceId) || current.encryptedDeviceCredential,
      encryptedDeviceSession:
        encryptServerSecret(result.deviceSession, deviceId) || current.encryptedDeviceSession,
      bindingStatus: result.bindingStatus || 'active',
      transferCount: result.transferCount ?? current.transferCount,
      revokedReason: undefined,
      serverMessage: result.message
    }
    writeStoredActivation(baseUpdated)
    return toStatus(baseUpdated, deviceId)
  }

  if (result.unavailable || (current.source === 'legacy' && !result.ok)) {
    const offlineRecord: ServerStoredActivation = {
      ...current,
      offlineSince: current.source === 'server' ? new Date().toISOString() : undefined,
      serverMessage: result.message
    }
    writeStoredActivation(offlineRecord)
    return toStatus(offlineRecord, deviceId)
  }

  const revoked: ServerStoredActivation = { ...current, revokedReason: result.message, serverMessage: result.message }
  writeStoredActivation(revoked)
  return toStatus(revoked, deviceId)
}

export async function activateWithCode(input: string): Promise<ActivationResult> {
  const enteredCode = input.trim()
  const normalized = normalizeCode(enteredCode)
  const currentStatus = getActivationStatus()
  if (!normalized) return { ok: false, message: '请输入激活码。', status: currentStatus }
  if (enteredCode.length > 512) return { ok: false, message: '激活码格式不正确，请重新输入。', status: currentStatus }

  const deviceId = currentStatus.deviceId
  const codeHash = hashActivationCode(enteredCode)
  const currentRecord = readStoredActivation()
  const server = await requestServerActivation(enteredCode, deviceId)
  if (server.ok) {
    const reusableRecord =
      currentRecord?.version === 2 &&
      currentRecord.codeHash === codeHash &&
      recordMatchesDevice(currentRecord, deviceId)
        ? currentRecord
        : null
    const deviceCredential =
      server.deviceCredential ||
      decryptServerSecret(reusableRecord?.encryptedDeviceCredential, deviceId)
    const deviceSession =
      server.deviceSession ||
      decryptServerSecret(reusableRecord?.encryptedDeviceSession, deviceId)
    if (!deviceCredential || !deviceSession) {
      return {
        ok: false,
        message: '服务器已识别激活码，但没有返回设备会话和设备凭证，本机也没有可复用的旧凭证。为避免以后无法直接解绑，本次没有写入授权；请联系管理员检查服务器的重复激活配置。',
        status: currentStatus
      }
    }
    const now = new Date()
    const activationCredits =
      server.creditsRemaining !== undefined && server.creditsRemaining > 0
        ? server.creditsRemaining
        : server.creditsGranted
    const baseRecord: ServerStoredActivation = {
      version: 2,
      appName: LICENSE_APP_NAME,
      source: 'server',
      codeHash,
      encryptedCode: encryptActivationCode(enteredCode, deviceId),
      deviceId,
      activatedAt: now.toISOString(),
      licenseId: server.licenseId,
      licenseType: server.licenseType,
      unlimited: server.unlimited,
      creditsRemaining: activationCredits ?? server.creditsRemaining,
      usedOperationIds: [],
      expiresAt: server.expiresAt,
      lastValidatedAt: now.toISOString(),
      offlineUntil: new Date(now.getTime() + LICENSE_OFFLINE_GRACE_MS).toISOString(),
      offlineSince: undefined,
      encryptedDeviceCredential: encryptServerSecret(deviceCredential, deviceId),
      encryptedDeviceSession: encryptServerSecret(deviceSession, deviceId),
      bindingStatus: server.bindingStatus || 'active',
      transferCount: server.transferCount,
      serverMessage: server.message
    }
    writeStoredActivation(baseRecord)
    const status = toStatus(baseRecord, deviceId)
    return {
      ok: status.activated,
      message: status.activated ? baseRecord.serverMessage || server.message : status.message || server.message,
      status
    }
  }

  return { ok: false, message: server.message, status: currentStatus }
}

export async function redeemPointsWithCode(input: string): Promise<{
  ok: boolean
  message: string
  grantId?: string
  points?: number
}> {
  const currentStatus = getActivationStatus()
  if (!currentStatus.activated) {
    return { ok: false, message: '软件授权不可用，请先使用主激活码激活软件。' }
  }
  const enteredCode = input.trim()
  if (!normalizeCode(enteredCode) || enteredCode.length > 512) {
    return { ok: false, message: '请输入管理员发放的有效积分码。' }
  }
  const currentRecord = readStoredActivation()
  if (currentRecord && hashActivationCode(enteredCode) === currentRecord.codeHash) {
    return { ok: false, message: '当前软件激活码不能作为积分码重复充值，请输入管理员另外发放的积分码。' }
  }

  const result = await requestServerActivation(enteredCode, currentStatus.deviceId)
  if (!result.ok) return { ok: false, message: result.message }
  const rechargePoints =
    result.creditsRemaining !== undefined && result.creditsRemaining > 0
      ? result.creditsRemaining
      : result.creditsGranted
  if (result.licenseType !== 'credits' || (rechargePoints || 0) <= 0) {
    return { ok: false, message: '这个码不包含可充值积分，请使用管理员发放的积分码。' }
  }
  if (!result.licenseId) {
    return { ok: false, message: '服务器没有返回积分码编号，为避免重复入账，本次没有增加积分。' }
  }
  return {
    ok: true,
    message: result.message,
    grantId: result.licenseId,
    points: rechargePoints
  }
}

function clearStoredActivation(): void {
  for (const file of [
    ACTIVATION_FILE(),
    ACTIVATION_BACKUP_FILE(),
    `${ACTIVATION_FILE()}.tmp`,
    `${ACTIVATION_BACKUP_FILE()}.tmp`
  ]) {
    rmSync(file, { force: true })
  }
}

export async function deactivateCurrentDevice(): Promise<ActivationDeactivationResult> {
  const deviceId = getDeviceId()
  const currentStatus = getActivationStatus()
  const record = readStoredActivation()
  if (!record || !recordMatchesDevice(record, deviceId)) {
    return {
      ok: false,
      message: '本机当前没有可以解除的授权。',
      status: currentStatus
    }
  }
  if (record.version !== 2) {
    try {
      clearStoredActivation()
    } catch {
      return {
        ok: false,
        message: '旧版本机授权未能清理，请关闭软件后重试。',
        status: currentStatus
      }
    }
    return {
      ok: true,
      message: '旧版本机授权已解除。该记录没有建立服务器设备绑定；现在可以在新电脑通过服务器输入原激活码。',
      status: {
        ...toStatus(null, deviceId),
        message: '本机旧授权已解除，可在新电脑输入原激活码。'
      },
      unbindId: `legacy-local:${record.codeHash.slice(0, 24)}`
    }
  }
  if (record.source === 'legacy') {
    try {
      clearStoredActivation()
    } catch {
      return {
        ok: false,
        message: '旧版本机授权未能清理，请关闭软件后重试。',
        status: currentStatus
      }
    }
    return {
      ok: true,
      message: '旧版本机授权已解除。该记录没有建立服务器设备绑定；现在可以在新电脑通过服务器输入原激活码。',
      status: {
        ...toStatus(null, deviceId),
        message: '本机旧授权已解除，可在新电脑输入原激活码。'
      },
      unbindId: `legacy-local:${record.codeHash.slice(0, 24)}`
    }
  }

  let current = record
  let licenseId = current.licenseId
  let deviceCredential = decryptServerSecret(current.encryptedDeviceCredential, deviceId)
  let deviceSession = decryptServerSecret(current.encryptedDeviceSession, deviceId)
  if (!deviceCredential || !deviceSession) {
    const code = decryptActivationCode(current.encryptedCode, deviceId)
    if (!code) {
      return {
        ok: false,
        message: '当前服务器授权缺少设备凭证，本机仍保持激活。请联网后重新打开软件；若仍无法恢复，请联系管理员。',
        status: currentStatus
      }
    }
    const binding = await requestServerActivation(code, deviceId)
    if (!binding.ok) {
      return {
        ok: false,
        message: binding.unavailable
          ? '暂时无法连接授权服务器，本机仍保持激活，请稍后再试。'
          : `旧版激活码尚未完成服务器登记，暂时不能换设备：${binding.message}`,
        status: currentStatus
      }
    }
    licenseId = binding.licenseId || licenseId
    deviceCredential = binding.deviceCredential || deviceCredential
    deviceSession = binding.deviceSession || deviceSession
    if (!deviceCredential || !deviceSession) {
      return {
        ok: false,
        message: '服务器没有返回当前设备的安全凭证，本机仍保持激活。请联系管理员确认新版设备解绑服务已完整启用。',
        status: currentStatus
      }
    }
    const now = new Date()
    current = {
      ...current,
      source: 'server',
      licenseId,
      licenseType: binding.licenseType,
      unlimited: binding.unlimited,
      creditsRemaining: binding.creditsRemaining ?? current.creditsRemaining,
      expiresAt: binding.expiresAt,
      lastValidatedAt: now.toISOString(),
      offlineUntil: new Date(now.getTime() + LICENSE_OFFLINE_GRACE_MS).toISOString(),
      offlineSince: undefined,
      encryptedDeviceCredential: encryptServerSecret(deviceCredential, deviceId),
      encryptedDeviceSession: encryptServerSecret(deviceSession, deviceId),
      bindingStatus: binding.bindingStatus || 'active',
      transferCount: binding.transferCount ?? current.transferCount,
      revokedReason: undefined,
      serverMessage: binding.message
    }
    writeStoredActivation(current)
  }

  if (!deviceCredential || !deviceSession) {
    return {
      ok: false,
      message: '当前设备缺少安全解绑凭证，本机仍保持激活。请联网后重新打开软件再试。',
      status: currentStatus
    }
  }

  const result = await requestServerDeviceUnbind(
    deviceId,
    licenseId,
    deviceCredential,
    deviceSession
  )
  if (!result.ok) {
    return { ok: false, message: result.message, status: currentStatus }
  }

  let localCleanupWarning = ''
  try {
    clearStoredActivation()
  } catch {
    localCleanupWarning = ' 本机授权文件未能完全删除，软件已将它标记为失效；若重启后仍显示已激活，请联系管理员。'
    try {
      writeStoredActivation({
        ...current,
        encryptedDeviceCredential: undefined,
        encryptedDeviceSession: undefined,
        bindingStatus: 'unbound',
        revokedReason: '本机已解除绑定，请在新电脑输入原激活码。',
        serverMessage: '本机已解除绑定。'
      })
    } catch {
      // 云端凭证已立即撤销；即使本地文件异常，也不能再调用在线服务。
    }
  }
  return {
    ok: true,
    message: `本机已解除绑定。剩余积分由服务器保留，现在可以在新电脑输入同一个激活码重新绑定。${localCleanupWarning}`,
    status: {
      ...toStatus(null, deviceId),
      message: '本机已解除绑定，可在新电脑使用同一个激活码。'
    },
    unbindId: result.unbindId || licenseId
  }
}

export function canStartLicensedAnalysis(): LicenseUsageResult {
  const status = getActivationStatus()
  if (!status.activated) return { ok: false, message: status.message || '软件授权不可用，请重新激活。', status }
  if (status.licenseType === 'credits' && (status.creditsRemaining ?? 0) <= 0) {
    return { ok: false, message: '积分已用完，请联系管理员获取新的激活码。', status }
  }
  return { ok: true, message: '授权可用。', status }
}

export function consumeAnalysisCredit(operationId: string): LicenseUsageResult {
  const before = canStartLicensedAnalysis()
  if (!before.ok) return before
  const record = readStoredActivation()
  if (!record || record.version !== 2 || record.licenseType !== 'credits' || record.unlimited) {
    return { ok: true, message: '无限授权，不扣积分。', status: before.status }
  }
  const id = operationId.trim().slice(0, 128)
  if (!id) return { ok: false, message: '本次分析标识无效，未扣积分。', status: before.status }
  const used = record.usedOperationIds || []
  if (used.includes(id)) return { ok: true, message: '本次分析已经扣过积分。', status: before.status }
  const remaining = Math.max(0, (record.creditsRemaining ?? 0) - 1)
  const updated: ServerStoredActivation = {
    ...record,
    creditsRemaining: remaining,
    usedOperationIds: [...used, id].slice(-500),
    serverMessage: `本次完整报告已使用 1 积分，剩余 ${remaining} 积分。`
  }
  writeStoredActivation(updated)
  return { ok: true, message: updated.serverMessage || '积分已扣减。', status: toStatus(updated) }
}

export function getActivationFilePath(): string {
  return ACTIVATION_FILE()
}
