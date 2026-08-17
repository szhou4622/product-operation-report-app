import { app, safeStorage } from 'electron'
import { execFileSync } from 'child_process'
import { createDecipheriv, createHash } from 'crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { arch, hostname, platform, userInfo } from 'os'
import type {
  ActivationCodeAccessResult,
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
import {
  clearLicenseVault,
  getOrCreateFallbackMachineSeed,
  readLicenseVault,
  readStoredMachineCode,
  writeLicenseVault,
  writeStoredMachineCode,
  type LicenseVaultContents
} from './licenseVault'

const LICENSE_PROTOCOL_VERSION = 2
const ACTIVATION_FILE = (): string => join(app.getPath('userData'), 'activation.json')
const ACTIVATION_BACKUP_FILE = (): string => `${ACTIVATION_FILE()}.bak`
const CODE_NAMESPACE = 'product-operation-report:activation:v1:'
// v0.3.5 briefly shipped the v2 namespace. Both results are recognized below,
// then the selected machine code is kept in the OS-encrypted device vault so a
// restart, upgrade or local authorization reset cannot silently change it.
const DEVICE_NAMESPACE = 'product-operation-report:device:v1:'
const TRANSITIONAL_DEVICE_NAMESPACE = 'product-operation-report:device:v2:'
const OLD_DEVICE_NAMESPACE = DEVICE_NAMESPACE
const OLD_ENCRYPTION_NAMESPACE = 'product-operation-report:server-code:v1:'
const allowedCodeHashes = new Set<string>(ACTIVATION_CODE_HASHES)
export const LEGACY_ACTIVATION_POINTS = 2_000

let cachedSystemMachineId: string | undefined
let cachedLegacyDeviceId = ''
let cachedTransitionalDeviceId = ''
let cachedDeviceId = ''
let serverValidatedThisRun = false

interface LegacyStoredActivation {
  version: 1
  codeHash: string
  deviceId: string
  activatedAt: string
}

interface ServerStoredActivation {
  version: 2 | 3
  appName: string
  source: 'server' | 'legacy'
  codeHash: string
  deviceId: string
  activatedAt: string
  licenseId?: string
  licenseType: 'credits' | 'unlimited' | 'standard'
  unlimited: boolean
  creditsRemaining?: number
  expiresAt?: string
  lastValidatedAt?: string
  offlineUntil?: string
  offlineSince?: string
  bindingStatus?: 'active' | 'unbound'
  transferCount?: number
  activationCodeStored?: boolean
  maskedActivationCode?: string
  revokedReason?: string
  serverMessage?: string
  requiresRevalidation?: boolean
  // v0.3.5 and earlier only. These fields are migrated into license-vault.bin and removed.
  encryptedCode?: string
  encryptedDeviceCredential?: string
  encryptedDeviceSession?: string
  usedOperationIds?: string[]
}

type StoredActivation = LegacyStoredActivation | ServerStoredActivation

interface ServerLicense {
  ok: boolean
  unavailable: boolean
  unauthorized: boolean
  contractInvalid?: boolean
  credentialRefreshRequired?: boolean
  message: string
  licenseId?: string
  licenseType: 'credits' | 'unlimited' | 'standard'
  unlimited: boolean
  creditsRemaining?: number
  expiresAt?: string
  deviceCredential?: string
  deviceSession?: string
  bindingStatus?: 'active' | 'unbound'
  transferCount?: number
  grantScore?: number
  action?: string
  primaryLicenseId?: string
  mergedLicenseId?: string
}

interface ServerDeviceUnbind {
  ok: boolean
  unavailable: boolean
  unauthorized: boolean
  message: string
  unbindId?: string
}

interface ActivationRequestOptions {
  currentCodeId?: string
  credentialRefresh?: boolean
  confirmMerge?: boolean
  deviceCredential?: string
  deviceSession?: string
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
  try {
    const output = execFileSync(
      'reg',
      ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
      { encoding: 'utf8', timeout: 2_000, windowsHide: true }
    )
    return output.match(/MachineGuid\s+REG_SZ\s+([^\r\n]+)/i)?.[1]?.trim() || ''
  } catch {
    return ''
  }
}

function getSystemMachineId(): string {
  if (cachedSystemMachineId !== undefined) return cachedSystemMachineId
  if (process.platform === 'win32') cachedSystemMachineId = getWindowsMachineGuid()
  else if (process.platform === 'darwin') {
    try {
      const output = execFileSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
        encoding: 'utf8',
        timeout: 2_500
      })
      cachedSystemMachineId = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/i)?.[1]?.trim() || ''
    } catch {
      cachedSystemMachineId = ''
    }
  } else {
    try {
      cachedSystemMachineId = readFileSync('/etc/machine-id', 'utf8').trim()
    } catch {
      cachedSystemMachineId = ''
    }
  }
  return cachedSystemMachineId
}

/** Used only to recognize and migrate a pre-v2 local record. Never used for a new machine code. */
function getLegacyDeviceId(): string {
  if (cachedLegacyDeviceId) return cachedLegacyDeviceId
  let user = ''
  try {
    user = userInfo().username
  } catch {
    user = ''
  }
  const seed = [platform(), arch(), hostname(), user, getWindowsMachineGuid()].join('|')
  cachedLegacyDeviceId = sha256(`${OLD_DEVICE_NAMESPACE}${seed}`).slice(0, 32)
  return cachedLegacyDeviceId
}

/** Recognizes records created by unreleased protocol-v2 development builds. */
function getTransitionalDeviceId(): string {
  if (cachedTransitionalDeviceId) return cachedTransitionalDeviceId
  const systemId = getSystemMachineId()
  if (!systemId) return ''
  cachedTransitionalDeviceId = sha256(
    `${TRANSITIONAL_DEVICE_NAMESPACE}${process.platform}-system-id|${systemId}`
  ).slice(0, 32)
  return cachedTransitionalDeviceId
}

