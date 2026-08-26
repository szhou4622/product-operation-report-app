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
export type AuthorizationState =
  | 'checking'
  | 'active'
  | 'offline_grace'
  | 'session_expiring'
  | 'session_expired'
  | 'legacy_upgrade'
  | 'unbound'
  | 'disabled'
  | 'expired'
  | 'machine_mismatch'
  | 'credential_revoked'
  | 'vault_unavailable'
  | 'vault_corrupt'
  | 'merged_main_conflict'
  | 'manual_activation_required'

export type ActivationRecoveryAction =
  | 'none'
  | 'retry_status'
  | 'rotate_session'
  | 'upgrade_legacy'
  | 'confirm_saved_code'
  | 'enter_code'
  | 'contact_admin'
  | 'unlock_vault'

export type ActivationVaultStatus = 'ready' | 'missing' | 'unavailable' | 'corrupt'

export interface ActivationStatus {
  activated: boolean
  deviceId: string
  authorizationState: AuthorizationState
  canAutoRecover: boolean
  recoveryAction: ActivationRecoveryAction
  vaultStatus: ActivationVaultStatus
  activatedAt?: string
  licenseId?: string
  /** 当前用于软件授权和设备绑定的主激活码；不包含后来输入的积分充值码。 */
  /** The full code is never included in normal renderer state. */
  activationCodeAvailable: boolean
  maskedActivationCode?: string
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
  requiresRevalidation: boolean
  lastServerSyncAt?: string
  message?: string
}

export interface ActivationCodeAccessResult {
  ok: boolean
  message: string
  /** Present only for the explicit reveal operation. Copy is performed in the main process. */
  activationCode?: string
  maskedCode?: string
}

export interface ActivationDiagnosticResult {
  ok: boolean
  message: string
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
  webSearchUsdPerCall?: number
  webSearchReportLimit?: number
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
  unlimited?: boolean
  totalTopupPoints: number
  totalCostPoints: number
  totalChargedPoints: number
  unbilledUsageCount: number
  pricing: PointsPricingInfo
  ledger: PointsLedgerEntry[]
  stale?: boolean
  warning?: string
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

export interface ContactDisplayState {
  enabled: boolean
  configured: boolean
  imageDataUrl?: string
  updatedAt?: string
  source: 'remote' | 'cache' | 'bundled'
  message: string
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; dataUrl: string } // data:image/png;base64,...

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ContentPart[]
}

export type SearchVerificationStatus = 'verified' | 'attempted' | 'unavailable'

export interface SearchEvidence {
  callId: string
  query?: string
  title?: string
  url: string
  platform: '天猫' | '抖音' | '视频号' | '小红书' | '其他'
  retrievedAt: string
}

/** 模型请求在一份报告中的用途。字段名会沿用到后续服务器代理。 */
export type ModelTaskType =
  | 'source_clean'
  | 'summary'
  | 'analysis_step'
  | 'final_part'
  | 'revision_part'
  | 'module_product_info'
  | 'module_platform_audience'
  | 'module_material_review'
  | 'module_benchmark'
  | 'module_selling_points'
  | 'module_voc'
  | 'module_ranking'
  | 'module_audience_sp_scene'

