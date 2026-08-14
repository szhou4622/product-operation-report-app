import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type {
  ActivationStatus,
  PointsAccessResult,
  PointsLedgerEntry,
  PointsPricingInfo,
  PointsWalletStatus,
  TokenUsageRecord
} from '../shared/types'
import { LICENSE_APP_NAME } from './serviceConfig'

const WALLET_FILE = () => join(app.getPath('userData'), 'points-wallet.json')
const WALLET_BACKUP_FILE = () => `${WALLET_FILE()}.bak`
const MILLI_POINTS = 1_000
const MAX_LEDGER = 1_000
const MAX_IDS = 50_000

interface StoredLedgerEntry extends Omit<PointsLedgerEntry, 'pointsDelta' | 'balanceAfter'> {
  pointsDeltaMilli: number
  balanceAfterMilli: number
}

interface StoredWallet {
  version: 1
  billingStartedAt: string
  balanceMilli: number
  totalTopupMilli: number
  totalCostMilli: number
  totalChargedMilli: number
  appliedTopupIds: string[]
  billedRequestIds: string[]
  unbilledRequestIds: string[]
  ledger: StoredLedgerEntry[]
}

type ModelTokenPrices = Pick<
  PointsPricingInfo,
  'inputUsdPerMillion' | 'outputUsdPerMillion' | 'cachedInputUsdPerMillion' | 'cacheCreationUsdPerMillion'
>

const MODEL_PRICES: Readonly<Record<string, ModelTokenPrices>> = {
  'gpt-5.5': {
    inputUsdPerMillion: 1.25,
    outputUsdPerMillion: 7.5,
    cachedInputUsdPerMillion: 0.125,
    cacheCreationUsdPerMillion: 0.8
  },
  'claude-sonnet-4-6': {
    inputUsdPerMillion: 0.4,
    outputUsdPerMillion: 2,
    cachedInputUsdPerMillion: 0.04,
    cacheCreationUsdPerMillion: 0.2
  },
  'gemini-3-flash': {
    inputUsdPerMillion: 1.2,
    outputUsdPerMillion: 6,
    cachedInputUsdPerMillion: 0.12,
    cacheCreationUsdPerMillion: 0.6
  },
  'kimi-k2.6': {
    inputUsdPerMillion: 0.8,
    outputUsdPerMillion: 4,
    cachedInputUsdPerMillion: 0.08,
    cacheCreationUsdPerMillion: 0.4
  }
}

const DEFAULT_PRICING: PointsPricingInfo = {
  model: 'gpt-5.5',
  currency: 'USD',
  ...MODEL_PRICES['gpt-5.5'],
  usdCnyRate: 7.2,
  pointsPerCny: 100,
  cnyPerCostPoint: 0.01,
  costRate: 0.5,
  chargeMultiplier: 2
}

function envNumber(name: string, fallback: number, min: number, max: number): number {
  if (app.isPackaged || process.env.PRODUCT_REPORT_ALLOW_DEV_OVERRIDES !== '1') return fallback
  const parsed = Number(process.env[name])
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback
}

function configuredPricingModel(model: string): string | undefined {
  const normalized = model.trim().toLowerCase()
  return Object.keys(MODEL_PRICES).find((candidate) =>
    normalized === candidate || normalized.startsWith(`${candidate}-`)
  )
}

export function getPointsPricing(model = DEFAULT_PRICING.model): PointsPricingInfo {
  const configuredModel = configuredPricingModel(model) || DEFAULT_PRICING.model
  const usdCnyRate = envNumber('PRODUCT_REPORT_USD_CNY_RATE', DEFAULT_PRICING.usdCnyRate, 1, 20)
  const pointsPerCny = envNumber('PRODUCT_REPORT_POINTS_PER_CNY', DEFAULT_PRICING.pointsPerCny, 0.01, 10_000)
  const costRate = envNumber('PRODUCT_REPORT_COST_RATE', DEFAULT_PRICING.costRate, 0.01, 1)
  return {
    ...DEFAULT_PRICING,
    ...MODEL_PRICES[configuredModel],
    model: configuredModel,
    usdCnyRate,
    pointsPerCny,
    cnyPerCostPoint: 1 / pointsPerCny,
    costRate,
    chargeMultiplier: 1 / costRate
  }
}

function emptyWallet(): StoredWallet {
  return {
    version: 1,
    billingStartedAt: new Date().toISOString(),
    balanceMilli: 0,
    totalTopupMilli: 0,
    totalCostMilli: 0,
    totalChargedMilli: 0,
    appliedTopupIds: [],
    billedRequestIds: [],
    unbilledRequestIds: [],
    ledger: []
  }
}

function finiteInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : 0
}

function parseWallet(raw: string): StoredWallet | null {
  try {
    const value = JSON.parse(raw) as Partial<StoredWallet>
    if (value.version !== 1 || !Array.isArray(value.ledger)) return null
    return {
      version: 1,
      billingStartedAt: typeof value.billingStartedAt === 'string' ? value.billingStartedAt : new Date().toISOString(),
      balanceMilli: finiteInteger(value.balanceMilli),
      totalTopupMilli: Math.max(0, finiteInteger(value.totalTopupMilli)),
      totalCostMilli: Math.max(0, finiteInteger(value.totalCostMilli)),
      totalChargedMilli: Math.max(0, finiteInteger(value.totalChargedMilli)),
      appliedTopupIds: Array.isArray(value.appliedTopupIds)
        ? value.appliedTopupIds.filter((id): id is string => typeof id === 'string').slice(-MAX_IDS)
        : [],
      billedRequestIds: Array.isArray(value.billedRequestIds)
        ? value.billedRequestIds.filter((id): id is string => typeof id === 'string').slice(-MAX_IDS)
        : [],
      unbilledRequestIds: Array.isArray(value.unbilledRequestIds)
        ? value.unbilledRequestIds.filter((id): id is string => typeof id === 'string').slice(-MAX_IDS)
        : [],
      ledger: value.ledger.slice(-MAX_LEDGER) as StoredLedgerEntry[]
    }
  } catch {
    return null
  }
}

function readWallet(): StoredWallet {
  for (const path of [WALLET_FILE(), WALLET_BACKUP_FILE()]) {
    try {
      if (!existsSync(path)) continue
      const parsed = parseWallet(readFileSync(path, 'utf8'))
      if (parsed) return parsed
    } catch {
      // 主文件损坏时继续读取备份。
    }
  }
  return emptyWallet()
}

function writeWallet(wallet: StoredWallet): void {
  const path = WALLET_FILE()
  const backup = WALLET_BACKUP_FILE()
  const temp = `${path}.tmp`
  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path)) copyFileSync(path, backup)
  writeFileSync(temp, JSON.stringify(wallet), { encoding: 'utf8', mode: 0o600 })
  try {
    renameSync(temp, path)
  } catch {
    rmSync(path, { force: true })
    renameSync(temp, path)
  }
}

function roundPoints(milli: number): number {
  return Math.round(milli) / MILLI_POINTS
}

function ceilMilliPoints(points: number): number {
  const raw = Math.max(0, points) * MILLI_POINTS
  const nearest = Math.round(raw)
  return Math.abs(raw - nearest) < 1e-7 ? nearest : Math.ceil(raw)
}

function publicEntry(entry: StoredLedgerEntry): PointsLedgerEntry {
  return {
    id: entry.id,
    createdAt: entry.createdAt,
    kind: entry.kind,
    description: entry.description,
    pointsDelta: roundPoints(entry.pointsDeltaMilli),
    balanceAfter: roundPoints(entry.balanceAfterMilli),
    reportSessionId: entry.reportSessionId,
    taskType: entry.taskType
  }
}

function toStatus(wallet: StoredWallet): PointsWalletStatus {
  return {
    balancePoints: roundPoints(wallet.balanceMilli),
    totalTopupPoints: roundPoints(wallet.totalTopupMilli),
    totalCostPoints: roundPoints(wallet.totalCostMilli),
    totalChargedPoints: roundPoints(wallet.totalChargedMilli),
    unbilledUsageCount: wallet.unbilledRequestIds.length,
    pricing: getPointsPricing(),
    ledger: wallet.ledger.slice(-50).reverse().map(publicEntry)
  }
}

function appendLedger(wallet: StoredWallet, entry: StoredLedgerEntry): void {
  wallet.ledger = [...wallet.ledger, entry].slice(-MAX_LEDGER)
}

export function getPointsWalletStatus(): PointsWalletStatus {
  return toStatus(readWallet())
}

export function getReportChargedPoints(reportSessionId: string): number {
  const id = reportSessionId.trim().slice(0, 240)
  if (!id) return 0
  const chargedMilli = readWallet().ledger
    .filter((entry) => entry.kind === 'usage' && entry.reportSessionId === id)
    .reduce((sum, entry) => sum + Math.max(0, -entry.pointsDeltaMilli), 0)
  return roundPoints(chargedMilli)
}

