import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { randomBytes } from 'crypto'
import { join } from 'path'

export type LicenseVaultEntryState = 'active' | 'merged' | 'unbound' | 'revoked' | 'unknown'

export interface LicenseVaultEntry {
  licenseId?: string
  machineCode?: string
  activationCode?: string
  deviceCredential?: string
  deviceSession?: string
  state?: LicenseVaultEntryState
  mergedIntoLicenseId?: string
  lastValidatedAt?: string
  updatedAt?: string
}

export interface LicenseVaultContents {
  version?: 2 | 3
  appName?: string
  activeLicenseId?: string
  entries?: LicenseVaultEntry[]
  /** Compatibility view of the active v3 entry for existing callers. */
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
const MAX_VAULT_BYTES = 512 * 1024
const MAX_LICENSE_ENTRIES = 20

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

function cleanEntryState(value: unknown): LicenseVaultEntryState {
  return value === 'active' || value === 'merged' || value === 'unbound' || value === 'revoked'
    ? value
    : 'unknown'
}

function cleanTimestamp(value: unknown): string | undefined {
  const cleaned = cleanSecret(value, 128)
  if (!cleaned) return undefined
  return Number.isFinite(Date.parse(cleaned)) ? cleaned : undefined
}

function cleanLicenseEntry(value: unknown): LicenseVaultEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const entry: LicenseVaultEntry = {
    licenseId: cleanSecret(raw.licenseId, 256),
    machineCode: cleanMachineCode(raw.machineCode),
    activationCode: cleanSecret(raw.activationCode, 512),
    deviceCredential: cleanSecret(raw.deviceCredential, 8192),
    deviceSession: cleanSecret(raw.deviceSession, 8192),
    state: cleanEntryState(raw.state),
    mergedIntoLicenseId: cleanSecret(raw.mergedIntoLicenseId, 256),
    lastValidatedAt: cleanTimestamp(raw.lastValidatedAt),
    updatedAt: cleanTimestamp(raw.updatedAt)
  }
  return entry.licenseId || entry.activationCode || entry.deviceCredential || entry.deviceSession
    ? entry
    : null
}

function entryKey(entry: LicenseVaultEntry): string {
  if (entry.licenseId) return `license:${entry.licenseId.toUpperCase()}`
  if (entry.activationCode) return `code:${entry.activationCode.toUpperCase().replace(/[^A-Z0-9]/g, '')}`
  return `session:${entry.deviceSession || entry.deviceCredential || ''}`
}

function uniqueEntries(entries: LicenseVaultEntry[]): LicenseVaultEntry[] {
  const seen = new Set<string>()
  const result: LicenseVaultEntry[] = []
  for (const raw of entries) {
    const entry = cleanLicenseEntry(raw)
    if (!entry) continue
    const key = entryKey(entry)
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push(entry)
    if (result.length >= MAX_LICENSE_ENTRIES) break
  }
  return result
}

function compatibilityEntry(contents: LicenseVaultContents): LicenseVaultEntry | null {
  const entries = uniqueEntries(contents.entries || [])
  const activeLicenseId = cleanSecret(contents.activeLicenseId, 256)
  if (activeLicenseId) {
    const active = entries.find((entry) => entry.licenseId === activeLicenseId)
    if (active) return active
  }
  const active = entries.find((entry) => entry.state === 'active')
  if (active) return active
  if (contents.version !== 3) return entries[0] || null
  return null
}

function withCompatibilityFields(contents: LicenseVaultContents): LicenseVaultContents {
  const active = compatibilityEntry(contents)
  return {
    ...contents,
    licenseId: active?.licenseId,
    machineCode: active?.machineCode,
    activationCode: active?.activationCode,
    deviceCredential: active?.deviceCredential,
    deviceSession: active?.deviceSession
  }
}

export function readLicenseVault(): LicenseVaultContents | null {
  return inspectLicenseVault().value
}

export function inspectLicenseVault(): SecureVaultReadResult<LicenseVaultContents> {
  const inspected = inspectEncryptedJson<Record<string, unknown>>(LICENSE_VAULT_FILE)
  const value = inspected.value
  if (!value) return { ...inspected, value: null }
  const legacyEntry = cleanLicenseEntry({
    licenseId: value.licenseId,
    machineCode: value.machineCode,
    activationCode: value.activationCode,
    deviceCredential: value.deviceCredential,
    deviceSession: value.deviceSession,
    state: 'active'
  })
  const entries = value.version === 3
    ? uniqueEntries(Array.isArray(value.entries) ? value.entries as LicenseVaultEntry[] : [])
    : uniqueEntries(legacyEntry ? [legacyEntry] : [])
  if (!entries.length) return { ...inspected, status: 'corrupt', value: null }
  const requestedActiveId = cleanSecret(value.activeLicenseId, 256)
  const activeLicenseId = requestedActiveId && entries.some((entry) => entry.licenseId === requestedActiveId)
    ? requestedActiveId
    : value.version === 3
      ? entries.find((entry) => entry.state === 'active')?.licenseId
      : entries[0]?.licenseId
  const contents = withCompatibilityFields({
    version: value.version === 3 ? 3 : 2,
    appName: cleanSecret(value.appName, 128),
    activeLicenseId,
    entries
  })
  return { ...inspected, value: contents }
}

