import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, statSync } from 'fs'
import { isAbsolute, join, resolve } from 'path'
import type { ManagedModelInfo, ModelProfile } from '../shared/types'
import { AI_PROXY_BASE_URL } from './serviceConfig'

const MAX_CONFIG_BYTES = 32 * 1024
const MANAGED_PROFILE_ID = 'managed-model'
const MAX_FALLBACK_MODELS = 3
export const DEFAULT_MANAGED_FALLBACK_MODELS = [
  'claude-sonnet-4-6',
  'gemini-3-flash',
  'kimi-k2.6'
] as const

interface ManagedModelFile {
  version?: number
  enabled?: boolean
  name?: unknown
  baseURL?: unknown
  apiKey?: unknown
  apiKeyEnc?: unknown
  model?: unknown
  supportsVision?: unknown
  temperature?: unknown
  fallbackModels?: unknown
}

export interface ManagedModelState {
  enabled: boolean
  profile: ModelProfile | null
  profiles: ModelProfile[]
  mode?: 'proxy' | 'direct-development'
  info?: ManagedModelInfo
}

function disabledState(): ManagedModelState {
  return { enabled: false, profile: null, profiles: [] }
}

function invalidState(message = '内置模型服务配置不可用，请联系软件管理员。'): ManagedModelState {
  return {
    enabled: true,
    profile: null,
    profiles: [],
    info: {
      enabled: true,
      configured: false,
      name: '内置 AI 服务',
      baseURL: '',
      model: '',
      supportsVision: false,
      error: message
    }
  }
}

function fallbackModelNames(input: ManagedModelFile, primaryModel: string): string[] | null {
  const configured = input.fallbackModels === undefined
    ? (primaryModel.toLowerCase() === 'gpt-5.5' ? [...DEFAULT_MANAGED_FALLBACK_MODELS] : [])
    : input.fallbackModels
  if (!Array.isArray(configured) || configured.length > MAX_FALLBACK_MODELS) return null
  const result: string[] = []
  const seen = new Set([primaryModel.toLowerCase()])
  for (const value of configured) {
    if (typeof value !== 'string') return null
    const model = value.trim()
    const key = model.toLowerCase()
    if (!model || model.length > 200 || seen.has(key)) return null
    seen.add(key)
    result.push(model)
  }
  return result
}

function parseConfig(raw: unknown): ManagedModelState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalidState()
  const input = raw as ManagedModelFile
  if (input.enabled === false) return disabledState()
  if (input.version !== undefined && input.version !== 1) return invalidState('内置模型服务配置版本不受支持，请联系软件管理员。')

  const baseURL = typeof input.baseURL === 'string' ? input.baseURL.trim().replace(/\/+$/, '') : ''
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : ''
  const model = typeof input.model === 'string' ? input.model.trim() : ''
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : '内置 AI 服务'
  const temperature = input.temperature === undefined ? 0.3 : Number(input.temperature)
  if (!baseURL || !apiKey || !model) return invalidState()
  if (baseURL.length > 2048 || apiKey.length > 4096 || model.length > 200 || name.length > 80) return invalidState()
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) return invalidState()
  const fallbackModels = fallbackModelNames(input, model)
  if (!fallbackModels) return invalidState('内置备用模型配置不可用，请联系软件管理员。')

  let parsed: URL
  try {
    parsed = new URL(baseURL)
  } catch {
    return invalidState()
  }
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
  if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) return invalidState()

  const profile: ModelProfile = {
    id: MANAGED_PROFILE_ID,
    name,
    baseURL,
    apiKey,
    model,
    supportsVision: input.supportsVision !== false,
    temperature
  }
  const profiles = [
    profile,
    ...fallbackModels.map((fallbackModel, index): ModelProfile => ({
      id: `${MANAGED_PROFILE_ID}-fallback-${index + 1}`,
      name: `内置备用 AI 服务 ${index + 1}`,
      baseURL,
      apiKey,
      model: fallbackModel,
      supportsVision: input.supportsVision !== false
    }))
  ]
  return {
    enabled: true,
    profile,
    profiles,
    mode: 'direct-development',
    info: {
      enabled: true,
      configured: true,
      name: profile.name,
      baseURL: profile.baseURL,
      model: profile.model,
      supportsVision: profile.supportsVision
    }
  }
}

function readConfigFile(path: string): ManagedModelState {
  try {
    if (statSync(path).size > MAX_CONFIG_BYTES) return invalidState()
    const input = JSON.parse(readFileSync(path, 'utf8')) as ManagedModelFile
    if ((!input.apiKey || typeof input.apiKey !== 'string') && typeof input.apiKeyEnc === 'string') {
      const stored = input.apiKeyEnc
      if (stored.startsWith('plain:')) {
        input.apiKey = Buffer.from(stored.slice('plain:'.length), 'base64').toString('utf8')
      } else if (safeStorage.isEncryptionAvailable()) {
        try {
          input.apiKey = safeStorage.decryptString(Buffer.from(stored, 'base64'))
        } catch {
          return invalidState()
        }
      }
    }
    return parseConfig(input)
  } catch {
    return invalidState()
  }
}

function explicitConfigPath(): string | null {
  const configured = process.env.PRODUCT_REPORT_MANAGED_MODEL_CONFIG_PATH?.trim()
  if (!configured) return null
  return isAbsolute(configured) ? configured : resolve(configured)
}

/**
 * 读取顺序：环境变量 JSON -> 显式私有文件 -> 开发私有文件 -> 打包资源文件。
 * 该函数永远不会把 API Key 写入日志或错误信息。
 */
export function getManagedModelState(): ManagedModelState {
  const allowDevelopmentOverrides = !app.isPackaged && process.env.PRODUCT_REPORT_ALLOW_DEV_OVERRIDES === '1'
  const forceDevelopmentProxy = !app.isPackaged && process.env.PRODUCT_REPORT_DEV_FORCE_PROXY === '1'
  if (app.isPackaged || !allowDevelopmentOverrides || forceDevelopmentProxy) {
    const state = parseConfig({
      version: 1,
      enabled: true,
      name: '内置 AI 服务',
      baseURL: AI_PROXY_BASE_URL,
      apiKey: 'short-lived-session-token',
      model: 'gpt-5.5',
      supportsVision: true,
      temperature: 0.3,
      fallbackModels: [...DEFAULT_MANAGED_FALLBACK_MODELS]
    })
    return { ...state, mode: 'proxy' }
  }

  if (process.env.PRODUCT_REPORT_DISABLE_MANAGED_MODEL === '1') return disabledState()

  const inline = process.env.PRODUCT_REPORT_MANAGED_MODEL_CONFIG_JSON?.trim()
  if (inline) {
    try {
      return parseConfig(JSON.parse(inline))
    } catch {
      return invalidState()
    }
  }

  const explicit = explicitConfigPath()
  if (explicit) return existsSync(explicit) ? readConfigFile(explicit) : invalidState()

  const candidates = [join(app.getAppPath(), 'managed-model.local.json')]
  const existing = candidates.find((candidate) => existsSync(candidate))
  return existing ? readConfigFile(existing) : disabledState()
}

export const managedModelInternals = { parseConfig }
