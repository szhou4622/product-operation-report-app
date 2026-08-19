import { app, safeStorage } from 'electron'
import { join } from 'path'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import type { AppSettings, ModelProfile } from '../shared/types'
import { getManagedModelState } from './managedModel'

const SETTINGS_FILE = () => join(app.getPath('userData'), 'settings.json')
const SETTINGS_BACKUP_FILE = () => `${SETTINGS_FILE()}.bak`

// 落盘结构：apiKey 不直接存明文，存加密后的 base64 字符串
interface StoredProfile extends Omit<ModelProfile, 'apiKey'> {
  apiKeyEnc: string // safeStorage 加密后的 base64；若加密不可用则为明文（带前缀标记）
}
interface StoredSettings {
  profiles: StoredProfile[]
  activeProfileId: string | null
  projectsDir: string
  privacyAccepted?: boolean
  privacyEndpoint?: string
}

const PLAIN_PREFIX = 'plain:'

function encrypt(value: string): string {
  if (!value) return ''
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(value).toString('base64')
  }
  if (app.isPackaged) throw new Error('系统安全存储暂不可用，无法保存模型凭证。')
  // 仅开发态允许退化，正式安装版不会把密钥明文落盘。
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
    privacyAccepted: false,
    privacyEndpoint: undefined
  }
}

function readStoredSettings(file: string): StoredSettings | null {
  if (!existsSync(file)) return null
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as StoredSettings
    return Array.isArray(raw.profiles) ? raw : null
  } catch {
    return null
  }
}

export function loadSettings(): AppSettings {
  const raw = readStoredSettings(SETTINGS_FILE()) ?? readStoredSettings(SETTINGS_BACKUP_FILE())
  if (!raw) return defaultSettings()
  try {
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
      privacyAccepted: Boolean(raw.privacyAccepted),
      privacyEndpoint: typeof raw.privacyEndpoint === 'string' ? raw.privacyEndpoint : undefined
    }
  } catch {
    return defaultSettings()
  }
}

export function saveSettings(settings: AppSettings): AppSettings {
  const file = SETTINGS_FILE()
  const backup = SETTINGS_BACKUP_FILE()
  const temp = `${file}.tmp`
  const backupTemp = `${backup}.tmp`
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const profiles = settings.profiles.map((profile) => {
    const p = {
      ...profile,
      name: profile.name.trim() || '模型配置',
      baseURL: profile.baseURL.trim().replace(/\/+$/, ''),
      apiKey: profile.apiKey.trim(),
      model: profile.model.trim()
    }
    if (!p.apiKey || !p.baseURL || !p.model) throw new Error('模型配置不完整，请填写 API Key、模型地址和模型名。')
    let parsed: URL
    try {
      parsed = new URL(p.baseURL)
    } catch {
      throw new Error('模型地址格式不正确，请检查后重试。')
    }
    const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
    if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) {
      throw new Error('模型地址必须使用 https，以保护 API Key 和商业资料。')
    }
    return p
  })
  const stored: StoredSettings = {
    profiles: profiles.map((p) => ({
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
    privacyAccepted: settings.privacyAccepted,
    privacyEndpoint: settings.privacyEndpoint
  }
  try {
    writeFileSync(temp, JSON.stringify(stored, null, 2), 'utf8')
    if (readStoredSettings(file)) {
      copyFileSync(file, backupTemp)
      renameSync(backupTemp, backup)
    }
    renameSync(temp, file)
  } finally {
    if (existsSync(temp)) rmSync(temp, { force: true })
    if (existsSync(backupTemp)) rmSync(backupTemp, { force: true })
  }
  return loadSettings()
}

export function getActiveProfile(): ModelProfile | null {
  return getActiveProfiles()[0] ?? null
}

/** 内置模式按既定顺序返回主模型与备用模型；普通用户配置仍只使用当前选中模型。 */
export function getActiveProfiles(): ModelProfile[] {
  const managed = getManagedModelState()
  if (managed.enabled) return managed.profiles
  const s = loadSettings()
  const profile = !s.activeProfileId
    ? s.profiles[0]
    : s.profiles.find((p) => p.id === s.activeProfileId) ?? s.profiles[0]
  return profile ? [profile] : []
}

/** 返回给界面的设置；内置模式下绝不暴露任何本地或内置 API Key。 */
export function loadRendererSettings(): AppSettings {
  let settings = loadSettings()
  const managed = getManagedModelState()
  if (!managed.enabled) return settings
  if (managed.mode === 'proxy') {
    const endpoint = managed.info?.baseURL
    const privacyAccepted = Boolean(settings.privacyAccepted && endpoint && settings.privacyEndpoint === endpoint)
    const nextPrivacyEndpoint = privacyAccepted ? endpoint : undefined
    if (
      settings.profiles.length || settings.activeProfileId ||
      settings.privacyAccepted !== privacyAccepted || settings.privacyEndpoint !== nextPrivacyEndpoint
    ) {
      settings = saveSettings({
        ...settings,
        profiles: [],
        activeProfileId: null,
        privacyAccepted,
        privacyEndpoint: nextPrivacyEndpoint
      })
      // saveSettings 会先保留旧文件作为备份；代理模式不再需要任何本地模型密钥，
      // 立即用已清理的新文件覆盖备份，避免旧密钥继续留在 userData。
      copyFileSync(SETTINGS_FILE(), SETTINGS_BACKUP_FILE())
    }
  }
  return {
    ...settings,
    profiles: [],
    activeProfileId: null,
    managedModel: managed.info
  }
}

/** 内置模式只允许界面保存非密钥设置，模型配置始终由主进程掌管。 */
export function saveRendererSettings(settings: AppSettings): AppSettings {
  const managed = getManagedModelState()
  if (!managed.enabled) return saveSettings(settings)

  const current = loadSettings()
  if (managed.mode === 'proxy') {
    saveSettings({
      ...current,
      profiles: [],
      activeProfileId: null,
      projectsDir: typeof settings.projectsDir === 'string' ? settings.projectsDir : current.projectsDir,
      privacyAccepted: Boolean(settings.privacyAccepted),
      privacyEndpoint: settings.privacyAccepted ? managed.info?.baseURL : undefined
    })
    copyFileSync(SETTINGS_FILE(), SETTINGS_BACKUP_FILE())
    return loadRendererSettings()
  }
  const validProfiles = current.profiles.filter(
    (profile) => profile.apiKey.trim() && profile.baseURL.trim() && profile.model.trim()
  )
  const activeProfileId = validProfiles.some((profile) => profile.id === current.activeProfileId)
    ? current.activeProfileId
    : validProfiles[0]?.id ?? null
  saveSettings({
    ...current,
    profiles: validProfiles,
    activeProfileId,
    projectsDir: typeof settings.projectsDir === 'string' ? settings.projectsDir : current.projectsDir,
    privacyAccepted: Boolean(settings.privacyAccepted),
    privacyEndpoint: settings.privacyAccepted ? managed.info?.baseURL : undefined
  })
  return loadRendererSettings()
}
