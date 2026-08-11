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
  LICENSE_DEACTIVATE_URL,
  LICENSE_OFFLINE_GRACE_MS,
  LICENSE_TRANSFER_CLAIM_URL,
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
  pointsGrantId?: string
  pointsGrantPoints?: number
  pointsGrantKind?: 'device_transfer'
  pointsSyncPending?: boolean
  revokedReason?: string
  serverMessage?: string
}

type StoredActivation = LegacyStoredActivation | ServerStoredActivation

interface ServerLicense {
  ok: boolean
  message: string
  unavailable: boolean
  appNotProvisioned: boolean
  licenseId?: string
  licenseType: 'credits' | 'unlimited' | 'standard'
  unlimited: boolean
  creditsRemaining?: number
  expiresAt?: string
}

interface DeviceTransferClaim {
  ok: boolean
  supported: boolean
  unavailable: boolean
  message: string
  transferId?: string
  points?: number
}

interface ServerDeactivation {
  ok: boolean
  unavailable: boolean
  message: string
  transferId?: string
  points?: number
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
  if (!Number.isFinite(number) || Math.abs(number) > 10_000_000) return undefined
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

  const bundledLegacy = allowedCodeHashes.has(record.codeHash)
  const remaining = bundledLegacy ? LEGACY_ACTIVATION_POINTS : record.creditsRemaining
  const licenseType = bundledLegacy ? 'credits' : record.licenseType
  const unlimited = bundledLegacy ? false : record.unlimited
  const offline = record.source === 'server' && Boolean(record.offlineSince)
  const offlineExpired = record.source === 'server' && Boolean(record.offlineUntil) && Date.now() > Date.parse(record.offlineUntil || '')
  const valid =
    record.appName === LICENSE_APP_NAME &&
    !record.revokedReason &&
    !isExpired(record.expiresAt) &&
    !offlineExpired &&
    (record.source === 'server' || allowedCodeHashes.has(record.codeHash))

  let message = record.serverMessage
  if (record.revokedReason) message = record.revokedReason
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
    source: record.source,
    licenseType,
    unlimited,
    creditsRemaining: remaining,
    expiresAt: record.expiresAt,
    offline,
    offlineUntil: record.offlineUntil,
    pointsGrantId: record.pointsGrantId,
    pointsGrantPoints: record.pointsGrantPoints,
    pointsGrantKind: record.pointsGrantKind,
    pointsSyncPending: record.pointsSyncPending,
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

function normalizeServerMessage(value: unknown, fallback: string): string {
  const message = asString(value)?.replace(/\s+/g, ' ').slice(0, 240)
  return message || fallback
}

export function shouldAllowLegacyFallback(
  message: string,
  unavailable: boolean,
  appNotProvisioned: boolean
): boolean {
  if (unavailable || appNotProvisioned) return true
  return /不存在|尚未导入|未导入|找不到|not[ -]?found|not[ -]?imported|unknown[ _-]?code/i.test(message)
}

function parseServerLicense(body: Record<string, unknown>, httpOk: boolean): ServerLicense {
  const payload = pickPayload(body)
  const message = normalizeServerMessage(
    pickFirst(payload, body, ['message', 'error', 'detail', 'msg']),
    httpOk ? '激活成功。' : '激活码校验失败。'
  )
  const explicitOk = pickFirst(payload, body, ['ok', 'success', 'activated', 'valid'])
  const status = String(pickFirst(payload, body, ['status', 'license_status']) || '').toLowerCase()
  const rejectedStatus = ['disabled', 'expired', 'invalid', 'revoked', 'blocked', 'machine_mismatch'].some((item) => status.includes(item))
  const appNotProvisioned = /客户端应用不匹配|app(?:lication)?[^\w]*(?:mismatch|unknown|invalid)/i.test(message)
  const ok = httpOk && explicitOk !== false && explicitOk !== 0 && explicitOk !== 'false' && !rejectedStatus

  const typeText = String(pickFirst(payload, body, ['license_type', 'type', 'code_type']) || '').toLowerCase()
  const unlimited =
    asBoolean(pickFirst(payload, body, ['unlimited', 'is_unlimited', 'permanent'])) === true ||
    /unlimited|permanent|lifetime|无限|永久/.test(typeText)
  const creditsRemaining = asFiniteNumber(
    pickFirst(payload, body, ['remaining_credits', 'credits_remaining', 'credits', 'points', 'balance', 'quota'])
  )
  const licenseType: ServerLicense['licenseType'] = unlimited
    ? 'unlimited'
    : creditsRemaining !== undefined || /credit|point|积分/.test(typeText)
      ? 'credits'
      : 'standard'

  return {
    ok,
    message,
    unavailable: false,
    appNotProvisioned,
    licenseId: asString(pickFirst(payload, body, ['license_id', 'code_id', 'id', 'activation_id'])),
    licenseType,
    unlimited,
    creditsRemaining,
    expiresAt: asString(pickFirst(payload, body, ['expires_at', 'expiresAt', 'expiry', 'valid_until']))
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
      appNotProvisioned: false,
      licenseType: 'standard',
      unlimited: false
    }
  } finally {
    clearTimeout(timer)
  }
}

