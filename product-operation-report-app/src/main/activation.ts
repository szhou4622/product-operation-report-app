import { app } from 'electron'
import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { arch, hostname, platform, userInfo } from 'os'
import type { ActivationResult, ActivationStatus } from '../shared/types'
import { ACTIVATION_CODE_COUNT, ACTIVATION_CODE_HASHES } from './activationCodes'

const ACTIVATION_FILE = () => join(app.getPath('userData'), 'activation.json')
const ACTIVATION_BACKUP_FILE = () => `${ACTIVATION_FILE()}.bak`
const CODE_NAMESPACE = 'product-operation-report:activation:v1:'
const DEVICE_NAMESPACE = 'product-operation-report:device:v1:'
const allowedCodeHashes = new Set<string>(ACTIVATION_CODE_HASHES)
let machineGuidLoaded = false
let cachedMachineGuid = ''
let cachedLegacyDeviceId = ''
let cachedDeviceId = ''

interface StoredActivation {
  version: 1
  codeHash: string
  deviceId: string
  activatedAt: string
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

function getLegacyDeviceId(): string {
  if (cachedLegacyDeviceId) return cachedLegacyDeviceId
  let user = ''
  try {
    user = userInfo().username
  } catch {
    user = ''
  }
  const seed = [
    platform(),
    arch(),
    hostname(),
    user,
    getWindowsMachineGuid()
  ].join('|')
  cachedLegacyDeviceId = sha256(`${DEVICE_NAMESPACE}${seed}`).slice(0, 32)
  return cachedLegacyDeviceId
}

function getDeviceId(): string {
  if (cachedDeviceId) return cachedDeviceId
  const machineGuid = getWindowsMachineGuid()
  if (machineGuid) {
    cachedDeviceId = sha256(`${DEVICE_NAMESPACE}windows-machine-guid|${machineGuid}`).slice(0, 32)
    return cachedDeviceId
  }
  cachedDeviceId = getLegacyDeviceId()
  return cachedDeviceId
}

function readStoredActivationFile(file: string): StoredActivation | null {
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as StoredActivation
    if (
      parsed?.version === 1 &&
      typeof parsed.codeHash === 'string' &&
      typeof parsed.deviceId === 'string' &&
      typeof parsed.activatedAt === 'string'
    ) {
      return parsed
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
    writeFileSync(temp, JSON.stringify(record, null, 2), 'utf8')
    renameSync(temp, file)
    try {
      copyFileSync(file, backupTemp)
      renameSync(backupTemp, backup)
    } catch {
      if (existsSync(backupTemp)) rmSync(backupTemp, { force: true })
      // 主激活记录已成功提交；备份失败不应把成功激活误报为失败
    }
  } finally {
    if (existsSync(temp)) rmSync(temp, { force: true })
    if (existsSync(backupTemp)) rmSync(backupTemp, { force: true })
  }
}

function toStatus(record: StoredActivation | null, deviceId = getDeviceId()): ActivationStatus {
  const legacyDeviceId = getLegacyDeviceId()
  const validRecord =
    record &&
    (record.deviceId === deviceId || record.deviceId === legacyDeviceId) &&
    allowedCodeHashes.has(record.codeHash)

  return {
    activated: Boolean(validRecord),
    deviceId,
    activatedAt: validRecord ? record.activatedAt : undefined,
    licenseId: validRecord ? record.codeHash.slice(0, 10).toUpperCase() : undefined,
    codeCount: ACTIVATION_CODE_COUNT
  }
}

export function getActivationStatus(): ActivationStatus {
  const record = readStoredActivation()
  const deviceId = getDeviceId()
  const status = toStatus(record, deviceId)
  if (status.activated && record && record.deviceId !== deviceId) {
    try {
      writeStoredActivation({ ...record, deviceId })
    } catch {
      // 迁移失败时仍允许本次使用，后续再重试写入
    }
  }
  return status
}

export function activateWithCode(input: string): ActivationResult {
  const code = normalizeCode(input)
  const currentStatus = getActivationStatus()
  if (!code) {
    return { ok: false, message: '请输入激活码。', status: currentStatus }
  }

  const codeHash = hashActivationCode(code)
  if (!allowedCodeHashes.has(codeHash)) {
    return { ok: false, message: '激活码无效，请检查后重新输入。', status: currentStatus }
  }

  const record: StoredActivation = {
    version: 1,
    codeHash,
    deviceId: currentStatus.deviceId,
    activatedAt: new Date().toISOString()
  }
  writeStoredActivation(record)

  return {
    ok: true,
    message: '激活成功，本设备可永久使用。',
    status: toStatus(record, currentStatus.deviceId)
  }
}