/** 每次模型请求必须携带的、与提示词内容无关的计量上下文。 */
export interface ModelTaskContext {
  reportSessionId: string
  taskType: ModelTaskType
  taskKey: string
  /** Stable across automatic retries and fallback models for one logical billable task. */
  billingRequestId: string
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

export interface SourceImageAttachment {
  name: string
  size?: number
  dataUrl?: string
  error?: string
}

export interface SourceCleanCacheInput {
  name: string
  kind: 'image' | 'doc' | 'table' | 'other'
  text?: string
  dataUrl?: string
  attachments?: SourceImageAttachment[]
  attribution?: string
  platform?: string
  purpose?: string
  kindV1?: SourceKindV1
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
  engineVersion: ReportEngineVersion
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
  attachments?: SourceImageAttachment[]
  error?: string
  warning?: string
  attribution?: string
  platform?: string
  purpose?: string
  note?: string
  size?: number
  /** Root upload selected by the user. Derived pages/images/ZIP entries share this id. */
  topLevelId?: string
  derivedKind?: 'archive-entry' | 'embedded-image' | 'rendered-page' | 'converted-page'
  kindV1?: SourceKindV1
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
  coverage?: CleaningCoverage
}

export interface CleaningCoverage {
  mode: 'local_exact' | 'model_batches'
  recordCount?: number
  pageCount?: number
  imageCount?: number
  batchCount: number
  verifiedAt: string
}

export interface CleaningCheckpoint {
  completeTaskIds: string[]
  failedTaskIds: string[]
  notStartedTaskIds: string[]
  updatedAt: string
}

export interface ProjectTaskSnapshot {
  kind: 'parse' | 'source_clean' | 'summary' | 'analysis_step' | 'final_part' | 'module'
  status: 'complete' | 'failed' | 'interrupted'
  output?: string
  coverage?: CleaningCoverage
  /** Hash of the exact source/upstream/prompt context used to create this result. */
  inputFingerprint?: string
  searchStatus?: SearchVerificationStatus
  searchEvidence?: SearchEvidence[]
  updatedAt: string
}

export interface SavedProject {
  revision: number
  /** Stable billing namespace retained across crash recovery and project restore. */
  analysisSessionId?: string
  sources: ProjectSourceSnapshot[]
  messages: ProjectMessageSnapshot[]
  cleanedData: string
  cleanDetails: ProjectCleanDetailSnapshot[]
  artifacts: Record<number, string>
  /** Incremental checkpoints used to resume only unfinished model batches after a crash. */
  taskJournal?: Record<string, ProjectTaskSnapshot>
  reportMarkdown: string
  reportStale: boolean
  phase: ProjectPhase
  steering: string
  updatedAt: string
  /** Missing external data chunks encountered during recovery; unaffected project content remains usable. */
  missingBlobs?: string[]
  engineVersion?: ReportEngineVersion
  /** Immutable v1 material retained when an eight-module project is projected into v2. */
  legacyEngineVersion?: 'v1'
  legacyArtifacts?: Record<number, string>
  legacyModuleStates?: Partial<Record<ModuleKey, ModuleRunState>>
  legacyReportMarkdown?: string
  legacyBenchmarkAppendix?: string
  readOnly?: boolean
  legacyNotice?: string
  moduleStates?: Partial<Record<ModuleKey, ModuleRunState>>
}

export interface ProjectStoragePreflight {
  ok: boolean
  message: string
  estimatedBytes: number
  availableBytes?: number
}

/** 测试连通的入参/结果 */
export interface TestModelOptions {
  profile: ModelProfile
  withImageDataUrl?: string // 传入则测试多模态读图
  timeoutMs?: number // 仅主进程测试使用；界面默认 20 秒
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

/** 文件解析结果（图片、Office/ODS、分隔表格、PDF、文本/Markdown、JSON/YAML、网页导出文件） */
export interface ParsedFile {
  name: string
  kind: 'table' | 'doc' | 'other'
  text: string // 抽取出的文本（表格转 CSV）
  /** Word/PPT 中能安全提取的内嵌图片，渲染层会将它们作为独立资料走读图清洗。 */
  attachments?: ArchiveItem[]
  ok: boolean
  error?: string
  warning?: string
}

/** 流式聊天事件（通过 IPC 推送到渲染层） */
export type ChatStreamEvent =
  | { type: 'chunk'; delta: string }
  | { type: 'usage'; usage: ModelTokenUsage }
  | { type: 'search_status'; status: SearchVerificationStatus; searchCalls: number; evidenceCount: number }
  | { type: 'search_evidence'; evidence: SearchEvidence }
  | { type: 'done'; full: string; usage: ModelTokenUsage }
  | { type: 'error'; message: string; usage: ModelTokenUsage }

export type ModuleKey =
  | 'product-info'
  | 'platform-audience'
  | 'material-review'
  | 'benchmark-brands'
  | 'selling-points'
  | 'voc'
  | 'selling-point-ranking'
  | 'audience-sp-scene'

export type ReportEngineVersion = 'v1' | 'v2'

export type SourceKindV1 =
  | 'product-supply'
  | 'business-data'
  | 'material-data'
  | 'audience-data'
  | 'voice-data'

export const SOURCE_KIND_LABELS: Record<SourceKindV1, string> = {
  'product-supply': '产品与供给资料',
  'business-data': '经营与交易数据',
  'material-data': '内容素材与表现数据',
  'audience-data': '人群与行为画像',
  'voice-data': '用户声音与反馈'
}

export function sourceKindLabel(kind: SourceKindV1 | undefined, legacyPurpose = ''): string {
  return kind ? SOURCE_KIND_LABELS[kind] : legacyPurpose.trim()
}

export interface ReportModule {
  id: number
  key: ModuleKey
  title: string
  wave: 1 | 2 | 3 | 4
  dependsOn: ModuleKey[]
  requiredSources: SourceKindV1[]
  hardRequired: boolean
  needsWebSearch: boolean
  promptFile: string
}

export interface ModulePrompt {
  key: ModuleKey
  systemPrompt: string
  outputTemplate: string
  validation: string
  inputDescription: string
  purpose: string
}

export type ModuleRunStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export interface ModuleRunState {
  status: ModuleRunStatus
  message?: string
  updatedAt: string
}

export const REPORT_MODULES_V1: ReportModule[] = [
  { id: 1, key: 'product-info', title: '产品信息', wave: 1, dependsOn: [], requiredSources: ['product-supply'], hardRequired: true, needsWebSearch: false, promptFile: 'M1-product-info.md' },
  { id: 2, key: 'platform-audience', title: '平台人群数据', wave: 1, dependsOn: [], requiredSources: ['audience-data', 'business-data'], hardRequired: false, needsWebSearch: false, promptFile: 'M2-platform-audience.md' },
  { id: 3, key: 'material-review', title: '内容素材判断', wave: 1, dependsOn: [], requiredSources: ['material-data'], hardRequired: false, needsWebSearch: false, promptFile: 'M3-material-review.md' },
  { id: 6, key: 'voc', title: '用户真实需求VOC', wave: 1, dependsOn: [], requiredSources: ['voice-data'], hardRequired: false, needsWebSearch: false, promptFile: 'M6-voc.md' },
  { id: 5, key: 'selling-points', title: '产品卖点', wave: 2, dependsOn: ['product-info'], requiredSources: ['material-data'], hardRequired: false, needsWebSearch: false, promptFile: 'M5-selling-points.md' },
  { id: 4, key: 'benchmark-brands', title: '对标推荐', wave: 3, dependsOn: ['product-info', 'platform-audience', 'material-review'], requiredSources: [], hardRequired: false, needsWebSearch: true, promptFile: 'M4-benchmark-brands.md' },
  { id: 7, key: 'selling-point-ranking', title: '总结卖点排序', wave: 3, dependsOn: ['selling-points', 'material-review'], requiredSources: [], hardRequired: false, needsWebSearch: false, promptFile: 'M7-selling-point-ranking.md' },
  { id: 8, key: 'audience-sp-scene', title: '核心人群×卖点×场景匹配', wave: 4, dependsOn: ['platform-audience', 'selling-points', 'voc', 'selling-point-ranking'], requiredSources: [], hardRequired: false, needsWebSearch: false, promptFile: 'M8-audience-sp-scene.md' }
]

export const REPORT_MODULES_V2: ReportModule[] = [
  { id: 1, key: 'product-info', title: '产品信息', wave: 1, dependsOn: [], requiredSources: ['product-supply'], hardRequired: false, needsWebSearch: false, promptFile: 'M1-product-info.md' },
  { id: 2, key: 'platform-audience', title: '成交人群分析', wave: 1, dependsOn: [], requiredSources: ['audience-data', 'business-data'], hardRequired: false, needsWebSearch: false, promptFile: 'M2-audience-analysis.md' },
  { id: 3, key: 'material-review', title: '内容素材判断', wave: 1, dependsOn: [], requiredSources: ['material-data'], hardRequired: false, needsWebSearch: false, promptFile: 'M3-material-review.md' },
  { id: 5, key: 'voc', title: '用户真实需求VOC', wave: 1, dependsOn: [], requiredSources: ['voice-data'], hardRequired: false, needsWebSearch: false, promptFile: 'M5-voc.md' },
  { id: 4, key: 'selling-points', title: '卖点提炼与排序', wave: 2, dependsOn: ['product-info', 'material-review'], requiredSources: ['product-supply', 'material-data'], hardRequired: false, needsWebSearch: false, promptFile: 'M4-selling-point-strategy.md' },
  { id: 6, key: 'audience-sp-scene', title: '人群×卖点×场景匹配', wave: 3, dependsOn: ['platform-audience', 'selling-points', 'voc'], requiredSources: [], hardRequired: false, needsWebSearch: false, promptFile: 'M6-audience-sp-scene.md' }
]

/** Active report engine configuration. Legacy v1 remains available for deterministic migration only. */
export const REPORT_MODULES = REPORT_MODULES_V2

export function reportModulesForEngine(engineVersion: ReportEngineVersion | undefined): ReportModule[] {
  return engineVersion === 'v1' ? REPORT_MODULES_V1 : REPORT_MODULES_V2
}

/** Legacy 0.4.x steps are retained only for read-only project display. */
export interface SopStep {
  id: number
  key: string
  title: string
  confirm: boolean // 是否为人工确认点
}

export const LEGACY_SOP_STEPS: SopStep[] = [
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

/** @deprecated The module engine uses REPORT_MODULES_V2. Kept for pre-module legacy report rendering. */
export const SOP_STEPS = LEGACY_SOP_STEPS
