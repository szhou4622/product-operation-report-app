import type { ModelProfile, PointsAccessResult, PointsRedeemResult, PointsWalletStatus } from '../shared/types'
import { getActivationStatus, getLicenseProxyIdentity } from './activation'
import {
  AI_PROXY_HEALTH_URL,
  AI_PROXY_REDEEM_URL,
  AI_PROXY_SESSION_URL,
  AI_PROXY_WALLET_URL,
  NETWORK_TIMEOUT_MS
} from './serviceConfig'

interface ProxySession {
  token: string
  expiresAt: number
}

let cachedSession: ProxySession | null = null

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('业务服务器返回了无法识别的数据。')
  return value as Record<string, unknown>
}

async function jsonRequest(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, cache: 'no-store' })
    const text = await response.text()
    let body: Record<string, unknown> = {}
    try { body = asRecord(JSON.parse(text)) } catch { /* 下方统一报错 */ }
    if (!response.ok) {
      const message = typeof body.message === 'string' ? body.message : typeof body.error === 'string' ? body.error : ''
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
      app_name: identity.appName,
      machine_code: identity.deviceId,
      license_id: identity.licenseId,
      device_credential: identity.deviceCredential,
      device_session: identity.deviceSession,
      software_version: identity.softwareVersion,
      platform: identity.platform
    })
  })
  const token = typeof body.access_token === 'string' ? body.access_token.trim() : ''
  const expiresIn = Number(body.expires_in)
  if (!token || token.length > 8192) throw new Error('业务服务器没有返回有效的临时会话。')
  return {
    token,
    expiresAt: Date.now() + (Number.isFinite(expiresIn) ? Math.max(60, Math.min(3600, expiresIn)) : 900) * 1000
  }
}

function isSessionError(error: unknown): boolean {
  return error instanceof Error && /会话.*(过期|缺少)|401/.test(error.message)
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

function parseWallet(body: Record<string, unknown>): PointsWalletStatus {
  const wallet = (body.wallet && typeof body.wallet === 'object' ? body.wallet : body) as PointsWalletStatus
  if (!Number.isFinite(wallet.balancePoints) || !Array.isArray(wallet.ledger) || !wallet.pricing) {
    throw new Error('业务服务器返回的积分数据不完整。')
  }
  return wallet
}

export async function getProxyWallet(): Promise<PointsWalletStatus> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = await getAiProxyToken(attempt > 0)
    try {
      return parseWallet(await jsonRequest(AI_PROXY_WALLET_URL, {
        method: 'GET', headers: { accept: 'application/json', authorization: `Bearer ${token}` }
      }))
    } catch (error) {
      if (attempt === 0 && isSessionError(error)) {
        clearAiProxySession()
        continue
      }
      throw error
    }
  }
  throw new Error('业务会话无法建立，请重新打开软件。')
}

export async function canStartProxyReport(): Promise<PointsAccessResult> {
  const wallet = await getProxyWallet()
  return wallet.balancePoints > 0
    ? { ok: true, message: '积分可用，将由服务器按实际模型用量结算。', wallet }
    : { ok: false, message: '积分不足，请先输入新的积分充值码。', wallet }
}

export async function redeemProxyPoints(code: string): Promise<PointsRedeemResult> {
  let body: Record<string, unknown> | undefined
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = await getAiProxyToken(attempt > 0)
    try {
      body = await jsonRequest(AI_PROXY_REDEEM_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ activation_code: code })
      })
      break
    } catch (error) {
      if (attempt === 0 && isSessionError(error)) {
        clearAiProxySession()
        continue
      }
      throw error
    }
  }
  if (!body) throw new Error('业务会话无法建立，请重新打开软件。')
  return {
    ok: body.ok !== false,
    message: typeof body.message === 'string' ? body.message : '积分充值成功。',
    activation: getActivationStatus(),
    addedPoints: Number(body.added_points || 0),
    wallet: parseWallet(body)
  }
}

export async function getProxyReportCharge(reportSessionId: string): Promise<number> {
  const wallet = await getProxyWallet()
  return wallet.ledger
    .filter((entry) => entry.kind === 'usage' && entry.reportSessionId === reportSessionId)
    .reduce((sum, entry) => sum + Math.max(0, -entry.pointsDelta), 0)
}

export async function testProxyHealth(): Promise<{ ok: boolean; message: string; latencyMs: number }> {
  const started = Date.now()
  try {
    await jsonRequest(AI_PROXY_HEALTH_URL, { method: 'GET', headers: { accept: 'application/json' } })
    return { ok: true, message: '业务服务器连接正常。', latencyMs: Date.now() - started }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '业务服务器暂时不可用。', latencyMs: Date.now() - started }
  }
}