async function requestDeviceTransferClaim(
  code: string,
  deviceId: string,
  licenseId?: string
): Promise<DeviceTransferClaim> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS)
  try {
    const response = await fetch(LICENSE_TRANSFER_CLAIM_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        app_name: LICENSE_APP_NAME,
        activation_code: code,
        machine_code: deviceId,
        license_id: licenseId,
        software_version: app.getVersion(),
        platform: `${process.platform}-${process.arch}`,
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
      body = {}
    }
    if (response.status === 404) {
      return {
        ok: true,
        supported: false,
        unavailable: false,
        message: '当前授权服务尚未启用积分迁移接口。'
      }
    }
    const payload = pickPayload(body)
    const message = normalizeServerMessage(
      pickFirst(payload, body, ['message', 'error', 'detail', 'msg']),
      response.ok ? '积分迁移状态已确认。' : `积分迁移确认失败（${response.status}）。`
    )
    const explicitOk = pickFirst(payload, body, ['ok', 'success'])
    const ok = response.ok && explicitOk !== false && explicitOk !== 0 && explicitOk !== 'false'
    const available = asBoolean(
      pickFirst(payload, body, ['transfer_available', 'available', 'has_transfer'])
    ) === true
    const transferId = available
      ? asString(pickFirst(payload, body, ['transfer_id', 'id']))
      : undefined
    const points = available
      ? asFinitePoints(pickFirst(payload, body, ['points_balance', 'points', 'balance']))
      : undefined
    return {
      ok,
      supported: true,
      unavailable: response.status >= 500,
      message,
      transferId: ok && available ? transferId : undefined,
      points: ok && available ? points : undefined
    }
  } catch (error) {
    const timeout = error instanceof Error && error.name === 'AbortError'
    return {
      ok: false,
      supported: true,
      unavailable: true,
      message: timeout ? '同步换机积分超时，请保持联网后重试。' : '暂时无法同步换机积分，请保持联网后重试。'
    }
  } finally {
    clearTimeout(timer)
  }
}

function withTransferClaim(record: ServerStoredActivation, claim: DeviceTransferClaim): ServerStoredActivation {
  if (!claim.supported) {
    return {
      ...record,
      pointsSyncPending: false,
      serverMessage: record.serverMessage
    }
  }
  if (!claim.ok) {
    return {
      ...record,
      pointsSyncPending: true,
      serverMessage: claim.message
    }
  }
  if (claim.transferId && claim.points !== undefined) {
    return {
      ...record,
      pointsGrantId: claim.transferId,
      pointsGrantPoints: claim.points,
      pointsGrantKind: 'device_transfer',
      pointsSyncPending: false,
      serverMessage: `换机成功，已恢复 ${claim.points} 积分。`
    }
  }
  return {
    ...record,
    pointsSyncPending: false
  }
}