export function getDeviceId(): string {
  if (cachedDeviceId) return cachedDeviceId
  const systemId = getSystemMachineId()
  const stableSeed = systemId || getOrCreateFallbackMachineSeed()
  const kind = systemId
    ? process.platform === 'win32'
      ? 'windows-machine-guid'
      : `${process.platform}-hardware-id`
    : 'secure-random-device-seed'
  const canonicalDeviceId = sha256(`${DEVICE_NAMESPACE}${kind}|${stableSeed}`).slice(0, 32)

  // A server-bound record must keep the exact machine code it was activated
  // with. This preserves both the released v1 id and the short-lived v2
  // development id without weakening the server's device binding.
  const stored = readStoredActivation()
  const compatibleIds = new Set([
    canonicalDeviceId,
    getLegacyDeviceId(),
    getTransitionalDeviceId()
  ].filter(Boolean))
  const vaultedDeviceId = readStoredMachineCode()
  cachedDeviceId = stored && compatibleIds.has(stored.deviceId)
    ? stored.deviceId
    : vaultedDeviceId && compatibleIds.has(vaultedDeviceId)
      ? vaultedDeviceId
      : canonicalDeviceId

  // Keep device identity independent from activation credentials. Unbinding
  // clears license-vault.bin, but deliberately leaves device-vault.bin intact.
  if (vaultedDeviceId !== cachedDeviceId) {
    try {
      writeStoredMachineCode(cachedDeviceId)
    } catch {
      // A hardware-derived id remains deterministic even if the operating
      // system credential store is temporarily unavailable. Credential writes
      // still fail closed later during activation.
    }
  }
  return cachedDeviceId
}

function asString(value: unknown, maxLength = 8_192): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed && trimmed.length <= maxLength ? trimmed : undefined
}

function asNonnegativeNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 10_000_000) return undefined
  return Math.round(value * 1_000) / 1_000
}

function asNonnegativeInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return undefined
  return value
}

function normalizeMessage(value: unknown, fallback: string): string {
  return asString(value, 500)?.replace(/\s+/g, ' ') || fallback
}

function normalizeBindingStatus(value: unknown): 'active' | 'unbound' | undefined {
  if (value === 'active' || value === 'bound') return 'active'
  if (value === 'unbound') return 'unbound'
  return undefined
}

const LICENSE_RESPONSE_FIELDS = [
  'app_name',
  'code_id',
  'license_type',
  'remaining_credits',
  'remaining_points',
  'unlimited',
  'binding_status',
  'transfer_count',
  'machine_code',
  'expires_at',
  'device_credential',
  'device_session',
  'action',
  'primary_code_id',
  'merged_code_id'
] as const

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function selectServerLicensePayload(body: Record<string, unknown>): {
  payload?: Record<string, unknown>
  conflict?: boolean
} {
  if (body.license === undefined) return { payload: body }
  const nested = asRecord(body.license)
  if (!nested) return { conflict: true }

  // The production activation endpoint returns an explicit `license` envelope,
  // while device/status returns the license at the top level. Never recursively
  // search arbitrary response objects: request echoes must not become authority.
  for (const field of LICENSE_RESPONSE_FIELDS) {
    if (body[field] !== undefined && nested[field] !== undefined && body[field] !== nested[field]) {
      return { conflict: true }
    }
  }
  const data = body.data === undefined ? undefined : asRecord(body.data)
  if (body.data !== undefined && !data) return { conflict: true }
  if (
    data?.app_name !== undefined &&
    nested.app_name !== undefined &&
    data.app_name !== nested.app_name
  ) return { conflict: true }

  const payload = { ...nested }
  for (const field of ['action', 'grant_score', 'primary_code_id', 'merged_code_id'] as const) {
    if (body[field] !== undefined) payload[field] = body[field]
  }
  return { payload }
}

function oldEncryptionKey(deviceId: string): Buffer {
  return createHash('sha256').update(`${OLD_ENCRYPTION_NAMESPACE}${deviceId}`, 'utf8').digest()
}

function decryptOldSecret(value: string | undefined, deviceId: string): string | undefined {
  if (!value) return undefined
  if (value.startsWith('v2safe:')) {
    if (!safeStorage.isEncryptionAvailable()) return undefined
    try {
      return safeStorage.decryptString(Buffer.from(value.slice('v2safe:'.length), 'base64'))
    } catch {
      return undefined
    }
  }
  try {
    const [version, ivValue, tagValue, encryptedValue] = value.split(':')
    if (version !== 'v1' || !ivValue || !tagValue || !encryptedValue) return undefined
    const decipher = createDecipheriv('aes-256-gcm', oldEncryptionKey(deviceId), Buffer.from(ivValue, 'base64url'))
    decipher.setAuthTag(Buffer.from(tagValue, 'base64url'))
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedValue, 'base64url')),
      decipher.final()
    ]).toString('utf8')
  } catch {
    return undefined
  }
}

function parseStoredActivationText(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    // A v0.3.x build could leave a truncated/mojibake serverMessage as the last
    // property. Recover only that known tail; all required fields are still
    // validated below and no credential value is fabricated.
    const marker = text.lastIndexOf('"serverMessage"')
    const comma = marker >= 0 ? text.lastIndexOf(',', marker) : -1
    if (comma < 0) return null
    try {
      const repaired = JSON.parse(`${text.slice(0, comma).trimEnd()}\n}`) as unknown
      if (!repaired || typeof repaired !== 'object' || Array.isArray(repaired)) return null
      const record = repaired as Record<string, unknown>
      return record.version === 2 ? record : null
    } catch {
      return null
    }
  }
}

function readStoredActivationFile(file: string): StoredActivation | null {
  if (!existsSync(file)) return null
  try {
    const parsed = parseStoredActivationText(readFileSync(file, 'utf8'))
    if (!parsed) return null
    if (
      parsed.version === 1 &&
      typeof parsed.codeHash === 'string' &&
      typeof parsed.deviceId === 'string' &&
      typeof parsed.activatedAt === 'string'
    ) return parsed as unknown as LegacyStoredActivation
    if (
      (parsed.version === 2 || parsed.version === 3) &&
      parsed.appName === LICENSE_APP_NAME &&
      (parsed.source === 'server' || parsed.source === 'legacy') &&
      typeof parsed.codeHash === 'string' &&
      typeof parsed.deviceId === 'string' &&
      typeof parsed.activatedAt === 'string' &&
      (parsed.licenseType === 'credits' || parsed.licenseType === 'unlimited' || parsed.licenseType === 'standard') &&
      typeof parsed.unlimited === 'boolean'
    ) return parsed as unknown as ServerStoredActivation
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
      rmSync(backupTemp, { force: true })
    }
  } finally {
    rmSync(temp, { force: true })
    rmSync(backupTemp, { force: true })
  }
}

