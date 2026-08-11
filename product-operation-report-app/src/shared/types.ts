// 在主进程与渲染进程之间共享的类型定义

/** 单个模型配置（OpenAI 兼容） */
export interface ModelProfile {
  id: string
  name: string // 给用户看的名字，如 "GPT-5.5"
  baseURL: string // 如 https://api.openai.com/v1
  apiKey: string // 落盘时由 safeStorage 加密
  model: string // 模型名
  supportsVision: boolean // 是否支持读图（多模态）
  temperature?: number
}

/** 内置模型的公开状态。真实 API Key 只存在于主进程，不得传给渲染进程。 */
export interface ManagedModelInfo {
  enabled: boolean
  configured: boolean
  name: string
  baseURL: string
  model: string
  supportsVision: boolean
  error?: string
}

/** 应用设置 */
export interface AppSettings {
  profiles: ModelProfile[]
  activeProfileId: string | null
  projectsDir: string // 报告工程默认保存目录
  privacyAccepted: boolean // 是否已确认“资料会发送到当前模型服务商”
  privacyEndpoint?: string // 上次确认隐私说明时使用的模型服务地址
  managedModel?: ManagedModelInfo // 仅公开信息，不包含 API Key
}

/** 聊天消息内容块 */
export interface ActivationStatus {
  activated: boolean
  deviceId: string
  activatedAt?: string
  licenseId?: string
  /** 当前用于软件授权和设备绑定的主激活码；不包含后来输入的积分充值码。 */
  activationCode?: string
  codeCount: number
  appName: string
  source?: 'server' | 'legacy'
  licenseType?: 'credits' | 'unlimited' | 'standard'
  unlimited: boolean
  creditsRemaining?: number
  expiresAt?: string
  offline: boolean
  offlineUntil?: string
  bindingStatus?: 'active' | 'unbound'
  transferCount?: number
  message?: string
}

export interface ActivationResult {
  ok: boolean
  message: string
  status: ActivationStatus
}

export interface ActivationDeactivationResult {
  ok: boolean
  message: string
  status: ActivationStatus
  unbindId?: string
}

export interface LicenseUsageResult {
  ok: boolean
  message: string
  status: ActivationStatus
}

export interface PointsPricingInfo {
  model: string
  currency: 'USD'
  inputUsdPerMillion: number
  outputUsdPerMillion: number
  cachedInputUsdPerMillion: number
  cacheCreationUsdPerMillion: number
  usdCnyRate: number
  pointsPerCny: number
  cnyPerCostPoint: number
  costRate: number
  chargeMultiplier: number
}

export interface PointsLedgerEntry {
  id: string
  createdAt: string
  kind: 'topup' | 'usage' | 'adjustment'
  description: string
  pointsDelta: number
  balanceAfter: number
  reportSessionId?: string
  taskType?: ModelTaskType
}

export interface PointsWalletStatus {
  balancePoints: number
  totalTopupPoints: number
  totalCostPoints: number
  totalChargedPoints: number
  unbilledUsageCount: number
  pricing: PointsPricingInfo
  ledger: PointsLedgerEntry[]
}

export interface PointsAccessResult {
  ok: boolean
  message: string
  wallet: PointsWalletStatus
}

export interface PointsRedeemResult extends PointsAccessResult {
  activation: ActivationStatus
  addedPoints: number
}

export interface UpdateInfo {
  available: boolean
  appName: string
  currentVersion: string
  latestVersion?: string
  minSupportedVersion?: string
  notes: string[]
  force: boolean
  downloaded: boolean
  downloadPath?: string
}

export interface UpdateDownloadProgress {
  receivedBytes: number
  totalBytes?: number
  percent?: number
}

export interface UpdateActionResult {
  ok: boolean
  message: string
  info?: UpdateInfo
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; dataUrl: string } // data:image/png;base64,...

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ContentPart[]
}

/** 模型请求在一份报告中的用途。字段名会沿用到后续服务器代理。 */
export type ModelTaskType =
  | 'source_clean'
  | 'summary'
  | 'analysis_step'
  | 'final_part'
  | 'revision_part'

/** 每次模型请求必须携带的、与提示词内容无关的计量上下文。 */
export interface ModelTaskContext {
  reportSessionId: string
  taskType: ModelTaskType
  taskKey: string
  attempt: number
  isVision: boolean
  sourceCount: number
  imageCount: number
  sourceId?: string
  stepId?: string
  partId?: string
}