export function writeLicenseVault(contents: LicenseVaultContents): void {
  const explicitEntries = uniqueEntries(contents.entries || [])
  const legacyEntry = cleanLicenseEntry({
    licenseId: contents.licenseId,
    machineCode: contents.machineCode,
    activationCode: contents.activationCode,
    deviceCredential: contents.deviceCredential,
    deviceSession: contents.deviceSession,
    state: 'active',
    updatedAt: new Date().toISOString()
  })
  const entries = explicitEntries.length ? explicitEntries : uniqueEntries(legacyEntry ? [legacyEntry] : [])
  if (!entries.some((entry) => entry.activationCode || entry.deviceCredential || entry.deviceSession)) {
    throw new Error('No credentials are available for secure storage.')
  }
  const requestedActiveId = cleanSecret(contents.activeLicenseId || contents.licenseId, 256)
  const activeLicenseId = requestedActiveId && entries.some((entry) => entry.licenseId === requestedActiveId)
    ? requestedActiveId
    : entries.find((entry) => entry.state === 'active')?.licenseId
  writeEncryptedJson(LICENSE_VAULT_FILE, {
    version: 3,
    appName: cleanSecret(contents.appName, 128),
    activeLicenseId,
    entries
  })
}

export function upsertLicenseVaultEntry(
  current: LicenseVaultContents | null,
  input: LicenseVaultEntry,
  makeActive: boolean,
  preserveExistingCredentials = true
): LicenseVaultContents {
  const now = new Date().toISOString()
  const incoming = cleanLicenseEntry({ ...input, updatedAt: input.updatedAt || now })
  if (!incoming) throw new Error('License vault entry is invalid.')
  const priorEntries = uniqueEntries(current?.entries || [])
  const key = entryKey(incoming)
  const previous = priorEntries.find((entry) => entryKey(entry) === key)
  const merged = cleanLicenseEntry({
    ...previous,
    ...incoming,
    activationCode: incoming.activationCode || previous?.activationCode,
    deviceCredential: preserveExistingCredentials
      ? incoming.deviceCredential || previous?.deviceCredential
      : incoming.deviceCredential,
    deviceSession: preserveExistingCredentials
      ? incoming.deviceSession || previous?.deviceSession
      : incoming.deviceSession,
    state: makeActive ? 'active' : incoming.state,
    updatedAt: now
  })
  if (!merged) throw new Error('License vault entry is invalid.')
  const entries = uniqueEntries([
    merged,
    ...priorEntries
      .filter((entry) => entryKey(entry) !== key)
      .map((entry) => makeActive && entry.state === 'active' ? { ...entry, state: 'unknown' as const } : entry)
  ])
  return withCompatibilityFields({
    version: 3,
    appName: current?.appName,
    activeLicenseId: makeActive ? merged.licenseId : current?.activeLicenseId,
    entries
  })
}

export function markLicenseVaultEntry(
  current: LicenseVaultContents,
  licenseId: string,
  state: LicenseVaultEntryState,
  mergedIntoLicenseId?: string
): LicenseVaultContents {
  const cleanId = cleanSecret(licenseId, 256)
  if (!cleanId) return current
  const entries = uniqueEntries((current.entries || []).map((entry) => entry.licenseId === cleanId
    ? {
        ...entry,
        state,
        mergedIntoLicenseId: state === 'merged' ? cleanSecret(mergedIntoLicenseId, 256) : undefined,
        updatedAt: new Date().toISOString()
      }
    : entry))
  return withCompatibilityFields({ ...current, version: 3, entries })
}

export function licenseVaultRecoveryEntries(
  current: LicenseVaultContents,
  machineCode: string,
  excludedLicenseId?: string
): LicenseVaultEntry[] {
  const machine = cleanMachineCode(machineCode)
  if (!machine) return []
  return uniqueEntries(current.entries || [])
    .filter((entry) =>
      entry.licenseId &&
      entry.licenseId !== excludedLicenseId &&
      entry.machineCode === machine &&
      Boolean(entry.activationCode) &&
      Boolean(entry.deviceCredential && entry.deviceSession) &&
      entry.state !== 'merged' &&
      entry.state !== 'unbound' &&
      entry.state !== 'revoked'
    )
    .sort((left, right) => Date.parse(right.lastValidatedAt || right.updatedAt || '') - Date.parse(left.lastValidatedAt || left.updatedAt || ''))
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