function clearStoredActivation(): void {
  for (const file of [
    ACTIVATION_FILE(),
    ACTIVATION_BACKUP_FILE(),
    `${ACTIVATION_FILE()}.tmp`,
    `${ACTIVATION_BACKUP_FILE()}.tmp`
  ]) rmSync(file, { force: true })
}

function sanitizedServerRecord(record: ServerStoredActivation): ServerStoredActivation {
  const sanitized: ServerStoredActivation = {
    ...record,
    version: 3,
    encryptedCode: undefined,
    encryptedDeviceCredential: undefined,
    encryptedDeviceSession: undefined,
    usedOperationIds: undefined
  }
  return sanitized
}

function migrateEmbeddedSecrets(record: ServerStoredActivation): LicenseVaultContents | null {
  const existing = readLicenseVault()
  if (existing) {
    if (
      record.version === 2 ||
      record.encryptedCode ||
      record.encryptedDeviceCredential ||
      record.encryptedDeviceSession ||
      record.activationCodeStored !== Boolean(existing.activationCode) ||
      (!record.maskedActivationCode && existing.activationCode)
    ) {
      writeStoredActivation({
        ...sanitizedServerRecord(record),
        activationCodeStored: Boolean(existing.activationCode),
        maskedActivationCode: existing.activationCode ? maskActivationCode(existing.activationCode) : undefined
      })
    }
    return existing
  }
  const code = decryptOldSecret(record.encryptedCode, record.deviceId)
  const deviceCredential = decryptOldSecret(record.encryptedDeviceCredential, record.deviceId)
  const deviceSession = decryptOldSecret(record.encryptedDeviceSession, record.deviceId)
  if (!code && !deviceCredential && !deviceSession) return null
  const migrated = { activationCode: code, deviceCredential, deviceSession }
  writeLicenseVault(migrated)
  writeStoredActivation({
    ...sanitizedServerRecord(record),
    activationCodeStored: Boolean(code),
    maskedActivationCode: code ? maskActivationCode(code) : undefined
  })
  return migrated
}

function recordMatchesDevice(record: StoredActivation, deviceId: string): boolean {
  return record.deviceId === deviceId ||
    record.deviceId === getLegacyDeviceId() ||
    record.deviceId === getTransitionalDeviceId()
}

function migrateRecordDevice(record: StoredActivation, deviceId: string): StoredActivation {
  if (record.deviceId === deviceId) return record
  const migrated = { ...record, deviceId } as StoredActivation
  writeStoredActivation(migrated)
  return migrated
}

function prepareServerRecord(
  stored: ServerStoredActivation,
  deviceId: string
): { record: ServerStoredActivation; vault: LicenseVaultContents | null } {
  // Old AES records derive their decryption key from the original device id,
  // so secrets must be migrated before any local device-id normalization.
  const vault = migrateEmbeddedSecrets(stored)
  const sanitized = readStoredActivation()
  const source = sanitized && sanitized.version !== 1 && recordMatchesDevice(sanitized, deviceId)
    ? sanitized
    : stored
  return {
    record: migrateRecordDevice(source, deviceId) as ServerStoredActivation,
    vault
  }
}

function isExpired(expiresAt?: string): boolean {
  if (!expiresAt) return false
  const timestamp = Date.parse(expiresAt)
  return Number.isFinite(timestamp) && timestamp <= Date.now()
}

function legacyLicenseId(codeHash: string): string {
  return `LEGACY-${codeHash.slice(0, 12).toUpperCase()}`
}

function activationCodeAvailable(record: StoredActivation): boolean {
  if (record.version === 1) return false
  return Boolean(record.activationCodeStored)
}

function maskedStoredActivationCode(record: StoredActivation): string | undefined {
  if (record.version === 1) return undefined
  return record.maskedActivationCode
}

function savedCodeRecoveryStatus(deviceId = getDeviceId(), message?: string): ActivationStatus {
  const savedCode = readLicenseVault()?.activationCode
  const base = toStatus(null, deviceId)
  if (!savedCode) return { ...base, message }
  return {
    ...base,
    activationCodeAvailable: true,
    maskedActivationCode: maskActivationCode(savedCode),
    requiresRevalidation: true,
    message: message || '检测到本机已安全保存的原激活码，可以直接重新验证。'
  }
}

function friendlyActivationFailure(message: string): string {
  const normalized = message.trim()
  if (/credential_refresh|旧授权首次升级设备凭证/i.test(normalized)) {
    return '检测到旧版授权，但自动升级没有完成。请检查网络后重试；仍失败时把设备码发给管理员。'
  }
  if (/当前电脑已有主激活码|合并积分前必须明确确认|confirm_merge/i.test(normalized)) {
    return '这台电脑已有主激活码。请使用已保存的原激活码进入；新积分码请进入软件后在积分页面充值。'
  }
  if (/device_session|device_credential|设备凭证丢失|不能覆盖已有凭证/i.test(normalized)) {
    return '本机授权凭证需要重新验证。请使用已保存的原激活码重试，或把设备码发给管理员。'
  }
  if (/\/api\/license\//i.test(normalized)) {
    return '授权服务暂时无法完成当前操作，请稍后重试；仍失败时把设备码发给管理员。'
  }
  return normalized || '激活失败，请检查激活码和网络后重试。'
}