export function applyActivationPoints(status: ActivationStatus): { addedPoints: number; wallet: PointsWalletStatus } {
  const points = status.licenseType === 'credits'
    ? Math.round((status.creditsRemaining || 0) * MILLI_POINTS) / MILLI_POINTS
    : 0
  const bindingSuffix = (status.transferCount || 0) > 0 ? `:binding:${status.transferCount}` : ''
  const topupId = status.licenseId ? `activation:${status.licenseId}${bindingSuffix}` : ''
  const wallet = readWallet()
  if (
    !status.activated ||
    status.appName !== LICENSE_APP_NAME ||
    !topupId ||
    points <= 0 ||
    wallet.appliedTopupIds.includes(topupId)
  ) {
    return { addedPoints: 0, wallet: toStatus(wallet) }
  }
  const isRebinding = (status.transferCount || 0) > 0
  const delta = isRebinding
    ? Math.round(points * MILLI_POINTS) - wallet.balanceMilli
    : Math.round(points * MILLI_POINTS)
  wallet.balanceMilli += delta
  if (!isRebinding) wallet.totalTopupMilli += delta
  wallet.appliedTopupIds = [...wallet.appliedTopupIds, topupId].slice(-MAX_IDS)
  appendLedger(wallet, {
    id: topupId,
    createdAt: new Date().toISOString(),
    kind: isRebinding ? 'adjustment' : 'topup',
    description: isRebinding ? `换设备恢复 ${points} 积分` : `激活码充值 ${points} 积分`,
    pointsDeltaMilli: delta,
    balanceAfterMilli: wallet.balanceMilli
  })
  writeWallet(wallet)
  return { addedPoints: isRebinding ? Math.max(0, roundPoints(delta)) : points, wallet: toStatus(wallet) }
}

export function applyRechargeCodePoints(
  grantId: string,
  points: number
): { addedPoints: number; wallet: PointsWalletStatus } {
  const safeGrantId = grantId.trim().slice(0, 160)
  const safePoints = Math.round(points * MILLI_POINTS) / MILLI_POINTS
  const wallet = readWallet()
  if (!safeGrantId || !Number.isFinite(safePoints) || safePoints <= 0) {
    return { addedPoints: 0, wallet: toStatus(wallet) }
  }
  const topupId = `recharge:${safeGrantId}`
  if (wallet.appliedTopupIds.includes(topupId)) {
    return { addedPoints: 0, wallet: toStatus(wallet) }
  }
  const delta = Math.round(safePoints * MILLI_POINTS)
  wallet.balanceMilli += delta
  wallet.totalTopupMilli += delta
  wallet.appliedTopupIds = [...wallet.appliedTopupIds, topupId].slice(-MAX_IDS)
  appendLedger(wallet, {
    id: topupId,
    createdAt: new Date().toISOString(),
    kind: 'topup',
    description: `积分码充值 ${safePoints} 积分`,
    pointsDeltaMilli: delta,
    balanceAfterMilli: wallet.balanceMilli
  })
  writeWallet(wallet)
  return { addedPoints: safePoints, wallet: toStatus(wallet) }
}

export function clearLocalPointsAfterUnbind(unbindId: string): PointsWalletStatus {
  const safeId = unbindId.trim().slice(0, 160)
  if (!safeId) throw new Error('缺少设备解绑记录。')
  const wallet = readWallet()
  const operationId = `device-unbind:${safeId}`
  if (wallet.appliedTopupIds.includes(operationId)) return toStatus(wallet)
  const delta = -wallet.balanceMilli
  wallet.balanceMilli = 0
  wallet.appliedTopupIds = [...wallet.appliedTopupIds, operationId].slice(-MAX_IDS)
  appendLedger(wallet, {
    id: operationId,
    createdAt: new Date().toISOString(),
    kind: 'adjustment',
    description: '本机解除绑定，剩余积分由服务器保留',
    pointsDeltaMilli: delta,
    balanceAfterMilli: 0
  })
  writeWallet(wallet)
  return toStatus(wallet)
}

export function calculateUsagePoints(record: TokenUsageRecord): {
  costPoints: number
  chargedPoints: number
  costMilli: number
  chargedMilli: number
} | null {
  const pricingModel = configuredPricingModel(record.model)
  if (record.eventType !== 'final' || record.usageSource !== 'provider' || !pricingModel) return null
  const pricing = getPointsPricing(pricingModel)
  const regularInput = Math.max(
    0,
    record.inputTokens - record.cachedInputTokens - record.cacheCreationInputTokens
  )
  const costUsd =
    (regularInput * pricing.inputUsdPerMillion +
      record.outputTokens * pricing.outputUsdPerMillion +
      record.cachedInputTokens * pricing.cachedInputUsdPerMillion +
      record.cacheCreationInputTokens * pricing.cacheCreationUsdPerMillion) /
    1_000_000
  const costPoints = costUsd * pricing.usdCnyRate * pricing.pointsPerCny
  const chargedPoints = costPoints * pricing.chargeMultiplier
  const costMilli = ceilMilliPoints(costPoints)
  const chargedMilli = ceilMilliPoints(chargedPoints)
  return { costPoints: roundPoints(costMilli), chargedPoints: roundPoints(chargedMilli), costMilli, chargedMilli }
}