/** 模型服务返回的真实 Token；missing 表示服务没有提供 usage。 */
export interface ModelTokenUsage {
  source: 'provider' | 'missing'
  inputTokens: number
  outputTokens: number
  /** outputTokens 中由服务商标记为内部推理的部分，不额外计费。 */
  reasoningTokens: number
  cachedInputTokens: number
  cacheCreationInputTokens: number
  totalTokens: number
  model: string
}

export type TokenUsageStatus = 'started' | 'success' | 'error' | 'aborted'

/** 本地 JSONL 中的隐私安全计量记录，不含资料、提示词、模型回答或密钥。 */
export interface TokenUsageRecord extends ModelTaskContext {
  schemaVersion: 1
  eventType: 'started' | 'final'
  requestId: string
  model: string
  status: TokenUsageStatus
  failureKind?: string
  startedAt: string
  endedAt: string
  durationMs: number
  outputChars: number
  usageSource: 'provider' | 'missing'
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cachedInputTokens: number
  cacheCreationInputTokens: number
  totalTokens: number
  estimatedInputTokens?: number
  estimatedOutputTokens?: number
  estimatedTotalTokens?: number
}

export interface TokenStageSummary {
  taskType: ModelTaskType
  attempts: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cachedInputTokens: number
  cacheCreationInputTokens: number
  totalTokens: number
}

export interface ReportTokenSummary {
  reportSessionId: string
  startedAt: string
  endedAt: string
  completed: boolean
  exact: boolean
  sourceCount: number
  imageCount: number
  attempts: number
  successAttempts: number
  failedAttempts: number
  abortedAttempts: number
  retryAttempts: number
  missingUsageAttempts: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cachedInputTokens: number
  cacheCreationInputTokens: number
  totalTokens: number
  successfulTokens: number
  failedTokens: number
  abortedTokens: number
  retryTokens: number
  estimatedMissingTokens: number
  stages: TokenStageSummary[]
}

export interface TokenUsagePercentiles {
  sampleSize: number
  p50: number
  p75: number
  p95: number
}

export interface TokenUsageBucketSummary {
  label: '1–5份' | '6–10份' | '11–20份' | '21份以上'
  reportCount: number
  exactCompletedCount: number
  averageTotalTokens: number
}

export interface TokenUsageDashboard {
  enabled: boolean
  logPath?: string
  recordCount: number
  providerRecordCount: number
  missingUsageRecordCount: number
  completedExactReports: number
  percentiles: TokenUsagePercentiles
  buckets: TokenUsageBucketSummary[]
  reports: ReportTokenSummary[]
  optimization: TokenOptimizationMetrics
}

export interface TokenOptimizationMetrics {
  localCompletedFiles: number
  sourceCacheHits: number
  skippedModelRequests: number
  reusedReports: number
}

export type CostOptimizationEventType =
  | 'local_source_clean'
  | 'source_cache_hit'
  | 'report_cache_reuse'

export interface CostOptimizationEvent {
  schemaVersion: 1
  id: string
  reportSessionId: string
  type: CostOptimizationEventType
  createdAt: string
  localCompletedFiles: number
  sourceCacheHits: number
  skippedModelRequests: number
  reusedReports: number
}

export interface SourceCleanCacheInput {
  name: string
  kind: 'image' | 'doc' | 'table' | 'other'
  text?: string
  dataUrl?: string
  attribution?: string
  platform?: string
  purpose?: string
  note?: string
}

export interface SourceCleanCacheStats {
  entryCount: number
  totalHits: number
  totalBytes: number
  retentionDays: number
  maxEntries: number
  maxBytes: number
  expiresNextAt?: string
}

export interface SourceCleanCacheLookupResult {
  hit: boolean
  cacheKey: string
  text?: string
  stats: SourceCleanCacheStats
}

export interface SourceCleanCacheStoreResult {
  stored: boolean
  cacheKey: string
  stats: SourceCleanCacheStats
}

export interface ReportResultCacheInput {
  sources: SourceCleanCacheInput[]
  userRequirements: string
}

export interface ReportResultCacheCleanDetail {
  name: string
  text: string
}