function toStatus(record: StoredActivation | null, deviceId = getDeviceId()): ActivationStatus {
  const common = {
    deviceId,
    codeCount: ACTIVATION_CODE_COUNT,
    appName: LICENSE_APP_NAME,
    unlimited: false,
    offline: false,
    activationCodeAvailable: false,
    requiresRevalidation: false
  }
  if (!record || !recordMatchesDevice(record, deviceId)) return { ...common, activated: false }
  if (record.version === 1) {
    const valid = allowedCodeHashes.has(record.codeHash) && !app.isPackaged
    return {
      ...common,
      activated: valid,
      activatedAt: valid ? record.activatedAt : undefined,
      licenseId: valid ? legacyLicenseId(record.codeHash) : undefined,
      source: 'legacy',
      licenseType: 'credits',
      creditsRemaining: valid ? LEGACY_ACTIVATION_POINTS : undefined,
      requiresRevalidation: true,
      message: '旧版授权需要重新输入原激活码，完成服务器凭证升级。'
    }
  }
  const remaining = record.creditsRemaining
  const revoked = Boolean(record.revokedReason) || record.bindingStatus === 'unbound' || isExpired(record.expiresAt)
  const requiresRevalidation = record.source === 'server'
    ? !serverValidatedThisRun || Boolean(record.requiresRevalidation)
    : true
  let message = record.serverMessage
  if (record.bindingStatus === 'unbound') message = '本机已解除绑定，可在新电脑输入原激活码。'
  else if (record.revokedReason) message = record.revokedReason
  else if (isExpired(record.expiresAt)) message = '授权已过期，请联系管理员。'
  else if (record.unlimited) message = record.serverMessage || '无限授权可用。'
  else if ((remaining ?? 0) <= 0) message = record.serverMessage || '积分不足，请充值后再生成新报告。'
  else if (requiresRevalidation) message = record.serverMessage || '正在验证服务器授权；历史报告仍可查看和导出。'
  return {
    ...common,
    activated: !revoked,
    activatedAt: record.activatedAt,
    licenseId: record.licenseId,
    activationCodeAvailable: activationCodeAvailable(record),
    maskedActivationCode: maskedStoredActivationCode(record),
    source: record.source,
    licenseType: record.licenseType,
    unlimited: record.unlimited,
    creditsRemaining: remaining,
    expiresAt: record.expiresAt,
    offline: Boolean(record.offlineSince),
    offlineUntil: record.offlineUntil,
    bindingStatus: record.bindingStatus,
    transferCount: record.transferCount,
    requiresRevalidation,
    lastServerSyncAt: record.lastValidatedAt,
    message
  }
}

function parseServerLicense(
  body: Record<string, unknown>,
  httpStatus: number,
  expectedMachineCode: string
): ServerLicense {
  const unavailable = httpStatus === 404 || httpStatus === 408 || httpStatus === 429 || httpStatus >= 500
  const unauthorized = httpStatus === 401
  const fallback = unauthorized
    ? '设备凭证已失效，请重新输入原激活码验证。'
    : unavailable
      ? '授权服务器暂时无法连接。'
      : httpStatus >= 200 && httpStatus < 300 && body.ok === true
        ? '授权验证成功。'
        : `授权校验失败（${httpStatus}）。`
  const message = normalizeMessage(body.message ?? body.error ?? body.detail, fallback)
  if (httpStatus < 200 || httpStatus >= 300 || body.ok !== true) {
    const errorCode = asString(body.error_code ?? body.code, 128)?.toLowerCase()
    const credentialRefreshRequired =
      errorCode === 'credential_refresh_required' ||
      /credential_refresh\s*=\s*true/i.test(message)
    return {
      ok: false,
      unavailable,
      unauthorized,
      credentialRefreshRequired,
      message,
      licenseType: 'standard',
      unlimited: false
    }
  }
  const selected = selectServerLicensePayload(body)
  if (selected.conflict || !selected.payload) {
    return { ok: false, unavailable: false, unauthorized: false, contractInvalid: true, message: '服务器授权响应存在冲突，已拒绝更新本地授权。', licenseType: 'standard', unlimited: false }
  }
  const license = selected.payload
  if (license.app_name !== LICENSE_APP_NAME) {
    return { ok: false, unavailable: false, unauthorized: false, contractInvalid: true, message: '服务器返回的软件标识不匹配。', licenseType: 'standard', unlimited: false }
  }
  const licenseId = asString(license.code_id, 256)
  const machineCode = asString(license.machine_code, 256)
  const bindingStatus = normalizeBindingStatus(license.binding_status)
  const unlimited = typeof license.unlimited === 'boolean' ? license.unlimited : undefined
  const transferCount = asNonnegativeInteger(license.transfer_count)
  const primaryRemaining = license.remaining_credits === undefined ? undefined : asNonnegativeNumber(license.remaining_credits)
  const legacyRemaining = license.remaining_points === undefined ? undefined : asNonnegativeNumber(license.remaining_points)
  if (
    !licenseId ||
    machineCode?.toLowerCase() !== expectedMachineCode.toLowerCase() ||
    !bindingStatus ||
    unlimited === undefined ||
    transferCount === undefined ||
    (primaryRemaining === undefined && legacyRemaining === undefined)
  ) {
    return { ok: false, unavailable: false, unauthorized: false, contractInvalid: true, message: '服务器授权响应缺少必要字段，已拒绝更新本地授权。', licenseType: 'standard', unlimited: false }
  }
  if (primaryRemaining !== undefined && legacyRemaining !== undefined && primaryRemaining !== legacyRemaining) {
    return { ok: false, unavailable: false, unauthorized: false, contractInvalid: true, message: '服务器返回了相互冲突的积分余额，已拒绝更新。', licenseType: 'standard', unlimited: false }
  }
  if (bindingStatus !== 'active') {
    return { ok: false, unavailable: false, unauthorized: false, message, licenseId, licenseType: 'standard', unlimited, creditsRemaining: primaryRemaining ?? legacyRemaining, bindingStatus, transferCount }
  }
  const licenseTypeText = asString(license.license_type, 64)?.toLowerCase() || ''
  const licenseType: ServerLicense['licenseType'] = unlimited
    ? 'unlimited'
    : licenseTypeText === 'standard' || licenseTypeText === 'credits' || licenseTypeText === 'points'
      ? 'credits'
      : 'credits'
  const grantScore = license.grant_score === undefined ? undefined : asNonnegativeNumber(license.grant_score)
  const action = asString(license.action, 64)
  const primaryLicenseId = asString(license.primary_code_id, 256)
  const mergedLicenseId = asString(license.merged_code_id, 256)
  if (action === 'rebound' && grantScore !== undefined && grantScore !== 0) {
    return { ok: false, unavailable: false, unauthorized: false, contractInvalid: true, message: '换机绑定响应异常：服务器不得重复赠送初始积分。', licenseType: 'standard', unlimited: false }
  }
  return {
    ok: true,
    unavailable: false,
    unauthorized: false,
    message,
    licenseId,
    licenseType,
    unlimited,
    creditsRemaining: primaryRemaining ?? legacyRemaining,
    expiresAt: asString(license.expires_at, 128),
    deviceCredential: asString(license.device_credential),
    deviceSession: asString(license.device_session),
    bindingStatus,
    transferCount,
    grantScore,
    action,
    primaryLicenseId,
    mergedLicenseId
  }
}

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await response.text()) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

