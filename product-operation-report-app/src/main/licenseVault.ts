import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { randomBytes } from 'crypto'
import { join } from 'path'

export interface LicenseVaultContents {
  version?: 2
  appName?: string
  licenseId?: string
  machineCode?: string
  activationCode?: string
  deviceCredential?: string
  deviceSession?: string
}

export interface DeviceVaultContents {
  machineSeed?: string
  machineCode?: string
}

export type SecureVaultStatus = 'ready' | 'missing' | 'unavailable' | 'corrupt'

export interface SecureVaultReadResult<T> {
  status: SecureVaultStatus
  value: T | null
  source?: 'primary' | 'backup'
}

const LICENSE_VAULT_FILE = 'license-vault.bin'
const DEVICE_VAULT_FILE = 'device-vault.bin'
const MAX_VAULT_BYTES = 128 * 1024

function vaultPath(name: string): string {
  return join(app.getPath('userData'), name)
}

function backupPath(file: string): string {
  return `${file}.bak`
}

function assertSecureStorage(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure operating-system credential storage is unavailable.')
  }
}

function parseEncryptedJson<T>(file: string): {
  value: T | null
  encrypted?: Buffer
  failure?: 'unavailable' | 'corrupt'
} {
  if (!existsSync(file)) return { value: null }
  let encrypted: Buffer
  try {
    encrypted = readFileSync(file)
  } catch {
    return { value: null, failure: 'corrupt' }
  }
  if (!encrypted.length || encrypted.length > MAX_VAULT_BYTES) return { value: null, failure: 'corrupt' }
  let decrypted: string
  try {
    assertSecureStorage()
    decrypted = safeStorage.decryptString(encrypted)
  } catch {
    // Keychain/DPAPI may be temporarily locked even though the encrypted file
    // itself is intact. Never classify that as a missing vault or overwrite it.
    return { value: null, failure: 'unavailable' }
  }
  try {
    const parsed = JSON.parse(decrypted) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { value: null, failure: 'corrupt' }
    return { value: parsed as T, encrypted }
  } catch {
    return { value: null, failure: 'corrupt' }
  }
}

function restorePrimaryFromBackup(name: string, encrypted: Buffer): void {
  const file = vaultPath(name)
  const temp = `${file}.restore.tmp`
  try {
    writeFileSync(temp, encrypted, { mode: 0o600 })
    renameSync(temp, file)
  } finally {
    rmSync(temp, { force: true })
  }
}

function inspectEncryptedJson<T>(name: string): SecureVaultReadResult<T> {
  const file = vaultPath(name)
  const backup = backupPath(file)
  const primaryExists = existsSync(file)
  const backupExists = existsSync(backup)
  if (!primaryExists && !backupExists) return { status: 'missing', value: null }
  if (!safeStorage.isEncryptionAvailable()) return { status: 'unavailable', value: null }

  let unavailable = false
  if (primaryExists) {
    const primary = parseEncryptedJson<T>(file)
    if (primary.value) return { status: 'ready', value: primary.value, source: 'primary' }
    unavailable ||= primary.failure === 'unavailable'
  }
  if (backupExists) {
    const fallback = parseEncryptedJson<T>(backup)
    if (fallback.value && fallback.encrypted) {
      try {
        restorePrimaryFromBackup(name, fallback.encrypted)
      } catch {
        // A readable backup remains authoritative even if primary self-healing fails.
      }
      return { status: 'ready', value: fallback.value, source: 'backup' }
    }
    unavailable ||= fallback.failure === 'unavailable'
  }
  return { status: unavailable ? 'unavailable' : 'corrupt', value: null }
}

function writeEncryptedJson(name: string, value: object): void {
  assertSecureStorage()
  const current = inspectEncryptedJson<Record<string, unknown>>(name)
  if (current.status === 'unavailable') throw new Error('Secure operating-system credential storage is unavailable.')
  if (current.status === 'corrupt') throw new Error('Encrypted credential vault is corrupt; refusing to overwrite it.')
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const file = vaultPath(name)
  const temp = `${file}.tmp`
  const backup = backupPath(file)
  const backupTemp = `${backup}.tmp`
  const encrypted = safeStorage.encryptString(JSON.stringify(value))
  if (!encrypted.length || encrypted.length > MAX_VAULT_BYTES) {
    throw new Error('Encrypted credential payload is invalid.')
  }
  try {
    writeFileSync(temp, encrypted, { mode: 0o600 })
    renameSync(temp, file)
    try {
      writeFileSync(backupTemp, encrypted, { mode: 0o600 })
      renameSync(backupTemp, backup)
    } catch {
      rmSync(backupTemp, { force: true })
    }
  } finally {
    rmSync(temp, { force: true })
    rmSync(backupTemp, { force: true })
  }
}