export function settleTokenUsage(record: TokenUsageRecord): PointsWalletStatus {
  if (record.eventType !== 'final') return getPointsWalletStatus()
  const wallet = readWallet()
  if (wallet.billedRequestIds.includes(record.requestId) || wallet.unbilledRequestIds.includes(record.requestId)) {
    return toStatus(wallet)
  }
  if (Date.parse(record.endedAt) < Date.parse(wallet.billingStartedAt)) {
    wallet.billedRequestIds = [...wallet.billedRequestIds, record.requestId].slice(-MAX_IDS)
    writeWallet(wallet)
    return toStatus(wallet)
  }
  const charge = calculateUsagePoints(record)
  if (!charge) {
    wallet.unbilledRequestIds = [...wallet.unbilledRequestIds, record.requestId].slice(-MAX_IDS)
    writeWallet(wallet)
    return toStatus(wallet)
  }
  wallet.balanceMilli -= charge.chargedMilli
  wallet.totalCostMilli += charge.costMilli
  wallet.totalChargedMilli += charge.chargedMilli
  wallet.billedRequestIds = [...wallet.billedRequestIds, record.requestId].slice(-MAX_IDS)
  appendLedger(wallet, {
    id: `usage:${record.requestId}`,
    createdAt: record.endedAt,
    kind: 'usage',
    description: `${record.taskType === 'source_clean' ? '资料清洗' : record.taskType === 'summary' ? '资料汇总' : record.taskType === 'analysis_step' ? `分析步骤 ${record.stepId || ''}`.trim() : record.taskType === 'final_part' ? '最终成稿' : '报告修订'}`,
    pointsDeltaMilli: -charge.chargedMilli,
    balanceAfterMilli: wallet.balanceMilli,
    reportSessionId: record.reportSessionId,
    taskType: record.taskType
  })
  writeWallet(wallet)
  return toStatus(wallet)
}

export function reconcileTokenUsage(records: TokenUsageRecord[]): PointsWalletStatus {
  for (const record of records) settleTokenUsage(record)
  return getPointsWalletStatus()
}

export function canStartPointsReport(activation: ActivationStatus): PointsAccessResult {
  const seeded = applyActivationPoints(activation).wallet
  if (!activation.activated) return { ok: false, message: '软件授权不可用，请先激活。', wallet: seeded }
  if (seeded.balancePoints <= 0) {
    return {
      ok: false,
      message: seeded.balancePoints < 0
        ? `当前欠费 ${Math.abs(seeded.balancePoints).toFixed(2)} 积分，请充值后再生成新报告。`
        : '积分不足，请先输入新的积分充值码。',
      wallet: seeded
    }
  }
  return { ok: true, message: '积分可用；将按 CCG 返回的真实 Token 结算。', wallet: seeded }
}

export function grantDevelopmentPoints(points: number, id = 'manual'): PointsWalletStatus {
  if (app.isPackaged) throw new Error('正式安装版不允许本地增加积分。')
  const safePoints = Math.floor(points)
  if (safePoints <= 0 || safePoints > 10_000_000) throw new Error('开发积分数量无效。')
  const wallet = readWallet()
  const topupId = `development:${id}`
  if (wallet.appliedTopupIds.includes(topupId)) return toStatus(wallet)
  const delta = safePoints * MILLI_POINTS
  wallet.balanceMilli += delta
  wallet.totalTopupMilli += delta
  wallet.appliedTopupIds.push(topupId)
  appendLedger(wallet, {
    id: topupId,
    createdAt: new Date().toISOString(),
    kind: 'adjustment',
    description: `开发测试增加 ${safePoints} 积分`,
    pointsDeltaMilli: delta,
    balanceAfterMilli: wallet.balanceMilli
  })
  writeWallet(wallet)
  return toStatus(wallet)
}

export function getPointsWalletFilePath(): string {
  return WALLET_FILE()
}

export const pointsWalletInternals = {
  resetForTests(): void {
    rmSync(WALLET_FILE(), { force: true })
    rmSync(WALLET_BACKUP_FILE(), { force: true })
  }
}