async function requestServerActivation(
  code: string,
  deviceId: string,
  options: ActivationRequestOptions = {}
): Promise<ServerLicense> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS)
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' }
    if (options.deviceSession) headers.authorization = `Bearer ${options.deviceSession}`
    if (options.deviceCredential) headers['x-device-credential'] = options.deviceCredential
    const body: Record<string, unknown> = {
      license_protocol_version: LICENSE_PROTOCOL_VERSION,
      app_name: LICENSE_APP_NAME,
      activation_code: code,
      machine_code: deviceId,
      client_version: app.getVersion()
    }
    if (options.currentCodeId) body.current_code_id = options.currentCodeId
    if (options.credentialRefresh) body.credential_refresh = true
    if (options.confirmMerge) body.confirm_merge = true
    const response = await fetch(LICENSE_ACTIVATE_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    })
    return parseServerLicense(await responseBody(response), response.status, deviceId)
  } catch (error) {
    return {
      ok: false,
      unavailable: true,
      unauthorized: false,
      message: error instanceof Error && error.name === 'AbortError'
        ? '连接授权服务器超时。'
        : '授权服务器暂时无法连接。',
      licenseType: 'standard',
      unlimited: false
    }
  } finally {
    clearTimeout(timer)
  }
}

async function requestServerDeviceStatus(
  deviceId: string,
  licenseId: string,
  deviceCredential: string,
  deviceSession: string
): Promise<ServerLicense> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS)
  try {
    const url = new URL(LICENSE_DEVICE_STATUS_URL)
    url.searchParams.set('license_protocol_version', String(LICENSE_PROTOCOL_VERSION))
    url.searchParams.set('app_name', LICENSE_APP_NAME)
    url.searchParams.set('machine_code', deviceId)
    url.searchParams.set('code_id', licenseId)
    url.searchParams.set('client_version', app.getVersion())
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${deviceSession}`,
        'x-device-credential': deviceCredential
      },
      signal: controller.signal
    })
    return parseServerLicense(await responseBody(response), response.status, deviceId)
  } catch (error) {
    return {
      ok: false,
      unavailable: true,
      unauthorized: false,
      message: error instanceof Error && error.name === 'AbortError'
        ? '检查授权状态超时。'
        : '授权服务器暂时无法连接。',
      licenseType: 'standard',
      unlimited: false
    }
  } finally {
    clearTimeout(timer)
  }
}

async function requestServerDeviceUnbind(
  deviceId: string,
  licenseId: string,
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
        license_protocol_version: LICENSE_PROTOCOL_VERSION,
        app_name: LICENSE_APP_NAME,
        machine_code: deviceId,
        current_code_id: licenseId,
        client_version: app.getVersion()
      }),
      signal: controller.signal
    })
    const body = await responseBody(response)
    const unavailable = response.status === 404 || response.status === 408 || response.status === 429 || response.status >= 500
    const unauthorized = response.status === 401
    const bindingStatus = normalizeBindingStatus(body.binding_status)
    const ok = response.ok && body.ok === true && bindingStatus === 'unbound'
    return {
      ok,
      unavailable,
      unauthorized,
      message: normalizeMessage(
        body.message ?? body.error ?? body.detail,
        ok ? '本机已解除绑定。' : unauthorized ? '设备凭证已失效，请重新验证。' : '解除绑定失败。'
      ),
      unbindId: ok ? asString(body.unbind_id ?? body.operation_id, 256) : undefined
    }
  } catch (error) {
    return {
      ok: false,
      unavailable: true,
      unauthorized: false,
      message: error instanceof Error && error.name === 'AbortError'
        ? '连接授权服务器超时，本机仍保持绑定。'
        : '授权服务器暂时无法连接，本机仍保持绑定。'
    }
  } finally {
    clearTimeout(timer)
  }
}

function currentServerRecord(): { record: ServerStoredActivation; vault: LicenseVaultContents | null } | null {
  const deviceId = getDeviceId()
  const stored = readStoredActivation()
  if (!stored || stored.version === 1 || !recordMatchesDevice(stored, deviceId)) return null
  return prepareServerRecord(stored, deviceId)
}

function entitlementRecord(
  previous: ServerStoredActivation | null,
  code: string,
  deviceId: string,
  result: ServerLicense
): ServerStoredActivation {
  const now = new Date()
  return {
    version: 3,
    appName: LICENSE_APP_NAME,
    source: 'server',
    codeHash: hashActivationCode(code),
    deviceId,
    activatedAt: previous?.activatedAt || now.toISOString(),
    licenseId: result.licenseId,
    licenseType: result.licenseType,
    unlimited: result.unlimited,
    creditsRemaining: result.creditsRemaining,
    expiresAt: result.expiresAt,
    lastValidatedAt: now.toISOString(),
    offlineUntil: new Date(now.getTime() + LICENSE_OFFLINE_GRACE_MS).toISOString(),
    bindingStatus: result.bindingStatus || 'active',
    transferCount: result.transferCount,
    activationCodeStored: true,
    maskedActivationCode: maskActivationCode(code),
    serverMessage: result.message,
    requiresRevalidation: false
  }
}

export function getActivationStatus(): ActivationStatus {
  const deviceId = getDeviceId()
  const stored = readStoredActivation()
  if (!stored || !recordMatchesDevice(stored, deviceId)) return savedCodeRecoveryStatus(deviceId)
  if (stored.version === 1) return toStatus(migrateRecordDevice(stored, deviceId), deviceId)
  return toStatus(prepareServerRecord(stored, deviceId).record, deviceId)
}

/** Revalidate a securely stored primary code without exposing it to the renderer. */
export async function revalidateSavedActivationCode(): Promise<ActivationResult> {
  const code = readLicenseVault()?.activationCode
  if (!code) {
    const status = getActivationStatus()
    return { ok: false, message: '本机没有已保存的原激活码，请手动输入管理员发放的激活码。', status }
  }
  return activateWithCode(code)
}

export function revealCurrentActivationCode(): ActivationCodeAccessResult {
  const current = currentServerRecord()
  const code = current?.vault?.activationCode
  if (!code) return { ok: false, message: '本机没有可读取的原激活码，请重新输入原激活码完成验证。' }
  return { ok: true, message: '已读取当前激活码。', activationCode: code, maskedCode: maskActivationCode(code) }
}

export function maskActivationCode(code: string): string {
  if (code.length <= 8) return '••••••••'
  return `${code.slice(0, 4)}${'•'.repeat(Math.min(12, code.length - 8))}${code.slice(-4)}`
}

/** Main-process-only identity for the business proxy. */
export function getLicenseProxyIdentity(): {
  appName: string
  deviceId: string
  licenseId?: string
  deviceCredential: string
  deviceSession: string
  softwareVersion: string
  platform: string
} {
  const current = currentServerRecord()
  const status = getActivationStatus()
  if (!current || !status.activated || status.requiresRevalidation || !serverValidatedThisRun) {
    throw new Error(status.message || '请先完成服务器授权验证。')
  }
  if (!current.record.licenseId || !current.vault?.deviceCredential || !current.vault.deviceSession) {
    throw new Error('本机缺少设备凭证，请重新输入原激活码。')
  }
  return {
    appName: LICENSE_APP_NAME,
    deviceId: status.deviceId,
    licenseId: current.record.licenseId,
    deviceCredential: current.vault.deviceCredential,
    deviceSession: current.vault.deviceSession,
    softwareVersion: app.getVersion(),
    platform: `${process.platform}-${process.arch}`
  }
}

export async function getActivationStatusWithServerCheck(): Promise<ActivationStatus> {
  const deviceId = getDeviceId()
  const stored = readStoredActivation()
  if (!stored || !recordMatchesDevice(stored, deviceId) || stored.version === 1) {
    serverValidatedThisRun = false
    return getActivationStatus()
  }
  const prepared = prepareServerRecord(stored, deviceId)
  const current = prepared.record
  const vault = prepared.vault
  if (!current.licenseId || !vault?.activationCode) {
    const updated = { ...sanitizedServerRecord(current), requiresRevalidation: true, serverMessage: '本机授权记录不完整，请重新输入原激活码。' }
    writeStoredActivation(updated)
    serverValidatedThisRun = false
    return toStatus(updated, deviceId)
  }
  if ((!vault.deviceCredential || !vault.deviceSession) && (current.bindingStatus === 'unbound' || current.revokedReason)) {
    // A background status refresh must never rebind a device. Once credentials
    // are revoked, only the user's explicit saved-code or manual activation
    // action may call /activate again.
    serverValidatedThisRun = false
    return toStatus(current, deviceId)
  }
  const result = vault.deviceCredential && vault.deviceSession
    ? await requestServerDeviceStatus(deviceId, current.licenseId, vault.deviceCredential, vault.deviceSession)
    : await requestServerActivation(vault.activationCode, deviceId, {
        currentCodeId: current.licenseId,
        credentialRefresh: true
      })
  if (result.ok) {
    const credential = result.deviceCredential || vault.deviceCredential
    const session = result.deviceSession || vault.deviceSession
    if (!credential || !session) {
      const updated = { ...sanitizedServerRecord(current), requiresRevalidation: true, serverMessage: '服务器未返回完整设备凭证，请重新验证。' }
      writeStoredActivation(updated)
      serverValidatedThisRun = false
      return toStatus(updated, deviceId)
    }
    const updated = entitlementRecord(current, vault.activationCode, deviceId, result)
    writeLicenseVault({ activationCode: vault.activationCode, deviceCredential: credential, deviceSession: session })
    writeStoredActivation(updated)
    serverValidatedThisRun = true
    return toStatus(updated, deviceId)
  }
  serverValidatedThisRun = false
  if (result.bindingStatus === 'unbound') {
    let activationCodeStored = false
    try {
      if (vault.activationCode) {
        // Keep only the original code so the user can explicitly reactivate it.
        // Revoked device credentials must not survive an administrator unbind.
        writeLicenseVault({ activationCode: vault.activationCode })
        activationCodeStored = true
      } else {
        clearLicenseVault()
      }
    } catch {
      clearLicenseVault()
    }
    const message = result.message || '当前设备已在服务器解除绑定，请重新输入激活码。'
    const updated: ServerStoredActivation = {
      ...sanitizedServerRecord(current),
      bindingStatus: 'unbound',
      transferCount: result.transferCount ?? current.transferCount,
      creditsRemaining: result.creditsRemaining ?? current.creditsRemaining,
      lastValidatedAt: new Date().toISOString(),
      offlineSince: undefined,
      requiresRevalidation: true,
      revokedReason: message,
      serverMessage: message,
      activationCodeStored,
      maskedActivationCode: activationCodeStored && vault.activationCode
        ? maskActivationCode(vault.activationCode)
        : undefined
    }
    writeStoredActivation(updated)
    return toStatus(updated, deviceId)
  }
  if (result.unavailable) {
    const updated: ServerStoredActivation = {
      ...sanitizedServerRecord(current),
      offlineSince: new Date().toISOString(),
      requiresRevalidation: true,
      serverMessage: '授权服务器暂时无法连接；历史报告仍可查看和导出，暂不能生成新报告。'
    }
    writeStoredActivation(updated)
    return toStatus(updated, deviceId)
  }
  if (result.unauthorized) {
    let activationCodeStored = false
    try {
      if (vault.activationCode) {
        // A revoked device token returns to activation, while the original code
        // remains protected by DPAPI/Keychain for an explicit reactivation.
        writeLicenseVault({ activationCode: vault.activationCode })
        activationCodeStored = true
      } else {
        clearLicenseVault()
      }
    } catch {
      clearLicenseVault()
    }
    const message = '设备凭证已失效，请重新输入原激活码验证。'
    const updated: ServerStoredActivation = {
      ...sanitizedServerRecord(current),
      requiresRevalidation: true,
      revokedReason: message,
      serverMessage: message,
      activationCodeStored,
      maskedActivationCode: activationCodeStored && vault.activationCode
        ? maskActivationCode(vault.activationCode)
        : undefined
    }
    writeStoredActivation(updated)
    return toStatus(updated, deviceId)
  }
  if (result.contractInvalid) {
    const updated: ServerStoredActivation = {
      ...sanitizedServerRecord(current),
      requiresRevalidation: true,
      serverMessage: result.message
    }
    writeStoredActivation(updated)
    return toStatus(updated, deviceId)
  }
  const revoked: ServerStoredActivation = {
    ...sanitizedServerRecord(current),
    requiresRevalidation: true,
    revokedReason: result.message,
    serverMessage: result.message
  }
  writeStoredActivation(revoked)
  return toStatus(revoked, deviceId)
}

export async function activateWithCode(input: string): Promise<ActivationResult> {
  const enteredCode = input.trim()
  const normalized = normalizeCode(enteredCode)
  const currentStatus = getActivationStatus()
  if (!normalized) return { ok: false, message: '请输入激活码。', status: currentStatus }
  if (enteredCode.length > 512) return { ok: false, message: '激活码格式不正确。', status: currentStatus }
  const deviceId = currentStatus.deviceId
  const existing = currentServerRecord()
  const samePrimary = existing?.record.codeHash === hashActivationCode(enteredCode)
  if (currentStatus.activated && existing && !samePrimary) {
    return { ok: false, message: '当前电脑已有主激活码；新增积分请使用“充值积分”。', status: currentStatus }
  }
  let result = await requestServerActivation(enteredCode, deviceId, samePrimary ? {
    currentCodeId: existing?.record.licenseId,
    credentialRefresh: true,
    deviceCredential: existing?.vault?.deviceCredential,
    deviceSession: existing?.vault?.deviceSession
  } : {})
  if (!result.ok && result.credentialRefreshRequired && !samePrimary) {
    // A historical server binding can outlive a lost or superseded local
    // summary. Retry only when the authorization service explicitly requires
    // the v2 credential-upgrade flag; never opt into balance merging here.
    result = await requestServerActivation(enteredCode, deviceId, {
      credentialRefresh: true
    })
  }
  if (!result.ok) return { ok: false, message: friendlyActivationFailure(result.message), status: currentStatus }
  if (result.action === 'balance_merged') {
    return {
      ok: false,
      message: '这台电脑在服务器上已有主激活码，本次积分码已充值到原主授权。请重新输入原主激活码恢复本机授权；如果原码已丢失，请联系管理员处理。',
      status: currentStatus
    }
  }
  if (result.primaryLicenseId && result.licenseId && result.primaryLicenseId !== result.licenseId) {
    return { ok: false, message: '服务器返回的主授权编号不一致，本次没有写入本机授权。', status: currentStatus }
  }
  const credential = result.deviceCredential || (samePrimary ? existing?.vault?.deviceCredential : undefined)
  const session = result.deviceSession || (samePrimary ? existing?.vault?.deviceSession : undefined)
  if (!credential || !session) {
    return { ok: false, message: '服务器没有返回完整的设备会话和设备凭证，本次未写入授权。', status: currentStatus }
  }
  let credentialsSaved = false
  try {
    writeLicenseVault({ activationCode: enteredCode, deviceCredential: credential, deviceSession: session })
    credentialsSaved = true
    const record = entitlementRecord(samePrimary ? existing?.record || null : null, enteredCode, deviceId, result)
    writeStoredActivation(record)
    serverValidatedThisRun = true
    const status = toStatus(record, deviceId)
    return { ok: true, message: result.message, status }
  } catch {
    serverValidatedThisRun = false
    if (credentialsSaved) {
      const message = '服务器已接受激活，但本机授权状态保存未完成。请点击“使用已保存的原激活码”恢复，不会重复赠送积分。'
      return { ok: false, message, status: savedCodeRecoveryStatus(deviceId, message) }
    }
    return {
      ok: false,
      message: '系统安全凭证存储不可用，本次没有保存激活结果。请把设备码发给管理员。',
      status: currentStatus
    }
  }
}

export async function redeemPointsWithCode(input: string): Promise<{
  ok: boolean
  message: string
  status: ActivationStatus
  addedPoints: number
  grantId?: string
  points?: number
}> {
  const current = currentServerRecord()
  const before = getActivationStatus()
  if (!current || !before.activated || before.requiresRevalidation || !serverValidatedThisRun) {
    return { ok: false, message: '请先刷新并确认当前主授权有效。', status: before, addedPoints: 0 }
  }
  const code = input.trim()
  if (!normalizeCode(code) || code.length > 512) {
    return { ok: false, message: '请输入管理员发放的有效积分码。', status: before, addedPoints: 0 }
  }
  if (hashActivationCode(code) === current.record.codeHash) {
    return { ok: false, message: '当前主激活码不能作为积分码重复充值。', status: before, addedPoints: 0 }
  }
  const vault = current.vault
  if (!vault?.activationCode || !vault.deviceCredential || !vault.deviceSession || !current.record.licenseId) {
    return { ok: false, message: '当前主授权凭证不完整，请重新验证。', status: before, addedPoints: 0 }
  }
  const result = await requestServerActivation(code, before.deviceId, {
    currentCodeId: current.record.licenseId,
    confirmMerge: true,
    deviceCredential: vault.deviceCredential,
    deviceSession: vault.deviceSession
  })
  if (!result.ok) return { ok: false, message: result.message, status: before, addedPoints: 0 }
  if (result.unlimited && !before.unlimited) {
    return {
      ok: false,
      message: '当前无限码不能作为普通充值码合并，请联系管理员处理升级。',
      status: before,
      addedPoints: 0
    }
  }
  const returnedPrimaryId = result.primaryLicenseId || result.licenseId
  if (returnedPrimaryId !== current.record.licenseId) {
    return { ok: false, message: '服务器返回的主授权编号不一致，本次未更新余额。', status: before, addedPoints: 0 }
  }
  const previousBalance = before.creditsRemaining || 0
  const updated = entitlementRecord(current.record, vault.activationCode, before.deviceId, {
    ...result,
    licenseId: returnedPrimaryId
  })
  writeStoredActivation(updated)
  serverValidatedThisRun = true
  const status = toStatus(updated, before.deviceId)
  return {
    ok: true,
    message: result.message,
    status,
    addedPoints: Math.max(0, (status.creditsRemaining || 0) - previousBalance),
    grantId: returnedPrimaryId,
    points: Math.max(0, (status.creditsRemaining || 0) - previousBalance)
  }
}

export async function deactivateCurrentDevice(): Promise<ActivationDeactivationResult> {
  const stored = readStoredActivation()
  if (stored?.version === 1) {
    clearStoredActivation()
    clearLicenseVault()
    serverValidatedThisRun = false
    return {
      ok: true,
      message: '旧版本机授权记录已清除；该记录没有服务器设备绑定。',
      status: { ...toStatus(null), message: '本机旧授权记录已清除。' },
      unbindId: `legacy-local:${stored.codeHash.slice(0, 24)}`
    }
  }
  let current = currentServerRecord()
  const before = getActivationStatus()
  if (!current || !before.activated) {
    return { ok: false, message: '本机当前没有可解除的服务器授权。', status: before }
  }
  if (
    current.record.licenseId &&
    current.vault?.activationCode &&
    (!current.vault.deviceCredential || !current.vault.deviceSession)
  ) {
    const refreshed = await requestServerActivation(current.vault.activationCode, before.deviceId, {
      currentCodeId: current.record.licenseId,
      credentialRefresh: true
    })
    if (!refreshed.ok || !refreshed.deviceCredential || !refreshed.deviceSession) {
      return { ok: false, message: refreshed.message, status: before }
    }
    const updated = entitlementRecord(current.record, current.vault.activationCode, before.deviceId, refreshed)
    writeLicenseVault({
      activationCode: current.vault.activationCode,
      deviceCredential: refreshed.deviceCredential,
      deviceSession: refreshed.deviceSession
    })
    writeStoredActivation(updated)
    serverValidatedThisRun = true
    current = currentServerRecord()
  }
  if (!current?.record.licenseId || !current.vault?.deviceCredential || !current.vault.deviceSession) {
    return { ok: false, message: '当前设备凭证不完整，请重新输入原激活码后再解绑。', status: before }
  }
  const result = await requestServerDeviceUnbind(
    before.deviceId,
    current.record.licenseId,
    current.vault.deviceCredential,
    current.vault.deviceSession
  )
  if (!result.ok) return { ok: false, message: result.message, status: before }
  clearLicenseVault()
  clearStoredActivation()
  serverValidatedThisRun = false
  return {
    ok: true,
    message: '本机已解除绑定。服务器会保留剩余积分和消费记录，可在新电脑输入原激活码。',
    status: { ...toStatus(null, before.deviceId), message: '本机已解除绑定。' },
    unbindId: result.unbindId || current.record.licenseId
  }
}

export function canStartLicensedAnalysis(): LicenseUsageResult {
  const status = getActivationStatus()
  if (!status.activated) return { ok: false, message: status.message || '当前授权不可用。', status }
  if (status.requiresRevalidation || !serverValidatedThisRun) {
    return { ok: false, message: status.message || '请先连接授权服务器完成验证。', status }
  }
  if (!status.unlimited && (status.creditsRemaining ?? 0) <= 0) {
    return { ok: false, message: '积分不足，请充值后再生成新报告。', status }
  }
  return { ok: true, message: status.unlimited ? '无限授权可用。' : '授权可用。', status }
}

/** Billing is authoritative in the business proxy. The client never subtracts server credits. */
export function consumeAnalysisCredit(_operationId: string): LicenseUsageResult {
  const access = canStartLicensedAnalysis()
  if (!access.ok) return access
  return {
    ok: true,
    message: access.status.unlimited ? '无限授权由服务器确认，不扣积分。' : '本次用量由服务器按真实 Token 结算。',
    status: access.status
  }
}

export function getActivationFilePath(): string {
  return ACTIVATION_FILE()
}

export const activationInternals = {
  parseServerLicense,
  compatibleDeviceIdsForTests(): string[] {
    const systemId = getSystemMachineId()
    const stableSeed = systemId || getOrCreateFallbackMachineSeed()
    const kind = systemId
      ? process.platform === 'win32'
        ? 'windows-machine-guid'
        : `${process.platform}-hardware-id`
      : 'secure-random-device-seed'
    return [
      sha256(`${DEVICE_NAMESPACE}${kind}|${stableSeed}`).slice(0, 32),
      getLegacyDeviceId(),
      getTransitionalDeviceId()
    ].filter(Boolean)
  },
  resetDeviceIdentityForTests(): void {
    cachedSystemMachineId = undefined
    cachedLegacyDeviceId = ''
    cachedTransitionalDeviceId = ''
    cachedDeviceId = ''
  },
  resetRuntimeValidationForTests(): void {
    serverValidatedThisRun = false
  }
}