async function requestServerDeactivation(
  code: string,
  deviceId: string,
  licenseId: string | undefined,
  pointsBalance: number
): Promise<ServerDeactivation> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS)
  try {
    const response = await fetch(LICENSE_DEACTIVATE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        app_name: LICENSE_APP_NAME,
        activation_code: code,
        machine_code: deviceId,
        license_id: licenseId,
        points_balance: asFinitePoints(pointsBalance) ?? 0,
        software_version: app.getVersion(),
        platform: `${process.platform}-${process.arch}`,
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
      body = {}
    }
    const payload = pickPayload(body)
    const unavailable = response.status === 404 || response.status >= 500
    const fallback = response.status === 404
      ? '服务器尚未开通换设备功能，请联系管理员更新授权服务。'
      : response.ok
        ? '本机已解除绑定。'
        : `解除绑定失败（${response.status}）。`
    const message = normalizeServerMessage(
      pickFirst(payload, body, ['message', 'error', 'detail', 'msg']),
      fallback
    )
    const explicitOk = pickFirst(payload, body, ['ok', 'success', 'deactivated'])
    const ok = response.ok && explicitOk !== false && explicitOk !== 0 && explicitOk !== 'false'
    return {
      ok,
      unavailable,
      message,
      transferId: ok ? asString(pickFirst(payload, body, ['transfer_id', 'id'])) : undefined,
      points: ok
        ? asFinitePoints(pickFirst(payload, body, ['points_balance', 'points', 'balance']))
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
  if (!code) {
    const revoked = { ...current, revokedReason: '本地授权记录不完整，请重新输入激活码。' }
    writeStoredActivation(revoked)
    return toStatus(revoked, deviceId)
  }

  const result = await requestServerActivation(code, deviceId)
  if (result.ok) {
    const now = new Date()
    const bundledLegacy = allowedCodeHashes.has(current.codeHash)
    const serverRemaining = result.creditsRemaining
    const currentRemaining = current.creditsRemaining
    const creditsRemaining =
      bundledLegacy
        ? LEGACY_ACTIVATION_POINTS
        : serverRemaining === undefined
        ? currentRemaining
        : currentRemaining === undefined
          ? serverRemaining
          : Math.min(currentRemaining, serverRemaining)
    const baseUpdated: ServerStoredActivation = {
      ...current,
      source: 'server',
      licenseId: bundledLegacy ? legacyLicenseId(current.codeHash) : result.licenseId || current.licenseId,
      licenseType: bundledLegacy ? 'credits' : result.licenseType,
      unlimited: bundledLegacy ? false : result.unlimited,
      creditsRemaining,
      expiresAt: result.expiresAt,
      lastValidatedAt: now.toISOString(),
      offlineUntil: new Date(now.getTime() + LICENSE_OFFLINE_GRACE_MS).toISOString(),
      offlineSince: undefined,
      revokedReason: undefined,
      serverMessage: result.message
    }
    const claim = await requestDeviceTransferClaim(
      code,
      deviceId,
      baseUpdated.licenseId
    )
    const updated = withTransferClaim(baseUpdated, claim)
    writeStoredActivation(updated)
    return toStatus(updated, deviceId)
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
  const bundledLegacy = allowedCodeHashes.has(codeHash)
  const server = await requestServerActivation(enteredCode, deviceId)
  if (server.ok) {
    const now = new Date()
    const baseRecord: ServerStoredActivation = {
      version: 2,
      appName: LICENSE_APP_NAME,
      source: 'server',
      codeHash,
      encryptedCode: encryptActivationCode(enteredCode, deviceId),
      deviceId,
      activatedAt: now.toISOString(),
      licenseId: bundledLegacy ? legacyLicenseId(codeHash) : server.licenseId,
      licenseType: bundledLegacy ? 'credits' : server.licenseType,
      unlimited: bundledLegacy ? false : server.unlimited,
      creditsRemaining: bundledLegacy ? LEGACY_ACTIVATION_POINTS : server.creditsRemaining,
      usedOperationIds: [],
      expiresAt: server.expiresAt,
      lastValidatedAt: now.toISOString(),
      offlineUntil: new Date(now.getTime() + LICENSE_OFFLINE_GRACE_MS).toISOString(),
      offlineSince: undefined,
      serverMessage: server.message
    }
    const claim = await requestDeviceTransferClaim(
      enteredCode,
      deviceId,
      baseRecord.licenseId
    )
    const record = withTransferClaim(baseRecord, claim)
    writeStoredActivation(record)
    const status = toStatus(record, deviceId)
    return {
      ok: status.activated,
      message: status.activated ? record.serverMessage || server.message : status.message || server.message,
      status
    }
  }

  if (
    bundledLegacy &&
    shouldAllowLegacyFallback(server.message, server.unavailable, server.appNotProvisioned)
  ) {
    const record: ServerStoredActivation = {
      version: 2,
      appName: LICENSE_APP_NAME,
      source: 'legacy',
      codeHash,
      encryptedCode: encryptActivationCode(enteredCode, deviceId),
      deviceId,
      activatedAt: new Date().toISOString(),
      licenseId: legacyLicenseId(codeHash),
      licenseType: 'credits',
      unlimited: false,
      creditsRemaining: LEGACY_ACTIVATION_POINTS,
      serverMessage: server.appNotProvisioned
        ? `旧版激活码已兼容启用并发放 ${LEGACY_ACTIVATION_POINTS} 积分；服务器开通后可重新输入该码完成绑定。`
        : server.unavailable
          ? `网络不可用，旧版激活码已启用并发放 ${LEGACY_ACTIVATION_POINTS} 积分。`
          : `旧版激活码已兼容启用并发放 ${LEGACY_ACTIVATION_POINTS} 积分；即使服务器尚未导入该旧码，本机授权仍然可用。`
    }
    writeStoredActivation(record)
    return { ok: true, message: record.serverMessage || '激活成功。', status: toStatus(record, deviceId) }
  }

  return { ok: false, message: server.message, status: currentStatus }
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

export async function deactivateCurrentDevice(pointsBalance: number): Promise<ActivationDeactivationResult> {
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
    return {
      ok: false,
      message: '这是旧版授权记录，请先在积分中心重新输入原激活码，再使用换设备功能。',
      status: currentStatus
    }
  }
  const code = decryptActivationCode(record.encryptedCode, deviceId)
  if (!code) {
    return {
      ok: false,
      message: '本地授权记录不完整，无法安全解除绑定，请联系管理员。',
      status: currentStatus
    }
  }

  let licenseId = record.licenseId
  if (record.source === 'legacy') {
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
  }

  const safeBalance = asFinitePoints(pointsBalance) ?? 0
  const result = await requestServerDeactivation(code, deviceId, licenseId, safeBalance)
  if (!result.ok) {
    return { ok: false, message: result.message, status: currentStatus }
  }
  if (!result.transferId) {
    return {
      ok: false,
      message: '服务器没有返回积分转移凭证，为避免积分丢失，本机仍保持激活，请联系管理员。',
      status: currentStatus
    }
  }

  try {
    clearStoredActivation()
  } catch {
    return {
      ok: false,
      message: '服务器已解除绑定，但本机授权文件未能清理。请重启软件后重试；不要立即在新电脑激活。',
      status: currentStatus,
      transferId: result.transferId,
      transferredPoints: result.points ?? safeBalance
    }
  }
  const transferredPoints = result.points ?? safeBalance
  return {
    ok: true,
    message: `本机已解除绑定，${transferredPoints} 积分已准备转移。现在可以在新电脑输入同一个激活码。`,
    status: {
      ...toStatus(null, deviceId),
      message: '本机已解除绑定，可在新电脑使用同一个激活码。'
    },
    transferId: result.transferId,
    transferredPoints
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