export interface ReportResultCacheSnapshot {
  cleanedData: string
  cleanDetails: ReportResultCacheCleanDetail[]
  artifacts: Record<number, string>
  reportMarkdown: string
}

export interface ReportResultCacheStats {
  entryCount: number
  totalHits: number
  totalBytes: number
  retentionDays: number
  maxEntries: number
  maxBytes: number
  expiresNextAt?: string
}

export interface ReportResultCacheLookupResult {
  hit: boolean
  cacheKey: string
  createdAt?: string
  snapshot?: ReportResultCacheSnapshot
  stats: ReportResultCacheStats
}

export interface ReportResultCacheStoreResult {
  stored: boolean
  cacheKey: string
  stats: ReportResultCacheStats
}

export type StepDependencyMap = Readonly<Record<number, readonly number[]>>

export type ProjectPhase = 'idle' | 'cleaning' | 'checkpoint1' | 'analyzing' | 'checkpoint2' | 'done'

export interface ProjectSourceSnapshot {
  id: string
  name: string
  kind: 'image' | 'doc' | 'table' | 'other'
  text?: string
  dataUrl?: string
  error?: string
  warning?: string
  attribution?: string
  platform?: string
  purpose?: string
  note?: string
  size?: number
}

export interface ProjectMessageSnapshot {
  id: string
  role: 'user' | 'assistant'
  text: string
  kind?: 'narration' | 'checkpoint' | 'report-block' | 'error'
}

export interface ProjectCleanDetailSnapshot {
  id: string
  name: string
  text: string
}

export interface SavedProject {
  revision: number
  sources: ProjectSourceSnapshot[]
  messages: ProjectMessageSnapshot[]
  cleanedData: string
  cleanDetails: ProjectCleanDetailSnapshot[]
  artifacts: Record<number, string>
  reportMarkdown: string
  reportStale: boolean
  phase: ProjectPhase
  steering: string
  updatedAt: string
}

/** 测试连通的入参/结果 */
export interface TestModelOptions {
  profile: ModelProfile
  withImageDataUrl?: string // 传入则测试多模态读图
}

export interface TestModelResult {
  ok: boolean
  message: string // 成功时返回模型回复摘要，失败时返回错误
  latencyMs?: number
}

/** 拉取模型列表结果 */
export interface ModelListResult {
  ok: boolean
  models?: string[]
  error?: string
}

/** 压缩包/文件夹展开后的单个条目 */
export interface ArchiveItem {
  name: string
  kind: 'image' | 'doc' | 'table' | 'other'
  size?: number
  text?: string
  dataUrl?: string // 图片
  ok: boolean
  error?: string
  warning?: string
}

/** 报告导出结果 */
export interface ExportResult {
  ok: boolean
  path?: string
  canceled?: boolean
  error?: string
}

/** 文件解析结果（PDF/Word/Markdown/CSV/XLSX 抽取） */
export interface ParsedFile {
  name: string
  kind: 'table' | 'doc' | 'other'
  text: string // 抽取出的文本（表格转 CSV）
  ok: boolean
  error?: string
  warning?: string
}

/** 流式聊天事件（通过 IPC 推送到渲染层） */
export type ChatStreamEvent =
  | { type: 'chunk'; delta: string }
  | { type: 'usage'; usage: ModelTokenUsage }
  | { type: 'done'; full: string; usage: ModelTokenUsage }
  | { type: 'error'; message: string; usage: ModelTokenUsage }

/** SOP 步骤定义（阶段一仅静态展示） */
export interface SopStep {
  id: number
  key: string
  title: string
  confirm: boolean // 是否为人工确认点
}

export const SOP_STEPS: SopStep[] = [
  { id: 1, key: 'product', title: '确定产品', confirm: true },
  { id: 2, key: 'own-sellingpoints', title: '12维产品卖点拆解', confirm: false },
  { id: 3, key: 'competitor-sellingpoints', title: '竞品卖点拆解', confirm: false },
  { id: 4, key: 'ranking', title: '卖点排序', confirm: true },
  { id: 5, key: 'audience', title: '核心人群画像', confirm: true },
  { id: 6, key: 'matrix', title: '内容矩阵', confirm: false },
  { id: 7, key: 'mainline', title: '3-5条视频号内容主线', confirm: true },
  { id: 8, key: 'execution', title: '执行选题表', confirm: true },
  { id: 9, key: 'report', title: '成稿', confirm: true }
]