function clearEncryptedJson(name: string): void {
  const file = vaultPath(name)
  for (const candidate of [file, backupPath(file), `${file}.tmp`, `${backupPath(file)}.tmp`]) {
    rmSync(candidate, { force: true })
  }
}

function cleanSecret(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed && trimmed.length <= maxLength ? trimmed : undefined
}

export function readLicenseVault(): LicenseVaultContents | null {
  return inspectLicenseVault().value
}

export function inspectLicenseVault(): SecureVaultReadResult<LicenseVaultContents> {
  const inspected = inspectEncryptedJson<Record<string, unknown>>(LICENSE_VAULT_FILE)
  const value = inspected.value
  if (!value) return { ...inspected, value: null }
  const contents: LicenseVaultContents = {
    version: value.version === 2 ? 2 : undefined,
    appName: cleanSecret(value.appName, 128),
    licenseId: cleanSecret(value.licenseId, 256),
    machineCode: cleanMachineCode(value.machineCode),
    activationCode: cleanSecret(value.activationCode, 512),
    deviceCredential: cleanSecret(value.deviceCredential, 8192),
    deviceSession: cleanSecret(value.deviceSession, 8192)
  }
  const hasValue = contents.activationCode || contents.deviceCredential || contents.deviceSession || contents.licenseId
  return { ...inspected, value: hasValue ? contents : null }
}

export function writeLicenseVault(contents: LicenseVaultContents): void {
  const cleaned: LicenseVaultContents = {
    version: 2,
    appName: cleanSecret(contents.appName, 128),
    licenseId: cleanSecret(contents.licenseId, 256),
    machineCode: cleanMachineCode(contents.machineCode),
    activationCode: cleanSecret(contents.activationCode, 512),
    deviceCredential: cleanSecret(contents.deviceCredential, 8192),
    deviceSession: cleanSecret(contents.deviceSession, 8192)
  }
  if (!cleaned.activationCode && !cleaned.deviceCredential && !cleaned.deviceSession) {
    throw new Error('No credentials are available for secure storage.')
  }
  writeEncryptedJson(LICENSE_VAULT_FILE, cleaned)
}

export function clearLicenseVault(): void {
  clearEncryptedJson(LICENSE_VAULT_FILE)
}

export function getOrCreateFallbackMachineSeed(): string {
  const inspected = inspectDeviceVault()
  if (inspected.status === 'unavailable') throw new Error('Secure device storage is unavailable.')
  if (inspected.status === 'corrupt') throw new Error('Encrypted device vault is corrupt; refusing to replace it.')
  const existing = cleanSecret(inspected.value?.machineSeed, 256)
  if (existing) return existing
  const machineSeed = randomBytes(32).toString('base64url')
  const created: DeviceVaultContents = {
    machineSeed,
    machineCode: cleanMachineCode(inspected.value?.machineCode)
  }
  writeEncryptedJson(DEVICE_VAULT_FILE, created)
  return machineSeed
}

function cleanMachineCode(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  return /^[a-f0-9]{32}$/.test(normalized) ? normalized : undefined
}

export function readStoredMachineCode(): string | null {
  return inspectDeviceVault().value?.machineCode || null
}

export function inspectDeviceVault(): SecureVaultReadResult<DeviceVaultContents> {
  const inspected = inspectEncryptedJson<Record<string, unknown>>(DEVICE_VAULT_FILE)
  if (!inspected.value) return { ...inspected, value: null }
  return {
    ...inspected,
    value: {
      machineSeed: cleanSecret(inspected.value.machineSeed, 256),
      machineCode: cleanMachineCode(inspected.value.machineCode)
    }
  }
}

export function writeStoredMachineCode(machineCode: string): void {
  const normalized = cleanMachineCode(machineCode)
  if (!normalized) throw new Error('Machine code is invalid.')
  const inspected = inspectDeviceVault()
  if (inspected.status === 'unavailable') throw new Error('Secure device storage is unavailable.')
  if (inspected.status === 'corrupt') throw new Error('Encrypted device vault is corrupt; refusing to overwrite it.')
  const next: DeviceVaultContents = {
    machineSeed: cleanSecret(inspected.value?.machineSeed, 256),
    machineCode: normalized
  }
  writeEncryptedJson(DEVICE_VAULT_FILE, next)
}

export function getLicenseVaultPaths(): string[] {
  const file = vaultPath(LICENSE_VAULT_FILE)
  return [file, backupPath(file)]
}
