import type { ModelProfile } from '../shared/types'
import { getLicenseProxyIdentity } from './activation'
import { AI_PROXY_HEALTH_URL, AI_PROXY_SESSION_URL, NETWORK_TIMEOUT_MS } from './serviceConfig'

interface ProxySession {
  token: string
  expiresAt: number
}

let cachedSession: ProxySession | null = null

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('业务服务器返回了无法识别的数据。')
  }
  return value as Record<string, unknown>
}

async function jsonRequest(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, cache: 'no-store' })
    const text = await response.text()
    let body: Record<string, unknown> = {}
    try {
      body = asRecord(JSON.parse(text))
    } catch {
      body = {}
    }
    if (!response.ok) {
      const message = typeof body.message === 'string'
        ? body.message
        : typeof body.error === 'string'
          ? body.error
          : ''
      throw new Error(message || `业务服务器暂时不可用（${response.status}）。`)
    }
    return body
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('连接业务服务器超时，请稍后重试。')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function createSession(): Promise<ProxySession> {
  const identity = getLicenseProxyIdentity()
  const body = await jsonRequest(AI_PROXY_SESSION_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      license_protocol_version: 2,
      app_name: identity.appName,
      machine_code: identity.deviceId,
      code_id: identity.licenseId,
      device_credential: identity.deviceCredential,
      device_session: identity.deviceSession,
      client_version: identity.softwareVersion,
      platform: identity.platform
    })
  })
  const token = typeof body.access_token === 'string' ? body.access_token.trim() : ''
  const expiresIn = Number(body.expires_in)
  if (!token || token.length > 8_192) throw new Error('业务服务器没有返回有效的临时会话。')
  return {
    token,
    expiresAt: Date.now() + (Number.isFinite(expiresIn) ? Math.max(60, Math.min(3_600, expiresIn)) : 900) * 1_000
  }
}

export async function getAiProxyToken(force = false): Promise<string> {
  if (!force && cachedSession && cachedSession.expiresAt - Date.now() > 30_000) return cachedSession.token
  cachedSession = await createSession()
  return cachedSession.token
}

export function clearAiProxySession(): void {
  cachedSession = null
}

export async function authorizeProxyProfiles(profiles: ModelProfile[]): Promise<ModelProfile[]> {
  const token = await getAiProxyToken()
  return profiles.map((profile) => ({ ...profile, apiKey: token }))
}

export async function testProxyHealth(): Promise<{ ok: boolean; message: string; latencyMs: number }> {
  const started = Date.now()
  try {
    await jsonRequest(AI_PROXY_HEALTH_URL, { method: 'GET', headers: { accept: 'application/json' } })
    return { ok: true, message: '业务服务器连接正常。', latencyMs: Date.now() - started }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : '业务服务器暂时不可用。',
      latencyMs: Date.now() - started
    }
  }
}
