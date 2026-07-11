import { app, safeStorage } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import type { AppSettings, ModelProfile } from '../shared/types'

const SETTINGS_FILE = () => join(app.getPath('userData'), 'settings.json')

// 落盘结构：apiKey 不直接存明文，存加密后的 base64 字符串
interface StoredProfile extends Omit<ModelProfile, 'apiKey'> {
  apiKeyEnc: string // safeStorage 加密后的 base64；若加密不可用则为明文（带前缀标记）
}
interface StoredSettings {
  profiles: StoredProfile[]
  activeProfileId: string | null
  projectsDir: string
  privacyAccepted?: boolean
}

const PLAIN_PREFIX = 'plain:'

function encrypt(value: string): string {
  if (!value) return ''
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(value).toString('base64')
  }
  // 加密不可用（少见，主要在某些 Linux 环境）时退化为明文存储并打标记
  return PLAIN_PREFIX + Buffer.from(value, 'utf8').toString('base64')
}

function decrypt(stored: string): string {
  if (!stored) return ''
  if (stored.startsWith(PLAIN_PREFIX)) {
    return Buffer.from(stored.slice(PLAIN_PREFIX.length), 'base64').toString('utf8')
  }
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'))
  } catch {
    return ''
  }
}

function defaultSettings(): AppSettings {
  return {
    profiles: [],
    activeProfileId: null,
    projectsDir: join(app.getPath('documents'), '产品经营报告'),
    privacyAccepted: false
  }
}

export function loadSettings(): AppSettings {
  const file = SETTINGS_FILE()
  if (!existsSync(file)) return defaultSettings()
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as StoredSettings
    return {
      profiles: (raw.profiles || []).map((p) => ({
        id: p.id,
        name: p.name,
        baseURL: p.baseURL,
        model: p.model,
        supportsVision: p.supportsVision,
        temperature: p.temperature,
        apiKey: decrypt(p.apiKeyEnc)
      })),
      activeProfileId: raw.activeProfileId ?? null,
      projectsDir: raw.projectsDir || defaultSettings().projectsDir,
      privacyAccepted: Boolean(raw.privacyAccepted)
    }
  } catch {
    return defaultSettings()
  }
}

export function saveSettings(settings: AppSettings): AppSettings {
  const file = SETTINGS_FILE()
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const stored: StoredSettings = {
    profiles: settings.profiles.map((p) => ({
      id: p.id,
      name: p.name,
      baseURL: p.baseURL,
      model: p.model,
      supportsVision: p.supportsVision,
      temperature: p.temperature,
      apiKeyEnc: encrypt(p.apiKey)
    })),
    activeProfileId: settings.activeProfileId,
    projectsDir: settings.projectsDir,
    privacyAccepted: settings.privacyAccepted
  }
  writeFileSync(file, JSON.stringify(stored, null, 2), 'utf8')
  return loadSettings()
}

export function getActiveProfile(): ModelProfile | null {
  const s = loadSettings()
  if (!s.activeProfileId) return s.profiles[0] ?? null
  return s.profiles.find((p) => p.id === s.activeProfileId) ?? s.profiles[0] ?? null
}
