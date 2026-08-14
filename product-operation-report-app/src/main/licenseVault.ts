import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { randomBytes } from 'crypto'
import { join } from 'path'

export interface LicenseVaultContents {
  activationCode?: string
  deviceCredential?: string
  deviceSession?: string
}

interface DeviceVaultContents {
  machineSeed: string
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

function parseEncryptedJson<T>(file: string): T | null {
  if (!existsSync(file)) return null
  try {
    const encrypted = readFileSync(file)
    if (!encrypted.length || encrypted.length > MAX_VAULT_BYTES) return null
    assertSecureStorage()
    const parsed = JSON.parse(safeStorage.decryptString(encrypted)) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as T
  } catch {
    return null
  }
}

function readEncryptedJson<T>(name: string): T | null {
  const file = vaultPath(name)
  return parseEncryptedJson<T>(file) ?? parseEncryptedJson<T>(backupPath(file))
}

function writeEncryptedJson(name: string, value: object): void {
  assertSecureStorage()
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
  const value = readEncryptedJson<Record<string, unknown>>(LICENSE_VAULT_FILE)
  if (!value) return null
  const contents: LicenseVaultContents = {
    activationCode: cleanSecret(value.activationCode, 512),
    deviceCredential: cleanSecret(value.deviceCredential, 8192),
    deviceSession: cleanSecret(value.deviceSession, 8192)
  }
  return contents.activationCode || contents.deviceCredential || contents.deviceSession ? contents : null
}

export function writeLicenseVault(contents: LicenseVaultContents): void {
  const cleaned: LicenseVaultContents = {
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
  const current = readEncryptedJson<Record<string, unknown>>(DEVICE_VAULT_FILE)
  const existing = cleanSecret(current?.machineSeed, 256)
  if (existing) return existing
  const created: DeviceVaultContents = { machineSeed: randomBytes(32).toString('base64url') }
  writeEncryptedJson(DEVICE_VAULT_FILE, created)
  return created.machineSeed
}

export function getLicenseVaultPaths(): string[] {
  const file = vaultPath(LICENSE_VAULT_FILE)
  return [file, backupPath(file)]
}
