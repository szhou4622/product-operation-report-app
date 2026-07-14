import { app } from 'electron'
import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { arch, hostname, platform, userInfo } from 'os'
import type { ActivationResult, ActivationStatus } from '../shared/types'
import { ACTIVATION_CODE_COUNT, ACTIVATION_CODE_HASHES } from './activationCodes'

const ACTIVATION_FILE = () => join(app.getPath('userData'), 'activation.json')
const CODE_NAMESPACE = 'product-operation-report:activation:v1:'
const DEVICE_NAMESPACE = 'product-operation-report:device:v1:'
const allowedCodeHashes = new Set<string>(ACTIVATION_CODE_HASHES)

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
  try {
    const output = execFileSync(
      'reg',
      ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
      { encoding: 'utf8', timeout: 2000, windowsHide: true }
    )
    const match = output.match(/MachineGuid\s+REG_SZ\s+([^\r\n]+)/i)
    return match?.[1]?.trim() ?? ''
  } catch {
    return ''
  }
}

function getDeviceId(): string {
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
  return sha256(`${DEVICE_NAMESPACE}${seed}`).slice(0, 32)
}

function readStoredActivation(): StoredActivation | null {
  const file = ACTIVATION_FILE()
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

function writeStoredActivation(record: StoredActivation): void {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(ACTIVATION_FILE(), JSON.stringify(record, null, 2), 'utf8')
}

function toStatus(record: StoredActivation | null, deviceId = getDeviceId()): ActivationStatus {
  const validRecord =
    record &&
    record.deviceId === deviceId &&
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
  return toStatus(readStoredActivation())
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
