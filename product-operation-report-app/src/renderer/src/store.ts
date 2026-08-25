import { create } from 'zustand'
import { buildEvidenceSourceNameMap, reportMarkdownForDisplay } from '../../shared/reportDisplay'
import type {
  AppSettings,
  CostOptimizationEvent,
  CleaningCoverage,
  ProjectCleanDetailSnapshot,
  ReportResultCacheInput,
  ReportResultCacheLookupResult,
  ReportResultCacheSnapshot,
  SavedProject,
  SourceCleanCacheInput,
  SourceImageAttachment,
  StepDependencyMap,
  ProjectTaskSnapshot,
  SourceKindV1,
  ModuleKey,
  ModuleRunState,
  ReportEngineVersion
} from '../../shared/types'
import { REPORT_MODULES, REPORT_MODULES_V2, SOP_STEPS } from '../../shared/types'
import { FINAL_REPORT_PARTS } from './reportTemplate'
import {
  buildExtractMessages,
  type PriorOutput
} from './sop'
import { buildLocalTableCleanDetail, preprocessTableForModel } from './tablePreprocess'
import {
  buildSourceCleanBatchPlan,
  combineSourceCleanBatchOutputs,
  missingSourceCleanEvidenceIds
} from './sourceCleanBatches'
import { validateReportEvidenceLinks, validateReportStructure } from './validate'
import { friendlyError } from './store/errors'
import { buildProjectSnapshot } from './store/persistence'
import { mergeRevisionParts, runFinalReportInParts, runModelRetry, selectRevisionParts } from './store/analysis'
import { isTemporaryReservationContention, planCleaningConcurrency } from './store/cleaning'
import {
  buildCleaningPlan,
  type CleaningMethod,
  type CleaningPlan
} from './cleaningPlan'
import {
  MODULE_TASK_TYPES,
  assembleModuleReport,
  buildModuleMessages,
  evaluateSourceSufficiency,
  findStaleModuleKeys,
  fingerprintModuleMessages,
  isNoAnalysisOutput,
  moduleValidationRetryInstruction,
  normalizeMaterialReviewOutput,
  normalizeNoAnalysisOutput,
  projectLegacyV1ToV2,
  retryScopeForModules,
  validateModuleOutput
} from './modules'
import { inferSourcePlatform } from './sourceMetadata'

export { friendlyError } from './store/errors'
export { buildProjectSnapshot } from './store/persistence'
export { mergeRevisionParts, selectRevisionParts } from './store/analysis'

export interface Source {
  id: string
  name: string
  kind: 'image' | 'doc' | 'table' | 'other'
  dataUrl?: string
  attachments?: SourceImageAttachment[]
  text?: string
  size?: number
  parsing?: boolean
  error?: string
  warning?: string
  attribution?: string // 用户指定归属：自有数据 / 竞品数据 / ''(未定)
  platform?: string // 用户指定平台/来源：巨量云图 / 抖店罗盘 / 视频号 / 抖音 / 有米云...
  purpose?: string // 用户指定信息类型：人群画像数据 / 内容素材数据 / 交易数据 / 产品手卡...
  kindV1?: SourceKindV1 // v1 业务资料类型，与文件格式分类正交
  note?: string // 用户对这份文件的补充信息（平台/时间/内容/文件外说明）
  topLevelId?: string // 用户主动选择的顶层文件；派生页/图片/ZIP条目共享该ID
  derivedKind?: 'archive-entry' | 'embedded-image' | 'rendered-page' | 'converted-page'
}

const PARSE_CONCURRENCY = 2
export const MAX_CLEANING_CONCURRENCY = 4
const REPORT_STEP_ID = SOP_STEPS[SOP_STEPS.length - 1]?.id ?? 9
const CLEAN_DETAIL_MARKER = '\n\n---\n## 各来源清洗明细'
const moduleByTitle = (key: ModuleKey): string => {
  const module = REPORT_MODULES.find((candidate) => candidate.key === key)
  return module ? `M${module.id} ${module.title}` : key
}
const persistentSteering = (value: string): string =>
  value.split(/\r?\n/u).filter((line) => !/^\s*重试\s*(?:模块\s*)?M?[1-6]\b/iu.test(line)).join('\n').trim()

const MAX_SINGLE_FILE_BYTES = 40 * 1024 * 1024
const MAX_TOTAL_UPLOAD_BYTES = 350 * 1024 * 1024
const MAX_IMAGE_FILE_BYTES = 25 * 1024 * 1024
const MAX_SOURCE_FILES = 50
let cleaningCheckpointSaveTimer: ReturnType<typeof setTimeout> | null = null

function formatPointsValue(value: number): string {
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 3 })
}

function scheduleCleaningCheckpointSave(getState: () => StoreState): void {
  if (cleaningCheckpointSaveTimer) clearTimeout(cleaningCheckpointSaveTimer)
  cleaningCheckpointSaveTimer = setTimeout(() => {
    cleaningCheckpointSaveTimer = null
    void window.api.saveLastProject(buildProjectSnapshot(getState())).catch(() => undefined)
  }, 500)
}

export function topLevelSourceCount(sources: Pick<Source, 'id' | 'topLevelId'>[]): number {
  return new Set(sources.map((source) => source.topLevelId || source.id)).size
}

export function derivedSourceCount(sources: Pick<Source, 'derivedKind' | 'attachments'>[]): number {
  return sources.reduce((sum, source) => sum + (source.derivedKind ? 1 : 0) + (source.attachments?.length || 0), 0)
}

function sourceHasContent(source: Pick<Source, 'text' | 'dataUrl' | 'attachments'>): boolean {
  return Boolean(source.text || source.dataUrl || source.attachments?.some((item) => item.dataUrl))
}

function sourceImageCount(sources: Pick<Source, 'kind' | 'dataUrl' | 'attachments'>[]): number {
  return sources.reduce(
    (sum, source) => sum + (source.dataUrl || source.kind === 'image' ? 1 : 0) + (source.attachments?.filter((item) => item.dataUrl).length || 0),
    0
  )
}

function groupLegacyOfficeDerivedSources(sources: Source[]): {
  sources: Source[]
  derivedParentIds: Map<string, string>
} {
  const parents = new Map(sources.filter((source) => !source.derivedKind).map((source) => [source.id, { ...source }]))
  const derivedParentIds = new Map<string, string>()
  const retained: Source[] = []
  for (const source of sources) {
    const parentId = source.topLevelId
    const parent = parentId ? parents.get(parentId) : undefined
    if (
      parent && source.kind === 'image' &&
      (source.derivedKind === 'embedded-image' || source.derivedKind === 'rendered-page')
    ) {
      parent.attachments = [
        ...(parent.attachments || []),
        { name: source.name, size: source.size, dataUrl: source.dataUrl, error: source.error }
      ]
      derivedParentIds.set(source.id, parent.id)
      continue
    }
    if (!source.derivedKind) retained.push(parent || source)
    else retained.push(source)
  }
  return { sources: retained, derivedParentIds }
}

function groupLegacyOfficeCleanDetails(
  details: { id: string; name: string; text: string }[],
  derivedParentIds: Map<string, string>,
  sources: Source[]
): { id: string; name: string; text: string }[] {
  if (!derivedParentIds.size) return details
  const names = new Map(sources.map((source) => [source.id, source.name]))
  const grouped = new Map<string, { id: string; name: string; text: string }>()
  for (const detail of details) {
    const id = derivedParentIds.get(detail.id) || detail.id
    const previous = grouped.get(id)
    grouped.set(id, previous
      ? { ...previous, text: `${previous.text}\n\n### 内嵌图片清洗补充：${detail.name}\n${detail.text}` }
      : { id, name: names.get(id) || detail.name, text: detail.text })
  }
  return [...grouped.values()]
}

export function evidenceScopeStats(
  sources: Pick<Source, 'kind' | 'text' | 'dataUrl' | 'attachments'>[],
  cleanDetails: Pick<ProjectCleanDetailSnapshot, 'text'>[] = []
): { worksheets: number; pages: number; images: number; records: number } {
  const worksheets = sources.reduce((sum, source) =>
    sum + (source.text?.match(/^###\s*工作表：/gmu)?.length || 0), 0)
  const pages = sources.reduce((sum, source) =>
    sum + (source.text?.match(/^---\s*第\s*\d+\s*页\s*---/gmu)?.length || 0), 0)
  const images = sources.reduce(
    (sum, source) => sum + (source.dataUrl || source.kind === 'image' ? 1 : 0) + (source.attachments?.length || 0),
    0
  )
  const records = cleanDetails.reduce((sum, detail) => {
    const match = detail.text.match(/原始有效记录[：:]\s*(\d+)\s*条/u) ||
      detail.text.match(/逐行生成(?:并核对)?\s*(\d+)\s*个/u)
    return sum + (match ? Number(match[1]) : 0)
  }, 0)
  return { worksheets, pages, images, records }
}

export const STEP_DEPENDENCY_MAP: StepDependencyMap = Object.freeze({
  1: Object.freeze([]),
  2: Object.freeze([1]),
  3: Object.freeze([1, 2]),
  4: Object.freeze([1, 2, 3]),
  5: Object.freeze([1, 4]),
  6: Object.freeze([4, 5]),
  7: Object.freeze([4, 5, 6]),
  8: Object.freeze([5, 6, 7])
})

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)}MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`
  return `${bytes}B`
}

export type Phase = 'idle' | 'cleaning' | 'checkpoint1' | 'analyzing' | 'checkpoint2' | 'done'

export interface ChatMsg {
  id: string
  role: 'user' | 'assistant'
  text: string
  kind?: 'narration' | 'checkpoint' | 'report-block' | 'error'
}

export interface CleaningProgress {
  total: number
  done: number
  running: string[]
  failed: number
  startedAt?: number
  plan?: CleaningPlan
  files: Record<string, {
    name: string
    method: CleaningMethod
    status: 'waiting' | 'running' | 'complete' | 'failed' | 'not_started'
    doneJobs: number
    totalJobs: number
  }>
}

const emptyCleaningProgress = (): CleaningProgress => ({ total: 0, done: 0, running: [], failed: 0, files: {} })
const isRunningPhase = (phase: Phase): boolean => phase === 'cleaning' || phase === 'analyzing'

function toSourceCleanCacheInput(source: Source): SourceCleanCacheInput {
  return {
    name: source.name,
    kind: source.kind,
    text: source.text,
    dataUrl: source.dataUrl,
    attachments: source.attachments,
    attribution: source.attribution,
    platform: source.platform,
    purpose: source.purpose,
    kindV1: source.kindV1,
    note: source.note
  }
}

function reportResultCacheInput(sources: Source[], userRequirements: string): ReportResultCacheInput {
  return {
    sources: sources.filter(sourceHasContent).map(toSourceCleanCacheInput),
    userRequirements,
    engineVersion: 'v2'
  }
}

function hasCompleteReportSections(markdown: string): boolean {
  const legacy = Array.from({ length: 12 }, (_, section) =>
    new RegExp(`^##\\s+${section}(?:\\.|、|\\s)`, 'mu').test(markdown)
  ).every(Boolean)
  const v1 = Array.from({ length: 8 }, (_, index) =>
    new RegExp(`^##\\s+M${index + 1}\\s+`, 'mu').test(markdown)
  ).every(Boolean) && /本报告内容由 AI 生成，请谨慎参考/u.test(markdown)
  const v2 = Array.from({ length: 6 }, (_, index) =>
    new RegExp(`^##\\s+M${index + 1}\\s+`, 'mu').test(markdown)
  ).every(Boolean) && /本报告内容由 AI 生成，请谨慎参考/u.test(markdown)
  return legacy || v1 || v2
}

function validReportCacheSnapshot(snapshot: ReportResultCacheSnapshot | undefined): snapshot is ReportResultCacheSnapshot {
  if (!snapshot?.cleanedData.trim() || !snapshot.reportMarkdown.trim()) return false
  if (!hasCompleteReportSections(snapshot.reportMarkdown)) return false
  return REPORT_MODULES.every((module) => snapshot.artifacts[module.id]?.trim()) && Boolean(snapshot.artifacts[REPORT_STEP_ID]?.trim())
}

function snapshotForReportCache(state: StoreState): ReportResultCacheSnapshot | null {
  if (!hasCompleteReportSections(state.reportMarkdown)) return null
  if (!REPORT_MODULES.every((module) => state.artifacts[module.id]?.trim()) || !state.artifacts[REPORT_STEP_ID]?.trim()) return null
  const detailsById = new Map(state.cleanDetails.map((detail) => [detail.id, detail]))
  const cleanDetails = state.sources.flatMap((source) => {
    const detail = detailsById.get(source.id)
    return detail ? [{ name: source.name, text: detail.text }] : []
  })
  if (cleanDetails.length !== state.sources.filter(sourceHasContent).length) return null
  return {
    cleanedData: state.cleanedData,
    cleanDetails,
    artifacts: { ...state.artifacts },
    reportMarkdown: state.reportMarkdown
  }
}

async function storeCompleteReportResult(state: StoreState): Promise<void> {
  const snapshot = snapshotForReportCache(state)
  if (!snapshot) return
  await window.api.storeReportResultCache(
    reportResultCacheInput(state.sources, state.steering),
    snapshot
  )
}

function optimizationEvent(
  id: string,
  reportSessionId: string,
  type: CostOptimizationEvent['type'],
  values: Partial<Pick<CostOptimizationEvent, 'localCompletedFiles' | 'sourceCacheHits' | 'skippedModelRequests' | 'reusedReports'>>
): CostOptimizationEvent {
  return {
    schemaVersion: 1,
    id,
    reportSessionId,
    type,
    createdAt: new Date().toISOString(),
    localCompletedFiles: values.localCompletedFiles || 0,
    sourceCacheHits: values.sourceCacheHits || 0,
    skippedModelRequests: values.skippedModelRequests || 0,
    reusedReports: values.reusedReports || 0
  }
}

async function recordOptimizationEvent(event: CostOptimizationEvent): Promise<void> {
  const api = window.api as typeof window.api & {
    recordCostOptimization?: typeof window.api.recordCostOptimization
  }
  if (typeof api.recordCostOptimization !== 'function') return
  await api.recordCostOptimization(event).catch(() => undefined)
}

export function priorOutputsForStep(
  stepId: number,
  artifacts: Record<number, string>
): PriorOutput[] {
  const dependencies = STEP_DEPENDENCY_MAP[stepId] || []
  return dependencies.flatMap((id) => {
    const output = artifacts[id]
    const step = SOP_STEPS.find((candidate) => candidate.id === id)
    return output && step ? [{ id, title: `第${id}步 ${step.title}`, output }] : []
  })
}

const isUserStop = (value: unknown): boolean => /已停止|aborted/i.test(String(value || ''))

function restorePhase(project: SavedProject): Phase {
  if (project.phase === 'cleaning') return 'idle'
  if (project.phase === 'analyzing') return project.cleanedData ? 'checkpoint1' : 'idle'
  return project.phase as Phase
}

function classify(name: string): Source['kind'] {
  const ext = name.toLowerCase().split('.').pop() || ''
  if (['png', 'jpg', 'jpeg'].includes(ext)) return 'image'
  if (['xlsx', 'xls', 'xlsm', 'xlsb', 'ods', 'csv', 'tsv'].includes(ext)) return 'table'
  if (['pdf', 'doc', 'docx', 'pptx', 'webp', 'gif', 'tif', 'tiff', 'avif', 'heic', 'heif', 'md', 'markdown', 'txt', 'log', 'yaml', 'yml', 'rtf', 'json', 'jsonl', 'ndjson', 'html', 'htm', 'xml'].includes(ext)) return 'doc'
  return 'other'
}

const SUPPORTED_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'webp', 'gif',
  'xlsx', 'xls', 'xlsm', 'xlsb', 'ods', 'csv', 'tsv',
  'pdf', 'doc', 'docx', 'pptx', 'tif', 'tiff', 'avif', 'heic', 'heif', 'md', 'markdown', 'txt', 'log', 'yaml', 'yml', 'rtf',
  'json', 'jsonl', 'ndjson', 'html', 'htm', 'xml',
  'zip'
])
const extOf = (n: string): string => n.toLowerCase().split('.').pop() || ''
const isJunkName = (n: string): boolean => {
  const b = n.split('/').pop() || n
  return b.startsWith('.') || b.startsWith('~$') || b === 'Thumbs.db'
}
const displayName = (f: File): string => {
  const rel = (f as unknown as { webkitRelativePath?: string }).webkitRelativePath
  return rel && rel !== '' ? rel : f.name
}

const inferAttribution = (name: string): string => {
  const n = name.toLowerCase()
  if (n.includes('竞品') || n.includes('竞对') || n.includes('对标') || n.includes('competitor')) {
    return '竞品数据'
  }
  if (n.includes('自有') || n.includes('本品') || n.includes('本店') || n.includes('我方')) {
    return '自有数据'
  }
  return ''
}

const inferPurpose = (name: string): string => {
  const n = name.toLowerCase()
  if (n.includes('手卡') || n.includes('产品')) return '产品手卡'
  if (n.includes('人群') || n.includes('画像')) return '人群画像数据'
  if (n.includes('大盘') || n.includes('趋势') || n.includes('行业')) return '平台大盘数据'
  if (n.includes('商品') || n.includes('经营')) return '商品经营数据'
  if (n.includes('订单') || n.includes('成交') || n.includes('销售') || n.includes('交易')) return '交易数据'
  if (n.includes('评价') || n.includes('评论') || n.includes('反馈')) return '用户反馈数据'
  if (n.includes('投放') || n.includes('广告')) return '投放数据'
  if (n.includes('售后')) return '售后数据'
  if (n.includes('竞品') || n.includes('竞对') || n.includes('对标')) return '竞品素材数据'
  if (n.includes('素材') || n.includes('爆款') || n.includes('脚本')) return '内容素材数据'
  return ''
}

const inferKindV1 = (name: string, purpose = inferPurpose(name)): SourceKindV1 | undefined => {
  const text = `${name} ${purpose}`.toLowerCase()
  if (/评价|评论|反馈|客服|咨询|voc|用户声音/u.test(text)) return 'voice-data'
  if (/人群|画像|年龄|性别|地域|购买偏好/u.test(text)) return 'audience-data'
  if (/素材|爆款|脚本|文案|投放|广告|3秒/u.test(text)) return 'material-data'
  if (/订单|成交|销售|交易|gmv|退款|经营|商品列表/u.test(text)) return 'business-data'
  if (/手卡|产品说明|详情页|招商|规格|原料|成分|材质|工艺|背书/u.test(text)) return 'product-supply'
  return undefined
}

export interface ImageHeaderInfo {
  format: 'png' | 'jpeg' | 'gif' | 'webp'
  width: number
  height: number
  frames: number
}

const MAX_IMAGE_SIDE = 10_000
const MAX_IMAGE_PIXELS = 20_000_000

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length))
}

function u24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)
}

function validateImageDimensions(info: ImageHeaderInfo): ImageHeaderInfo {
  if (
    !info.width ||
    !info.height ||
    info.width > MAX_IMAGE_SIDE ||
    info.height > MAX_IMAGE_SIDE ||
    info.width * info.height > MAX_IMAGE_PIXELS
  ) {
    throw new Error('图片像素尺寸过大，请压缩或截图后重新上传。')
  }
  return info
}

function skipGifSubBlocks(bytes: Uint8Array, start: number): number {
  let offset = start
  while (offset < bytes.length) {
    const size = bytes[offset++]
    if (size === 0) return offset
    if (offset + size > bytes.length) throw new Error('GIF 文件结构损坏，请转换为 PNG 或 JPG 后重试。')
    offset += size
  }
  throw new Error('GIF 文件结构不完整，请转换为 PNG 或 JPG 后重试。')
}

export function inspectImageHeader(bytes: Uint8Array): ImageHeaderInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (
    bytes.length >= 33 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    if (view.getUint32(8) !== 13 || ascii(bytes, 12, 4) !== 'IHDR') {
      throw new Error('PNG 文件结构损坏，请重新保存后上传。')
    }
    const info: ImageHeaderInfo = {
      format: 'png',
      width: view.getUint32(16),
      height: view.getUint32(20),
      frames: 1
    }
    let offset = 8
    while (offset + 12 <= bytes.length) {
      const size = view.getUint32(offset)
      const type = ascii(bytes, offset + 4, 4)
      const payload = offset + 8
      const end = payload + size + 4
      if (end > bytes.length) throw new Error('PNG 文件结构不完整，请重新保存后上传。')
      if (type === 'acTL') {
        if (size < 8) throw new Error('PNG 动图信息损坏，请转换为普通 PNG 后重试。')
        info.frames = view.getUint32(payload)
        throw new Error('暂不支持动态 PNG，请截取关键画面并保存为普通 PNG。')
      }
      offset = end
      if (type === 'IEND') break
    }
    return validateImageDimensions(info)
  }

  if (bytes.length >= 13 && (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a')) {
    const info: ImageHeaderInfo = {
      format: 'gif',
      width: view.getUint16(6, true),
      height: view.getUint16(8, true),
      frames: 0
    }
    const packed = bytes[10]
    let offset = 13 + (packed & 0x80 ? 3 * (1 << ((packed & 0x07) + 1)) : 0)
    let trailerFound = false
    while (offset < bytes.length) {
      const marker = bytes[offset]
      if (marker === 0x3b) {
        trailerFound = true
        break
      }
      if (marker === 0x2c) {
        if (offset + 10 > bytes.length) throw new Error('GIF 文件结构不完整，请转换为 PNG 或 JPG 后重试。')
        const left = view.getUint16(offset + 1, true)
        const top = view.getUint16(offset + 3, true)
        const frameWidth = view.getUint16(offset + 5, true)
        const frameHeight = view.getUint16(offset + 7, true)
        validateImageDimensions({
          format: 'gif',
          width: frameWidth,
          height: frameHeight,
          frames: 1
        })
        if (left + frameWidth > info.width || top + frameHeight > info.height) {
          throw new Error('GIF 画面尺寸与画布不一致，请转换为 PNG 或 JPG 后重试。')
        }
        info.frames++
        if (info.frames > 1) throw new Error('暂不支持动态 GIF，请截取关键画面并保存为 PNG 或 JPG。')
        const localPacked = bytes[offset + 9]
        offset += 10
        if (localPacked & 0x80) offset += 3 * (1 << ((localPacked & 0x07) + 1))
        if (offset >= bytes.length) throw new Error('GIF 文件结构不完整，请转换为 PNG 或 JPG 后重试。')
        offset++ // LZW 最小码长
        offset = skipGifSubBlocks(bytes, offset)
        continue
      }
      if (marker === 0x21) {
        if (offset + 2 > bytes.length) throw new Error('GIF 文件结构不完整，请转换为 PNG 或 JPG 后重试。')
        offset = skipGifSubBlocks(bytes, offset + 2)
        continue
      }
      throw new Error('GIF 文件结构损坏，请转换为 PNG 或 JPG 后重试。')
    }
    if (!trailerFound || info.frames !== 1) {
      throw new Error('GIF 中没有完整的静态画面，请转换为 PNG 或 JPG 后重试。')
    }
    return validateImageDimensions(info)
  }

  if (bytes.length >= 20 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    const declaredEnd = view.getUint32(4, true) + 8
    if (declaredEnd < 20 || declaredEnd > bytes.length) {
      throw new Error('WebP 文件结构不完整，请转换为 PNG 或 JPG 后重试。')
    }
    let offset = 12
    let canvasInfo: ImageHeaderInfo | null = null
    let bitstreamInfo: ImageHeaderInfo | null = null
    while (offset + 8 <= declaredEnd) {
      const type = ascii(bytes, offset, 4)
      const size = view.getUint32(offset + 4, true)
      const payload = offset + 8
      if (payload + size > declaredEnd) throw new Error('WebP 文件结构损坏，请转换为 PNG 或 JPG 后重试。')
      if (type === 'VP8X') {
        if (size < 10 || canvasInfo || bitstreamInfo) {
          throw new Error('WebP 文件结构损坏，请转换为 PNG 或 JPG 后重试。')
        }
        if (bytes[payload] & 0x02) throw new Error('暂不支持动态 WebP，请截取关键画面并保存为 PNG 或 JPG。')
        canvasInfo = validateImageDimensions({
          format: 'webp',
          width: 1 + u24le(bytes, payload + 4),
          height: 1 + u24le(bytes, payload + 7),
          frames: 1
        })
      } else if (type === 'VP8 ') {
        if (
          size < 10 ||
          bytes[payload + 3] !== 0x9d ||
          bytes[payload + 4] !== 0x01 ||
          bytes[payload + 5] !== 0x2a
        ) {
          throw new Error('WebP 文件结构损坏，请转换为 PNG 或 JPG 后重试。')
        }
        if (bitstreamInfo) throw new Error('WebP 包含重复画面数据，请转换为 PNG 或 JPG 后重试。')
        bitstreamInfo = validateImageDimensions({
          format: 'webp',
          width: view.getUint16(payload + 6, true) & 0x3fff,
          height: view.getUint16(payload + 8, true) & 0x3fff,
          frames: 1
        })
      } else if (type === 'VP8L') {
        if (size < 5 || bytes[payload] !== 0x2f) {
          throw new Error('WebP 文件结构损坏，请转换为 PNG 或 JPG 后重试。')
        }
        const bits =
          (bytes[payload + 1] |
            (bytes[payload + 2] << 8) |
            (bytes[payload + 3] << 16) |
            (bytes[payload + 4] << 24)) >>>
          0
        if (bitstreamInfo) throw new Error('WebP 包含重复画面数据，请转换为 PNG 或 JPG 后重试。')
        bitstreamInfo = validateImageDimensions({
          format: 'webp',
          width: (bits & 0x3fff) + 1,
          height: ((bits >>> 14) & 0x3fff) + 1,
          frames: 1
        })
      } else if (type === 'ANIM' || type === 'ANMF') {
        throw new Error('暂不支持动态 WebP，请截取关键画面并保存为 PNG 或 JPG。')
      }
      const nextOffset = payload + size + (size & 1)
      if (nextOffset > declaredEnd) {
        throw new Error('WebP 文件结构不完整，请转换为 PNG 或 JPG 后重试。')
      }
      offset = nextOffset
    }
    if (offset !== declaredEnd) throw new Error('WebP 文件结构不完整，请转换为 PNG 或 JPG 后重试。')
    if (!bitstreamInfo) {
      throw new Error('WebP 中没有可读取的静态画面，请转换为 PNG 或 JPG 后重试。')
    }
    if (
      canvasInfo &&
      (canvasInfo.width !== bitstreamInfo.width || canvasInfo.height !== bitstreamInfo.height)
    ) {
      throw new Error('WebP 画布尺寸与实际画面不一致，请转换为 PNG 或 JPG 后重试。')
    }
    return bitstreamInfo
  }

  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2
    while (offset < bytes.length) {
      if (bytes[offset] !== 0xff) throw new Error('JPEG 文件结构损坏，请重新保存后上传。')
      while (offset < bytes.length && bytes[offset] === 0xff) offset++
      if (offset >= bytes.length) break
      const marker = bytes[offset++]
      if (marker === 0xd9 || marker === 0xda) break
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
      if (offset + 2 > bytes.length) throw new Error('JPEG 文件结构不完整，请重新保存后上传。')
      const length = view.getUint16(offset)
      if (length < 2 || offset + length > bytes.length) {
        throw new Error('JPEG 文件结构损坏，请重新保存后上传。')
      }
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        if (length < 7) throw new Error('JPEG 尺寸信息损坏，请重新保存后上传。')
        return validateImageDimensions({
          format: 'jpeg',
          height: view.getUint16(offset + 3),
          width: view.getUint16(offset + 5),
          frames: 1
        })
      }
      offset += length
    }
    throw new Error('JPEG 中没有可读取的尺寸信息，请重新保存后上传。')
  }

  throw new Error('图片格式无法识别，请转换为 PNG 或 JPG 后重试。')
}

// 截图压缩：缩放到最大边 maxDim、转 JPEG，避免多张全尺寸图拼成超大请求体导致 fetch failed
const downscaleImage = async (file: File, maxDim = 1600, quality = 0.9): Promise<string> => {
  const headerBytes = new Uint8Array(await file.arrayBuffer())
  inspectImageHeader(headerBytes)
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result as string
      const img = new Image()
      img.onload = () => {
        try {
          if (
            !img.width ||
            !img.height ||
            img.width > MAX_IMAGE_SIDE ||
            img.height > MAX_IMAGE_SIDE ||
            img.width * img.height > MAX_IMAGE_PIXELS
          ) {
            throw new Error('图片像素尺寸过大，请压缩或截图后重新上传。')
          }
          const scale = Math.min(1, maxDim / Math.max(img.width, img.height))
          if (scale === 1 && file.size < 600_000) {
            resolve(dataUrl) // 已经够小，原样用
            return
          }
          const w = Math.round(img.width * scale)
          const h = Math.round(img.height * scale)
          const canvas = document.createElement('canvas')
          canvas.width = w
          canvas.height = h
          const ctx = canvas.getContext('2d')
          if (!ctx) throw new Error('无法创建图片处理画布')
          ctx.drawImage(img, 0, 0, w, h)
          resolve(canvas.toDataURL('image/jpeg', quality))
        } catch (error) {
          reject(error)
        }
      }
      img.onerror = () => reject(new Error('图片无法读取，请转换为 PNG 或 JPG 后重试。'))
      img.src = dataUrl
    }
    reader.onerror = () => reject(new Error('图片读取失败，请重新选择文件。'))
    reader.readAsDataURL(file)
  })
}

function fileFromDataUrl(dataUrl: string, name: string): File {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/u.exec(dataUrl)
  if (!match) throw new Error('内嵌图片数据格式无效')
  const binary = window.atob(match[2].replace(/\s+/gu, ''))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return new File([bytes], name, { type: match[1] })
}

function cleanedSummaryOnly(cleanedData: string): string {
  const index = cleanedData.indexOf(CLEAN_DETAIL_MARKER)
  return index >= 0 ? cleanedData.slice(0, index).trim() : cleanedData
}

function compactForFinalReport(text: string): string {
  // 分析步骤已经通过任务相关的完整证据包控制体积；最终成稿不得再次按字符截断，
  // 否则步骤中段的来源、数字或限制会在最后一跳静默丢失。
  return text
}

function defaultReportName(ext: string): string {
  const d = new Date()
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  return `产品经营报告_${stamp}.${ext}`
}

interface StoreState {
  initialized: boolean
  persistencePaused: boolean
  projectRevision: number
  analysisSessionId: string
  previousProjectAvailable: boolean
  settings: AppSettings | null
  settingsOpen: boolean
  reportReuseOffer: ReportResultCacheLookupResult | null
  sopRules: string
  sources: Source[]
  phase: Phase
  messages: ChatMsg[]
  cleanedData: string
  cleanDetails: ProjectCleanDetailSnapshot[]
  artifacts: Record<number, string>
  taskJournal: Record<string, ProjectTaskSnapshot>
  reportMarkdown: string
  reportStale: boolean
  abortFn: (() => void) | null
  steering: string
  exportStatus: string
  lastExportPath: string
  openingExport: boolean
  cleaningProgress: CleaningProgress
  engineVersion: ReportEngineVersion
  legacyEngineVersion?: 'v1'
  legacyArtifacts?: Record<number, string>
  legacyModuleStates?: Partial<Record<ModuleKey, ModuleRunState>>
  legacyReportMarkdown?: string
  legacyBenchmarkAppendix?: string
  readOnly: boolean
  legacyNotice: string
  moduleStates: Partial<Record<ModuleKey, ModuleRunState>>
  moduleRetryInstructions: Partial<Record<ModuleKey, string>>
  moduleRetryScope: ModuleKey[]

  init: () => Promise<void>
  setSettingsOpen: (open: boolean) => void
  saveSettings: (s: AppSettings) => Promise<void>
  resetAnalysis: () => Promise<void>
  restorePreviousAnalysis: () => Promise<void>
  addSources: (files: FileList | File[]) => Promise<void>
  removeSource: (id: string) => void
  setSourceAttribution: (id: string, attribution: string) => void
  setUnconfirmedAttribution: (attribution: '自有数据' | '竞品数据') => void
  setSourcePlatform: (id: string, platform: string) => void
  setSourcePurpose: (id: string, purpose: string) => void
  setSourceKindV1: (id: string, kindV1: SourceKindV1) => void
  setSourceNote: (id: string, note: string) => void
  startGeneration: () => Promise<void>
  acceptReportReuse: () => Promise<void>
  regenerateReport: () => Promise<void>
  confirmCheckpoint: () => Promise<void>
  retryModule: (key: ModuleKey, instruction?: string) => Promise<void>
  sendMessage: (text: string) => Promise<boolean>
  abort: () => void
  exportReport: (format: 'html' | 'md' | 'docx') => Promise<void>
  openLastExport: () => Promise<void>
  showLastExportInFolder: () => Promise<void>

  // 内部
  _post: (role: ChatMsg['role'], text: string, kind?: ChatMsg['kind']) => string
  _update: (id: string, text: string) => void
  _startPaidGeneration: () => Promise<void>
  _runCleaning: (isRerun: boolean) => Promise<void>
  _runAnalysis: () => Promise<void>
  _rerunReport: (latestFeedback?: string) => Promise<void>
}

const invalidatedAnalysis = (): Pick<
  StoreState,
  'cleanedData' | 'phase' | 'abortFn' | 'exportStatus' | 'cleaningProgress' | 'reportReuseOffer' | 'taskJournal' | 'moduleStates'
> => ({
  cleanedData: '',
  phase: 'idle',
  abortFn: null,
  exportStatus: '',
  cleaningProgress: emptyCleaningProgress(),
  reportReuseOffer: null,
  taskJournal: {},
  moduleStates: {}
})

const preserveCommittedReport = (
  state: StoreState
): Pick<StoreState, 'artifacts' | 'reportMarkdown' | 'reportStale'> => {
  const committed = state.artifacts[REPORT_STEP_ID] || state.reportMarkdown
  return {
    artifacts: committed ? { [REPORT_STEP_ID]: committed } : {},
    reportMarkdown: committed,
    reportStale: Boolean(committed)
  }
}

export const useStore = create<StoreState>((set, get) => ({
  initialized: false,
  persistencePaused: false,
  projectRevision: 0,
  analysisSessionId: crypto.randomUUID(),
  previousProjectAvailable: false,
  settings: null,
  settingsOpen: false,
  reportReuseOffer: null,
  sopRules: '',
  sources: [],
  phase: 'idle',
  messages: [],
  cleanedData: '',
  cleanDetails: [],
  artifacts: {},
  taskJournal: {},
  reportMarkdown: '',
  reportStale: false,
  abortFn: null,
  steering: '',
  exportStatus: '',
  lastExportPath: '',
  openingExport: false,
  cleaningProgress: emptyCleaningProgress(),
  engineVersion: 'v2',
  legacyEngineVersion: undefined,
  legacyArtifacts: undefined,
  legacyModuleStates: undefined,
  legacyReportMarkdown: undefined,
  legacyBenchmarkAppendix: undefined,
  readOnly: false,
  legacyNotice: '',
  moduleStates: {},
  moduleRetryInstructions: {},
  moduleRetryScope: [],

  init: async () => {
    const [settings, sopRules, lastProject, previousProject] = await Promise.all([
      window.api.getSettings(),
      window.api.getSopRules(),
      window.api.loadLastProject(),
      window.api.loadPreviousProject()
    ])
    let restoredReport =
      lastProject?.phase === 'analyzing'
        ? lastProject.artifacts?.[REPORT_STEP_ID] || ''
        : lastProject?.reportMarkdown || ''
    const legacyReadOnly = Boolean(
      lastProject && lastProject.engineVersion !== 'v1' && lastProject.engineVersion !== 'v2' &&
      (lastProject.reportMarkdown?.trim() || Object.keys(lastProject.artifacts || {}).length)
    )
    let restoredArtifacts = { ...(lastProject?.artifacts || {}) }
    const restoredTaskJournal = { ...(lastProject?.taskJournal || {}) }
    let restoredModuleStates = { ...(lastProject?.moduleStates || {}) }
    let migratedV1 = false
    let restoredLegacyEngineVersion = lastProject?.legacyEngineVersion
    let restoredLegacyArtifacts = lastProject?.legacyArtifacts
    let restoredLegacyModuleStates = lastProject?.legacyModuleStates
    let restoredLegacyReportMarkdown = lastProject?.legacyReportMarkdown
    let restoredLegacyBenchmarkAppendix = lastProject?.legacyBenchmarkAppendix
    let recoveredNoAnalysisModule = false
    let recoveredValidatedModule = false
    let staleModules: ModuleKey[] = []
    const invalidCompletedModules: ModuleKey[] = []
    if (lastProject?.engineVersion === 'v1') {
      const projection = projectLegacyV1ToV2(restoredArtifacts, restoredModuleStates)
      restoredLegacyEngineVersion = 'v1'
      restoredLegacyArtifacts = { ...restoredArtifacts }
      restoredLegacyModuleStates = { ...restoredModuleStates }
      restoredLegacyReportMarkdown = lastProject.reportMarkdown
      restoredLegacyBenchmarkAppendix = projection.benchmarkAppendix
      restoredArtifacts = { ...projection.artifacts, [REPORT_STEP_ID]: projection.reportMarkdown }
      restoredModuleStates = projection.moduleStates
      restoredReport = projection.reportMarkdown
      migratedV1 = true
    } else if (lastProject?.engineVersion === 'v2') {
      for (const module of REPORT_MODULES_V2) {
        const taskEntry = Object.entries(restoredTaskJournal).find(([taskId]) =>
          taskId.endsWith(`:module:v2:${module.key}`)
        )
        let task = taskEntry?.[1]
        if (module.key === 'material-review' && task?.output) {
          const normalized = normalizeMaterialReviewOutput(task.output)
          if (normalized !== task.output) {
            task = { ...task, output: normalized, updatedAt: new Date().toISOString() }
            restoredTaskJournal[taskEntry![0]] = task
            restoredArtifacts[module.id] = normalized
            recoveredValidatedModule = true
          }
        }
        if (
          restoredModuleStates[module.key]?.status === 'done' &&
          task?.output &&
          validateModuleOutput(module.key, task.output, 'v2').length > 0
        ) {
          delete restoredArtifacts[module.id]
          delete restoredTaskJournal[taskEntry![0]]
          restoredModuleStates[module.key] = {
            status: 'failed',
            message: `旧结果不完整：${validateModuleOutput(module.key, task.output, 'v2').slice(0, 3).join('；')}。`,
            updatedAt: new Date().toISOString()
          }
          invalidCompletedModules.push(module.key)
          continue
        }
        if (restoredModuleStates[module.key]?.status !== 'failed' || !task?.output) continue
        if (isNoAnalysisOutput(task.output)) {
          const output = normalizeNoAnalysisOutput(task.output)
          restoredTaskJournal[taskEntry![0]] = { ...task, status: 'complete', output, updatedAt: new Date().toISOString() }
          restoredModuleStates[module.key] = { status: 'skipped', message: output, updatedAt: new Date().toISOString() }
          delete restoredArtifacts[module.id]
          recoveredNoAnalysisModule = true
        } else if (validateModuleOutput(module.key, task.output, 'v2').length === 0) {
          restoredTaskJournal[taskEntry![0]] = { ...task, status: 'complete', updatedAt: new Date().toISOString() }
          restoredModuleStates[module.key] = { status: 'done', updatedAt: new Date().toISOString() }
          restoredArtifacts[module.id] = task.output
          recoveredValidatedModule = true
        }
      }
      staleModules = [...findStaleModuleKeys(REPORT_MODULES_V2, restoredModuleStates)]
      const invalidOrStale = new Set<ModuleKey>([...invalidCompletedModules, ...staleModules])
      let dependencyChanged = true
      while (dependencyChanged) {
        dependencyChanged = false
        for (const module of REPORT_MODULES_V2) {
          if (invalidOrStale.has(module.key) || !module.dependsOn.some((dependency) => invalidOrStale.has(dependency))) continue
          invalidOrStale.add(module.key)
          staleModules.push(module.key)
          dependencyChanged = true
        }
      }
      for (const key of staleModules) {
        const module = REPORT_MODULES_V2.find((candidate) => candidate.key === key)
        if (!module) continue
        delete restoredArtifacts[module.id]
        restoredModuleStates[key] = {
          status: 'failed',
          message: '上游模块已经更新，本模块需要重新分析，旧结果已停止复用。',
          updatedAt: new Date().toISOString()
        }
        for (const taskId of Object.keys(restoredTaskJournal)) {
          if (taskId.includes(`:module:v2:${key}`)) delete restoredTaskJournal[taskId]
        }
      }
      if (recoveredNoAnalysisModule || recoveredValidatedModule || invalidCompletedModules.length > 0 || staleModules.length > 0) {
        const outputByKey = Object.fromEntries(REPORT_MODULES_V2.map((module) => [module.key, restoredArtifacts[module.id]]))
        const messageByKey = Object.fromEntries(REPORT_MODULES_V2.map((module) => [module.key, restoredModuleStates[module.key]?.message]))
        restoredReport = assembleModuleReport(REPORT_MODULES_V2, outputByKey, messageByKey, restoredLegacyBenchmarkAppendix)
        restoredArtifacts[REPORT_STEP_ID] = restoredReport
      }
    }
    if (restoredReport && !restoredArtifacts[REPORT_STEP_ID]) {
      restoredArtifacts[REPORT_STEP_ID] = restoredReport
    }
    const restoredMessages: ChatMsg[] = lastProject
      ? lastProject.messages
          .filter(
            (message) =>
              !(
                isRunningPhase(lastProject.phase as Phase) &&
                message.kind === 'narration' &&
                /正在|⏳/.test(message.text)
              )
          )
          .map((message) => ({ ...message }))
      : []
    if (lastProject && isRunningPhase(lastProject.phase as Phase)) {
      restoredMessages.push({
        id: crypto.randomUUID(),
        role: 'assistant',
        kind: 'narration',
        text: '上次任务在执行过程中退出了，已恢复保存好的资料和完整结果。请检查后重新开始。'
      })
    }
    if (lastProject?.missingBlobs?.length) {
      restoredMessages.push({
        id: crypto.randomUUID(),
        role: 'assistant',
        kind: 'error',
        text: `恢复项目时发现 ${lastProject.missingBlobs.length} 个资料块丢失。其他内容已正常恢复，请重新上传：${lastProject.missingBlobs.join('、')}`
      })
    }
    if (recoveredNoAnalysisModule) {
      restoredMessages.push({
        id: crypto.randomUUID(),
        role: 'assistant',
        kind: 'narration',
        text: '已将证据不足、明确无有效结果的模块恢复为“暂无分析”，现有有效模块和报告内容均已保留。'
      })
    }
    if (recoveredValidatedModule) {
      restoredMessages.push({
        id: crypto.randomUUID(),
        role: 'assistant',
        kind: 'narration',
        text: '已恢复符合新版校验规则的完整模块结果，没有重新调用模型，也没有重复扣分。'
      })
    }
    if (migratedV1) {
      restoredMessages.push({
        id: crypto.randomUUID(),
        role: 'assistant',
        kind: 'checkpoint',
        text: '已将旧版8模块报告自动转换为6模块视图。转换过程没有调用模型、没有扣分；旧对标内容保存在报告附录，各模块可按新版单独重新生成。'
      })
    }
    if (staleModules.length > 0) {
      restoredMessages.push({
        id: crypto.randomUUID(),
        role: 'assistant',
        kind: 'error',
        text: `检测到上游模块晚于下游完成，已停止复用 ${staleModules.map(moduleByTitle).join('、')} 的旧结果。请从最前面的待重试模块开始，软件会自动重做它的下游。`
      })
    }
    if (invalidCompletedModules.length > 0) {
      restoredMessages.push({
        id: crypto.randomUUID(),
        role: 'assistant',
        kind: 'error',
        text: `检测到 ${invalidCompletedModules.map(moduleByTitle).join('、')} 的旧结果被截断或缺项，已阻止继续导出该结果，请重试对应模块。`
      })
    }
    const restoredSourceState = groupLegacyOfficeDerivedSources(
      lastProject
        ? lastProject.sources.map((source) => ({
            ...source,
            parsing: false,
            error:
              source.error || sourceHasContent(source)
                ? source.error
                : '上次文件解析未完成，请删除后重新上传。'
          }))
        : []
    )
    const restoredCleanDetails = groupLegacyOfficeCleanDetails(
      Array.isArray(lastProject?.cleanDetails) ? lastProject.cleanDetails : [],
      restoredSourceState.derivedParentIds,
      restoredSourceState.sources
    )
    set({
      initialized: true,
      persistencePaused: false,
      projectRevision: lastProject?.revision || 0,
      analysisSessionId: lastProject?.analysisSessionId || crypto.randomUUID(),
      previousProjectAvailable: Boolean(previousProject),
      settings,
      sopRules,
      settingsOpen: settings.managedModel?.enabled ? !settings.managedModel.configured : !settings.profiles.length,
      reportReuseOffer: null,
      sources: restoredSourceState.sources,
      messages: restoredMessages,
      cleanedData: lastProject?.cleanedData || '',
      cleanDetails: restoredCleanDetails,
      artifacts: restoredArtifacts,
      taskJournal: restoredTaskJournal,
      reportMarkdown: restoredReport,
      reportStale: Boolean(lastProject?.reportStale),
      phase: lastProject ? restorePhase(lastProject) : 'idle',
      steering: persistentSteering(lastProject?.steering || ''),
      abortFn: null,
      exportStatus: '',
      lastExportPath: '',
      openingExport: false,
      cleaningProgress: emptyCleaningProgress(),
      engineVersion: 'v2',
      legacyEngineVersion: restoredLegacyEngineVersion,
      legacyArtifacts: restoredLegacyArtifacts,
      legacyModuleStates: restoredLegacyModuleStates,
      legacyReportMarkdown: restoredLegacyReportMarkdown,
      legacyBenchmarkAppendix: restoredLegacyBenchmarkAppendix,
      readOnly: legacyReadOnly || Boolean(lastProject?.readOnly),
      legacyNotice: legacyReadOnly
        ? '此报告由旧版本生成，仅支持查看导出'
        : lastProject?.legacyNotice || '',
      moduleStates: restoredModuleStates,
      moduleRetryInstructions: {},
      moduleRetryScope: []
    })
    if (migratedV1) {
      await window.api.saveLastProject(buildProjectSnapshot(get()))
    }
  },

  setSettingsOpen: (open) => set({ settingsOpen: open }),
  saveSettings: async (s) => {
    const saved = await window.api.saveSettings(s)
    set({ settings: saved })
  },

  resetAnalysis: async () => {
    const current = get()
    await window.api.archiveProject(buildProjectSnapshot(current))
    await window.api.cancelFileParsing().catch(() => undefined)
    const previousAnalysis = {
      sources: current.sources,
      messages: current.messages,
      cleanedData: current.cleanedData,
      cleanDetails: current.cleanDetails,
      artifacts: current.artifacts,
      taskJournal: current.taskJournal,
      reportMarkdown: current.reportMarkdown,
      reportStale: current.reportStale,
      phase: current.phase,
      abortFn: current.abortFn,
      steering: current.steering,
      exportStatus: current.exportStatus,
      lastExportPath: current.lastExportPath,
      openingExport: false,
      cleaningProgress: current.cleaningProgress,
      engineVersion: current.engineVersion,
      legacyEngineVersion: current.legacyEngineVersion,
      legacyArtifacts: current.legacyArtifacts,
      legacyModuleStates: current.legacyModuleStates,
      legacyReportMarkdown: current.legacyReportMarkdown,
      legacyBenchmarkAppendix: current.legacyBenchmarkAppendix,
      readOnly: current.readOnly,
      legacyNotice: current.legacyNotice,
      moduleStates: current.moduleStates,
      projectRevision: current.projectRevision,
      analysisSessionId: current.analysisSessionId,
      reportReuseOffer: null,
      previousProjectAvailable: true,
      persistencePaused: false
    }
    const nextRevision = current.projectRevision + 1
    const emptyAnalysis = {
      sources: [] as Source[],
      messages: [] as ChatMsg[],
      cleanedData: '',
      cleanDetails: [] as { id: string; name: string; text: string }[],
      artifacts: {} as Record<number, string>,
      taskJournal: {} as Record<string, ProjectTaskSnapshot>,
      reportMarkdown: '',
      reportStale: false,
      phase: 'idle' as Phase,
      abortFn: null,
      steering: '',
      exportStatus: '',
      lastExportPath: '',
      openingExport: false,
      cleaningProgress: emptyCleaningProgress(),
      engineVersion: 'v2' as const,
      legacyEngineVersion: undefined,
      legacyArtifacts: undefined,
      legacyModuleStates: undefined,
      legacyReportMarkdown: undefined,
      legacyBenchmarkAppendix: undefined,
      readOnly: false,
      legacyNotice: '',
      moduleStates: {} as Partial<Record<ModuleKey, ModuleRunState>>,
      moduleRetryInstructions: {} as Partial<Record<ModuleKey, string>>,
      moduleRetryScope: [] as ModuleKey[],
      projectRevision: nextRevision,
      analysisSessionId: crypto.randomUUID(),
      reportReuseOffer: null,
      previousProjectAvailable: true,
      persistencePaused: true
    }

    set(emptyAnalysis)
    current.abortFn?.()
    try {
      await window.api.saveLastProject(buildProjectSnapshot(emptyAnalysis))
      set({ persistencePaused: false })
    } catch (error) {
      const rollbackAnalysis = {
        ...previousAnalysis,
        sources: previousAnalysis.sources.map((source) =>
          source.parsing
            ? {
                ...source,
                parsing: false,
                error: '文件解析在新建失败期间中断，请删除后重新上传。'
              }
            : source
        ),
        projectRevision: nextRevision + 1,
        persistencePaused: false
      }
      set(rollbackAnalysis)
      try {
        await window.api.saveLastProject(buildProjectSnapshot(rollbackAnalysis))
      } catch {
        // 自动保存会继续尝试写入更高 revision 的回滚快照
      }
      throw error
    }
  },

  restorePreviousAnalysis: async () => {
    const current = get()
    const previous = await window.api.loadPreviousProject()
    if (!previous) {
      set({ previousProjectAvailable: false })
      throw new Error('没有找到可恢复的上一份分析。')
    }

    let restoredReport =
      previous.phase === 'analyzing'
        ? previous.artifacts?.[REPORT_STEP_ID] || ''
        : previous.reportMarkdown || ''
    let restoredArtifacts = { ...(previous.artifacts || {}) }
    let restoredModuleStates = previous.moduleStates || {}
    let previousLegacyEngineVersion = previous.legacyEngineVersion
    let previousLegacyArtifacts = previous.legacyArtifacts
    let previousLegacyModuleStates = previous.legacyModuleStates
    let previousLegacyReportMarkdown = previous.legacyReportMarkdown
    let previousLegacyBenchmarkAppendix = previous.legacyBenchmarkAppendix
    if (previous.engineVersion === 'v1') {
      const projection = projectLegacyV1ToV2(restoredArtifacts, restoredModuleStates)
      previousLegacyEngineVersion = 'v1'
      previousLegacyArtifacts = { ...restoredArtifacts }
      previousLegacyModuleStates = { ...restoredModuleStates }
      previousLegacyReportMarkdown = previous.reportMarkdown
      previousLegacyBenchmarkAppendix = projection.benchmarkAppendix
      restoredArtifacts = { ...projection.artifacts, [REPORT_STEP_ID]: projection.reportMarkdown }
      restoredModuleStates = projection.moduleStates
      restoredReport = projection.reportMarkdown
    }
    if (restoredReport && !restoredArtifacts[REPORT_STEP_ID]) {
      restoredArtifacts[REPORT_STEP_ID] = restoredReport
    }
    const interrupted = isRunningPhase(previous.phase as Phase)
    const restoredMessages: ChatMsg[] = (previous.messages || []).map((message) => ({
      id: message.id,
      role: message.role,
      text: message.text,
      kind: message.kind
    }))
    if (interrupted) {
      restoredMessages.push({
        id: crypto.randomUUID(),
        role: 'assistant',
        kind: 'narration',
        text: '上一份分析在执行过程中退出了，已恢复已保存的内容。请检查资料后重新开始。'
      })
    }
    if (previous.missingBlobs?.length) {
      restoredMessages.push({
        id: crypto.randomUUID(),
        role: 'assistant',
        kind: 'error',
        text: `上一份项目有 ${previous.missingBlobs.length} 个资料块丢失，其他内容已恢复，请重新上传：${previous.missingBlobs.join('、')}`
      })
    }

    const restoredState = {
      sources: previous.sources.map((source) => ({
        ...source,
        parsing: false,
        error:
          source.error || sourceHasContent(source)
            ? source.error
            : '上次文件解析未完成，请删除后重新上传。'
      })),
      messages: restoredMessages,
      cleanedData: previous.cleanedData || '',
      cleanDetails: Array.isArray(previous.cleanDetails) ? previous.cleanDetails : [],
      artifacts: restoredArtifacts,
      taskJournal: previous.taskJournal || {},
      reportMarkdown: restoredReport,
      reportStale: Boolean(previous.reportStale),
      phase: restorePhase(previous),
      steering: persistentSteering(previous.steering || ''),
      abortFn: null,
      exportStatus: '',
      lastExportPath: '',
      openingExport: false,
      cleaningProgress: emptyCleaningProgress(),
      engineVersion: 'v2' as const,
      legacyEngineVersion: previousLegacyEngineVersion,
      legacyArtifacts: previousLegacyArtifacts,
      legacyModuleStates: previousLegacyModuleStates,
      legacyReportMarkdown: previousLegacyReportMarkdown,
      legacyBenchmarkAppendix: previousLegacyBenchmarkAppendix,
      readOnly: (previous.engineVersion !== 'v1' && previous.engineVersion !== 'v2') || Boolean(previous.readOnly),
      legacyNotice: previous.engineVersion !== 'v1' && previous.engineVersion !== 'v2'
        ? '此报告由旧版本生成，仅支持查看导出'
        : previous.legacyNotice || '',
      moduleStates: restoredModuleStates,
      moduleRetryInstructions: {},
      moduleRetryScope: [],
      projectRevision: current.projectRevision + 1,
      analysisSessionId: previous.analysisSessionId || crypto.randomUUID(),
      reportReuseOffer: null,
      previousProjectAvailable: false,
      persistencePaused: true
    }

    await window.api.saveLastProject(buildProjectSnapshot(restoredState))
    set({ ...restoredState, persistencePaused: false })
  },

  _post: (role, text, kind) => {
    const id = crypto.randomUUID()
    set((s) => ({ messages: [...s.messages, { id, role, text, kind }] }))
    return id
  },
  _update: (id, text) => set((s) => ({ messages: s.messages.map((m) => (m.id === id ? { ...m, text } : m)) })),

  addSources: async (files) => {
    const sessionId = get().analysisSessionId
    if (isRunningPhase(get().phase)) return
    if (get().sources.some((source) => source.parsing)) {
      get()._post('assistant', '正在读取上一批资料，请等“解析中”全部结束后再继续添加。', 'narration')
      return
    }
    const acceptedJobs: Array<{
      id: string
      file: File
      name: string
      ext: string
      kind: Source['kind']
      attribution: string
      platform: string
      purpose: string
      kindV1?: SourceKindV1
    }> = []
    const rejected: Source[] = []
    const incomingFiles = Array.from(files)
    const availableSlots = Math.max(0, MAX_SOURCE_FILES - topLevelSourceCount(get().sources))
    let validOverflowCount = 0
    let acceptedBytes = get().sources.reduce(
      (sum, source) => sum + (source.parsing || sourceHasContent(source) ? source.size || 0 : 0),
      0
    )

    // 先判断是否可解析，再占用 50 份有效资料名额。这样选择的文件中夹有
    // 系统文件、超限文件时，不会把后面真正可分析的资料挡在前 50 个之外。
    for (const file of incomingFiles) {
      const name = displayName(file)
      const e = extOf(file.name)
      if (isJunkName(name)) continue
      const base = {
        id: crypto.randomUUID(),
        name,
        kind: 'other' as Source['kind'],
        size: file.size,
        parsing: false,
        attribution: inferAttribution(name),
        platform: inferSourcePlatform(name),
        purpose: inferPurpose(name),
        kindV1: inferKindV1(name),
        topLevelId: ''
      }
      base.topLevelId = base.id
      const reject = (error: string): void => {
        rejected.push({ ...base, error })
      }
      if (!SUPPORTED_EXTS.has(e)) {
        reject(`已忽略：暂不支持 .${e || '未知'} 文件。支持常见图片及 TIFF/AVIF/HEIC 自动转换、Excel/ODS/CSV/TSV、PDF、DOC/DOCX、PPTX、Markdown/TXT/RTF、JSON/YAML、HTML/XML 和 ZIP。`)
        continue
      }
      if (file.size > MAX_SINGLE_FILE_BYTES) {
        reject(`已忽略：单文件 ${formatBytes(file.size)} 超过上限 ${formatBytes(MAX_SINGLE_FILE_BYTES)}。请拆分或只上传关键页/关键表。`)
        continue
      }
      if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(e) && file.size > MAX_IMAGE_FILE_BYTES) {
        reject(`已忽略：图片 ${formatBytes(file.size)} 过大，请压缩到 ${formatBytes(MAX_IMAGE_FILE_BYTES)} 以内。`)
        continue
      }
      if (acceptedBytes + file.size > MAX_TOTAL_UPLOAD_BYTES) {
        reject(`已忽略：本次资料总量会超过 ${formatBytes(MAX_TOTAL_UPLOAD_BYTES)}，请分批分析。`)
        continue
      }
      if (acceptedJobs.length >= availableSlots) {
        validOverflowCount++
        continue
      }
      acceptedBytes += file.size
      acceptedJobs.push({
        id: base.id,
        file,
        name,
        ext: e,
        kind: e === 'zip' ? ('other' as Source['kind']) : classify(file.name),
        attribution: base.attribution,
        platform: base.platform,
        purpose: base.purpose,
        kindV1: base.kindV1
      })
    }

    const retainedRejected = rejected.slice(0, Math.max(0, availableSlots - acceptedJobs.length))
    const omittedRejectedCount = rejected.length - retainedRejected.length
    if (validOverflowCount) {
      get()._post(
        'assistant',
        `一次分析最多保留 ${MAX_SOURCE_FILES} 份可分析资料，本次还有 ${validOverflowCount} 份有效文件未加入。请先完成这一份，再新建分析处理其余文件。`,
        'error'
      )
    }
    if (omittedRejectedCount) {
      get()._post(
        'assistant',
        `另有 ${omittedRejectedCount} 份不支持或超限文件没有占用资料名额；请按上传说明转换格式或拆分后重试。`,
        'error'
      )
    }

    const jobs = acceptedJobs

    if (!jobs.length && retainedRejected.length) {
      set((s) =>
        s.analysisSessionId === sessionId && !isRunningPhase(s.phase)
          ? { sources: [...s.sources, ...retainedRejected] }
          : s
      )
      return
    }

    if (!jobs.length) return

    set((s) => {
      if (s.analysisSessionId !== sessionId || isRunningPhase(s.phase)) return s
      return {
        ...invalidatedAnalysis(),
        ...preserveCommittedReport(s),
        sources: [
          ...s.sources,
          ...retainedRejected,
          ...jobs.map((job) => ({
            id: job.id,
            name: job.name,
            kind: job.kind,
            size: job.file.size,
            parsing: true,
            attribution: job.attribution,
            platform: job.platform,
            purpose: job.purpose,
            kindV1: job.kindV1,
            topLevelId: job.id
          }))
        ]
      }
    })

    let next = 0
    const worker = async (): Promise<void> => {
      while (next < jobs.length) {
        const job = jobs[next++]
        try {
          if (job.ext === 'zip') {
            const buf = await job.file.arrayBuffer()
            const archiveItems = await window.api.parseArchive(job.name, buf)
            // 50份上限只计算用户选择的顶层文件；ZIP条目属于父文件的派生证据。
            const items = [...archiveItems].sort((left, right) => Number(right.ok) - Number(left.ok))
            let imageIndex = 0
            const processArchiveImages = async (): Promise<void> => {
              while (imageIndex < items.length) {
                const index = imageIndex++
                const item = items[index]
                if (!item.ok || item.kind !== 'image' || !item.dataUrl) continue
                try {
                  const imageFile = fileFromDataUrl(item.dataUrl, item.name)
                  items[index] = { ...item, dataUrl: await downscaleImage(imageFile) }
                } catch (error) {
                  items[index] = {
                    ...item,
                    ok: false,
                    dataUrl: undefined,
                    error: error instanceof Error ? error.message : '压缩包内图片无法读取。'
                  }
                }
              }
            }
            await Promise.all([processArchiveImages(), processArchiveImages()])
            set((s) => {
              if (s.analysisSessionId !== sessionId || !s.sources.some((source) => source.id === job.id)) return s
              const retainedSources = s.sources.filter((source) => source.id !== job.id)
              const retainedBytes = retainedSources.reduce(
                (sum, source) => sum + (source.parsing || sourceHasContent(source) ? source.size || 0 : 0),
                0
              )
              const retainedItems = items
              const expandedBytes = retainedItems.reduce((sum, item) => sum + (item.ok ? item.size || 0 : 0), 0)
              if (retainedBytes + expandedBytes > MAX_TOTAL_UPLOAD_BYTES) {
                return {
                  sources: [
                    ...retainedSources,
                    {
                      id: job.id,
                      name: job.name,
                      kind: 'other',
                      size: job.file.size,
                      parsing: false,
                      error: `压缩包解压后的资料会使总量超过 ${formatBytes(MAX_TOTAL_UPLOAD_BYTES)}。为避免漏资料，本次不能继续生成，请把压缩包拆分后重新上传。`,
                      attribution: job.attribution,
                      platform: job.platform,
                      purpose: job.purpose,
                      kindV1: job.kindV1,
                      topLevelId: job.id
                    }
                  ]
                }
              }
              return {
                sources: [
                  ...retainedSources,
                  ...retainedItems.map((it) => ({
                    id: crypto.randomUUID(),
                    name: it.name,
                    kind: it.kind,
                    size: it.size,
                    dataUrl: it.dataUrl,
                    text: it.ok ? it.text : undefined,
                    parsing: false,
                    error: it.ok ? undefined : it.error,
                    warning: it.ok ? it.warning : undefined,
                    attribution: inferAttribution(`${job.name}/${it.name}`),
                    platform: inferSourcePlatform(`${job.name}/${it.name}`, it.text || ''),
                    purpose: inferPurpose(`${job.name}/${it.name}`),
                    kindV1: inferKindV1(`${job.name}/${it.name}`),
                    note: `来自压缩包：${job.name}`,
                    topLevelId: job.id,
                    derivedKind: 'archive-entry' as const
                  }))
                ]
              }
            })
            continue
          }

          if (job.kind === 'image') {
            const dataUrl = await downscaleImage(job.file)
            set((s) =>
              s.analysisSessionId === sessionId
                ? {
                    sources: s.sources.map((a) =>
                      a.id === job.id ? { ...a, parsing: false, dataUrl, error: undefined } : a
                    )
                  }
                : s
            )
            continue
          }

          const buf = await job.file.arrayBuffer()
          const parsed = await window.api.parseFile(job.file.name, buf)
          const attachments = await Promise.all(
            (parsed.attachments || []).map(async (item) => {
              if (!item.ok || item.kind !== 'image' || !item.dataUrl) return item
              try {
                const imageFile = fileFromDataUrl(item.dataUrl, item.name)
                return { ...item, dataUrl: await downscaleImage(imageFile) }
              } catch (error) {
                return {
                  ...item,
                  ok: false,
                  dataUrl: undefined,
                  error: `Office 内嵌图片无法读取：${error instanceof Error ? error.message : String(error)}`
                }
              }
            })
          )
          set((s) => {
            if (s.analysisSessionId !== sessionId) return s
            const retainedSources = s.sources.filter((source) => source.id !== job.id)
            const groupedAttachments: SourceImageAttachment[] = attachments.map((item) => ({
              name: item.name,
              size: item.size,
              dataUrl: item.ok ? item.dataUrl : undefined,
              error: item.ok ? undefined : item.error
            }))
            const failedAttachments = groupedAttachments.filter((item) => item.error)
            const attachmentWarning = groupedAttachments.length
              ? `已归并读取 ${groupedAttachments.length} 张内嵌图片，作为「${job.name}」的一部分清洗。`
              : ''
            const parent: Source = {
              id: job.id,
              name: job.name,
              kind: job.kind,
              size: job.file.size,
              parsing: false,
              text: parsed.text || undefined,
              attachments: groupedAttachments.length ? groupedAttachments : undefined,
              error: !parsed.ok
                ? parsed.error
                : failedAttachments.length
                  ? `${failedAttachments.length} 张内嵌图片无法读取：${failedAttachments.slice(0, 3).map((item) => item.name).join('、')}`
                  : undefined,
              warning: [parsed.warning, attachmentWarning].filter(Boolean).join(' ') || undefined,
              attribution: job.attribution,
              platform: job.platform || inferSourcePlatform(job.name, parsed.text || ''),
              purpose: job.purpose,
              kindV1: job.kindV1,
              topLevelId: job.id
            }
            return { sources: [...retainedSources, parent] }
          })
        } catch (err) {
          set((s) =>
            s.analysisSessionId === sessionId
              ? {
                  sources: s.sources.map((a) =>
                    a.id === job.id ? { ...a, parsing: false, error: err instanceof Error ? err.message : String(err) } : a
                  )
                }
              : s
          )
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(PARSE_CONCURRENCY, jobs.length) }, () => worker()))
  },

  removeSource: (id) =>
    set((s) => {
      if (isRunningPhase(s.phase) || !s.sources.some((source) => source.id === id)) return s
      return {
        ...invalidatedAnalysis(),
        ...preserveCommittedReport(s),
        sources: s.sources.filter((source) => source.id !== id),
        cleanDetails: s.cleanDetails.filter((detail) => detail.id !== id)
      }
    }),

  setSourceAttribution: (id, attribution) =>
    set((s) =>
      isRunningPhase(s.phase)
        ? s
        : {
            ...invalidatedAnalysis(),
            ...preserveCommittedReport(s),
            sources: s.sources.map((x) => (x.id === id ? { ...x, attribution } : x)),
            cleanDetails: s.cleanDetails.filter((d) => d.id !== id)
          }
    ),

  setUnconfirmedAttribution: (attribution) =>
    set((s) => {
      if (isRunningPhase(s.phase)) return s
      const changedIds = new Set(
        s.sources
          .filter((source) => sourceHasContent(source) && !source.attribution)
          .map((source) => source.id)
      )
      if (!changedIds.size) return s
      return {
        ...invalidatedAnalysis(),
        ...preserveCommittedReport(s),
        sources: s.sources.map((source) =>
          changedIds.has(source.id) ? { ...source, attribution } : source
        ),
        cleanDetails: s.cleanDetails.filter((detail) => !changedIds.has(detail.id))
      }
    }),

  setSourcePlatform: (id, platform) =>
    set((s) =>
      isRunningPhase(s.phase)
        ? s
        : {
            ...invalidatedAnalysis(),
            ...preserveCommittedReport(s),
            sources: s.sources.map((x) => (x.id === id ? { ...x, platform } : x)),
            cleanDetails: s.cleanDetails.filter((d) => d.id !== id)
          }
    ),

  setSourcePurpose: (id, purpose) =>
    set((s) =>
      isRunningPhase(s.phase)
        ? s
        : {
            ...invalidatedAnalysis(),
            ...preserveCommittedReport(s),
            sources: s.sources.map((x) => (x.id === id ? { ...x, purpose } : x)),
            cleanDetails: s.cleanDetails.filter((d) => d.id !== id)
          }
    ),

  setSourceKindV1: (id, kindV1) =>
    set((s) =>
      isRunningPhase(s.phase)
        ? s
        : {
            ...invalidatedAnalysis(),
            ...preserveCommittedReport(s),
            sources: s.sources.map((source) => (source.id === id ? { ...source, kindV1 } : source)),
            cleanDetails: s.cleanDetails.filter((detail) => detail.id !== id),
            moduleStates: {}
          }
    ),

  setSourceNote: (id, note) =>
    set((s) =>
      isRunningPhase(s.phase)
        ? s
        : {
            ...invalidatedAnalysis(),
            ...preserveCommittedReport(s),
            sources: s.sources.map((x) => (x.id === id ? { ...x, note } : x)),
            cleanDetails: s.cleanDetails.filter((d) => d.id !== id)
          }
    ),

  startGeneration: async () => {
    const { sources, phase, readOnly, legacyNotice } = get()
    if (phase === 'cleaning' || phase === 'analyzing') return
    if (readOnly) {
      get()._post('assistant', legacyNotice || '此报告由旧版本生成，仅支持查看导出。请点击“新建分析”使用新版。', 'error')
      return
    }
    if (sources.some((s) => s.parsing)) {
      get()._post('assistant', '还有文件正在本地解析，请等解析完成后再开始生成。', 'narration')
      return
    }
    const parseFailures = sources.filter((source) => source.error && !/^已忽略[：:]/u.test(source.error.trim()))
    if (parseFailures.length) {
      const names = parseFailures.slice(0, 3).map((source) => `「${source.name}」`).join('、')
      const more = parseFailures.length > 3 ? `等 ${parseFailures.length} 份` : ''
      get()._post(
        'assistant',
        `${names}${more}尚未成功解析。为避免报告漏掉资料，本次没有开始分析。请按文件下方提示处理后重新上传，或确认不需要该资料后点右上角“×”移除。`,
        'error'
      )
      return
    }
    const unconfirmed = sources.filter((s) => sourceHasContent(s) && !s.attribution)
    if (unconfirmed.length) {
      get()._post('assistant', `还有 ${unconfirmed.length} 份资料没有确认归属。请在文件下方点“自有数据”或“竞品数据”。`, 'narration')
      return
    }
    const missingKinds = sources.filter((source) => sourceHasContent(source) && !source.kindV1)
    if (missingKinds.length) {
      get()._post('assistant', `还有 ${missingKinds.length} 份资料没有选择业务类型。请为每份资料选择产品、经营、素材、人群或用户声音。`, 'narration')
      return
    }
    if (!sources.some(sourceHasContent)) {
      get()._post('assistant', '还没有可用的资料。请先上传截图/表格/文档/zip/文件夹，再点「开始生成」。', 'narration')
      return
    }
    try {
      if (typeof window.api.preflightProjectStorage === 'function') {
        const current = get()
        const storage = await window.api.preflightProjectStorage(buildProjectSnapshot(current))
        if (!storage.ok) {
          get()._post('assistant', storage.message, 'error')
          return
        }
      }
    } catch (error) {
      get()._post(
        'assistant',
        `开始前无法确认项目能否安全保存：${String(error instanceof Error ? error.message : error)}。请确认磁盘至少有 1GB 可用空间后重试。`,
        'error'
      )
      return
    }
    try {
      const cached = await window.api.lookupReportResultCache(reportResultCacheInput(sources, get().steering))
      if (cached.hit && validReportCacheSnapshot(cached.snapshot)) {
        set({ reportReuseOffer: cached })
        return
      }
    } catch {
      // 缓存不可读、版本不匹配或已损坏时自动正常生成。
    }
    await get()._startPaidGeneration()
  },

  acceptReportReuse: async () => {
    const offer = get().reportReuseOffer
    if (!offer || !validReportCacheSnapshot(offer.snapshot)) {
      set({ reportReuseOffer: null })
      get()._post('assistant', '上次报告缓存已失效，将按正常流程重新生成。', 'narration')
      await get()._startPaidGeneration()
      return
    }
    const usable = get().sources.filter(sourceHasContent)
    if (
      usable.length !== offer.snapshot.cleanDetails.length ||
      usable.some((source, index) => source.name !== offer.snapshot!.cleanDetails[index]?.name)
    ) {
      set({ reportReuseOffer: null })
      get()._post('assistant', '资料已发生变化，无法复用旧报告，将按正常流程重新生成。', 'narration')
      await get()._startPaidGeneration()
      return
    }
    const sessionId = get().analysisSessionId
    set({
      reportReuseOffer: null,
      cleanedData: offer.snapshot.cleanedData,
      cleanDetails: usable.map((source, index) => ({
        id: source.id,
        name: source.name,
        text: offer.snapshot!.cleanDetails[index].text
      })),
      artifacts: { ...offer.snapshot.artifacts },
      reportMarkdown: offer.snapshot.reportMarkdown,
      reportStale: false,
      phase: 'done',
      abortFn: null,
      cleaningProgress: emptyCleaningProgress(),
      moduleStates: Object.fromEntries(REPORT_MODULES.map((module) => [
        module.key,
        { status: offer.snapshot!.artifacts[module.id]?.trim() ? 'done' : 'skipped', updatedAt: new Date().toISOString() }
      ]))
    })
    get()._post('assistant', '✅ 已恢复上次的完整报告（6模块），可直接检查和导出。', 'checkpoint')
    void recordOptimizationEvent(
      optimizationEvent(`report-reuse:${sessionId}:${offer.cacheKey}`, sessionId, 'report_cache_reuse', {
        // v2 固定6个模块；文件清洗可能本来也会走本地缓存，因此不计入。
        skippedModelRequests: 6,
        reusedReports: 1
      })
    )
  },

  regenerateReport: async () => {
    set({ reportReuseOffer: null })
    await get()._startPaidGeneration()
  },

  _startPaidGeneration: async () => {
    const { settings, phase } = get()
    if (phase === 'cleaning' || phase === 'analyzing') return
    let startingPoints: number | undefined
    const pointsApi = window.api as typeof window.api & {
      canStartPointsReport?: typeof window.api.canStartPointsReport
    }
    if (typeof pointsApi.canStartPointsReport === 'function') {
      const access = await pointsApi.canStartPointsReport()
      if (!access.ok) {
        get()._post('assistant', access.message, 'error')
        return
      }
      startingPoints = access.wallet.balancePoints
    }
    const managed = settings?.managedModel?.enabled ? settings.managedModel : undefined
    const profile =
      settings?.profiles.find((p) => p.id === settings.activeProfileId) ?? settings?.profiles[0]
    const modelConfigured = managed?.configured || Boolean(
      profile && profile.baseURL.trim() && profile.model.trim() && profile.apiKey.trim()
    )
    if (!modelConfigured) {
      set({ settingsOpen: true })
      get()._post(
        'assistant',
        managed
          ? managed.error || '内置模型服务暂不可用，请联系软件管理员。'
          : '还没有完成模型配置。请打开设置，粘贴 API Key 并完成“测试连通”后保存。',
        'error'
      )
      return
    }
    const activeEndpoint = managed?.baseURL.trim().replace(/\/+$/, '') || profile?.baseURL.trim().replace(/\/+$/, '') || ''
    if (!settings?.privacyAccepted || settings.privacyEndpoint !== activeEndpoint) {
      get()._post('assistant', '开始前请先确认资料将发送到当前模型服务。完成隐私确认后再点“开始生成报告”。', 'error')
      return
    }
    if (startingPoints !== undefined) {
      get()._post(
        'assistant',
        `当前剩余 ${startingPoints.toLocaleString('zh-CN', { maximumFractionDigits: 3 })} 积分，正在准备生成报告。`,
        'narration'
      )
    }
    set((state) => ({ ...preserveCommittedReport(state), reportReuseOffer: null }))
    try {
      await get()._runCleaning(false)
    } catch (error) {
      set({ phase: 'idle', abortFn: null })
      get()._post('assistant', `本次分析没有启动成功：${friendlyError(error)}`, 'error')
    }
  },

  // 分批清洗：并发抽取每个文件(最多4个) → 均衡汇总；单个文件失败不阻断其他文件完成。
  _runCleaning: async (isRerun) => {
    const sessionId = get().analysisSessionId
    const isCurrentSession = (): boolean => get().analysisSessionId === sessionId
    set({ phase: 'cleaning', cleanedData: '' })
    const usable = get().sources.filter(sourceHasContent)
    const sourceCount = usable.length
    const imageCount = sourceImageCount(usable)
    const usableIds = new Set(usable.map((s) => s.id))
    // 丢掉已删除文件的旧明细；只抽取还没处理过的文件（支持中断续跑 / 补传后只洗新文件）
    set((st) => ({ cleanDetails: st.cleanDetails.filter((d) => usableIds.has(d.id)) }))
    const doneIds = new Set(get().cleanDetails.map((d) => d.id))
    const initialTodo = usable.filter((s) => !doneIds.has(s.id))
    const cleaningPlan = buildCleaningPlan(initialTodo.map((source) => ({
      ...toSourceCleanCacheInput(source),
      id: source.id,
      error: source.error
    })))
    const planBySource = new Map(cleaningPlan.entries.map((entry) => [entry.sourceId, entry]))
    const methodRank: Record<CleaningMethod, number> = {
      local_exact: 0,
      model_semantic: 1,
      model_vision: 2,
      unsupported: 3
    }
    const todo = [...initialTodo].sort((left, right) =>
      methodRank[planBySource.get(left.id)?.method || 'unsupported'] -
      methodRank[planBySource.get(right.id)?.method || 'unsupported']
    )
    set({
      cleaningProgress: {
        total: todo.length,
        done: 0,
        running: [],
        failed: 0,
        startedAt: Date.now(),
        plan: cleaningPlan,
        files: Object.fromEntries(cleaningPlan.entries.map((entry) => [entry.sourceId, {
          name: entry.sourceName,
          method: entry.method,
          status: 'waiting' as const,
          doneJobs: 0,
          totalJobs: Math.max(1, entry.jobs.length)
        }]))
      }
    })

    if (todo.length) {
      const concurrencyPlan = planCleaningConcurrency(todo.length, MAX_CLEANING_CONCURRENCY)
      const conc = concurrencyPlan.sourceWorkers
      get()._post(
        'assistant',
        `${isRerun ? '补充' : '开始'}处理 ${todo.length} 份资料：本机 ${cleaningPlan.localFileCount} 份，AI理解 ${cleaningPlan.modelFileCount} 份，预计 ${cleaningPlan.expectedModelJobs} 个AI任务（并发不超过 ${MAX_CLEANING_CONCURRENCY} 个）。`,
        'narration'
      )
      if (cleaningPlan.oversizedFiles.length) {
        get()._post(
          'assistant',
          `⚠️ 以下文件内容很多，预计超过20个语义批次，将按断点任务逐批处理：${cleaningPlan.oversizedFiles.slice(0, 3).join('、')}`,
          'narration'
        )
      }

      const aborts = new Set<() => void>()
      let cancelled = false
      let pauseAfterFailure = false
      let activeVisionSources = 0
      const failures: Array<{ name: string; error: string }> = []
      set({ abortFn: () => { cancelled = true; aborts.forEach((fn) => fn()) } })

      let next = 0
      const worker = async (): Promise<void> => {
        while (!cancelled && !pauseAfterFailure) {
          const i = next++
          if (i >= todo.length) return
          const s = todo[i]
          const planned = planBySource.get(s.id)
          let visionSlot = false
          if (planned?.method === 'model_vision') {
            while (!cancelled && !pauseAfterFailure && activeVisionSources >= 2) {
              await new Promise<void>((resolve) => window.setTimeout(resolve, 100))
            }
            if (cancelled || pauseAfterFailure) return
            activeVisionSources += 1
            visionSlot = true
          }
          set((st) => ({
            cleaningProgress: {
              ...st.cleaningProgress,
              running: [...st.cleaningProgress.running, s.name].slice(0, 4),
              files: {
                ...st.cleaningProgress.files,
                [s.id]: { ...st.cleaningProgress.files[s.id], status: 'running' }
              }
            }
          }))
          get()._post('assistant', `⏳ 清洗：${s.name}`, 'narration')
          const cacheInput = toSourceCleanCacheInput(s)
          try {
            try {
              const cached = await window.api.lookupSourceCleanCache(cacheInput)
              if (!isCurrentSession()) return
              if (cached.hit && cached.text) {
                set((st) => ({ cleanDetails: [...st.cleanDetails, { id: s.id, name: s.name, text: cached.text! }] }))
                set((st) => ({
                  cleaningProgress: {
                    ...st.cleaningProgress,
                    done: st.cleaningProgress.done + 1,
                    running: st.cleaningProgress.running.filter((name) => name !== s.name),
                    files: {
                      ...st.cleaningProgress.files,
                      [s.id]: { ...st.cleaningProgress.files[s.id], status: 'complete', doneJobs: st.cleaningProgress.files[s.id]?.totalJobs || 1 }
                    }
                  }
                }))
                get()._post('assistant', `♻️ 已复用本机清洗结果：${s.name}`, 'narration')
                await recordOptimizationEvent(
                  optimizationEvent(`source-cache:${sessionId}:${s.id}`, sessionId, 'source_cache_hit', {
                    sourceCacheHits: 1,
                    skippedModelRequests: 1
                  })
                )
                continue
              }
            } catch {
              // 缓存异常不应影响报告生成，继续走原模型清洗流程。
            }
            let modelCleanInput = cacheInput
            if (s.kind === 'table' && cacheInput.text) {
              const localResult = preprocessTableForModel(cacheInput.text)
              if (localResult.applied && localResult.text.trim()) {
                modelCleanInput = { ...cacheInput, text: localResult.text }
              }
              const localDetail = planned?.method === 'local_exact'
                ? buildLocalTableCleanDetail(cacheInput, localResult)
                : null
              if (localDetail) {
                const coverage: CleaningCoverage = {
                  mode: 'local_exact',
                  recordCount: localResult.retainedRows,
                  batchCount: 0,
                  verifiedAt: new Date().toISOString()
                }
                set((st) => ({ cleanDetails: [...st.cleanDetails, { id: s.id, name: s.name, text: localDetail, coverage }] }))
                try {
                  await window.api.storeSourceCleanCache(cacheInput, localDetail)
                } catch {
                  // 本次本地清洗已经完成，缓存写入失败只影响下次复用。
                }
                set((st) => ({
                  cleaningProgress: {
                    ...st.cleaningProgress,
                    done: st.cleaningProgress.done + 1,
                    running: st.cleaningProgress.running.filter((name) => name !== s.name),
                    files: {
                      ...st.cleaningProgress.files,
                      [s.id]: { ...st.cleaningProgress.files[s.id], status: 'complete', doneJobs: st.cleaningProgress.files[s.id]?.totalJobs || 1 }
                    }
                  }
                }))
                get()._post(
                  'assistant',
                  `✅ 本机已读取结构化表格：${s.name}（${localResult.retainedRows} 条记录，未调用模型，本文件未扣清洗积分）`,
                  'narration'
                )
                await recordOptimizationEvent(
                  optimizationEvent(`local-clean:${sessionId}:${s.id}`, sessionId, 'local_source_clean', {
                    localCompletedFiles: 1,
                    skippedModelRequests: 1
                  })
                )
                continue
              }
            }
            const batchPlan = buildSourceCleanBatchPlan(modelCleanInput, {
              semanticSummary: planned?.method === 'model_semantic' && s.kind === 'table'
            })
            if (batchPlan.degradedReason) {
              const reason = batchPlan.degradedReason === 'quotes'
                ? '引号未闭合'
                : batchPlan.degradedReason === 'too_wide'
                  ? '列数超过200'
                  : '有效行列不足，无法识别为规则表格'
              const warning = `该表格结构不规则（${reason}），已按整篇文本清洗；逐行核对不可用，请在资料确认页重点检查这份文件。`
              set((state) => ({
                sources: state.sources.map((source) => source.id === s.id ? { ...source, warning } : source)
              }))
              get()._post('assistant', `⚠️ ${s.name}：${warning}`, 'narration')
            }
            const batchOutputs: Array<string | undefined> = new Array(batchPlan.batches.length)
            const perSourceBatchConcurrency = planned?.method === 'model_vision'
              ? 1
              : Math.min(batchPlan.batches.length, concurrencyPlan.batchWorkersPerSource)
            if (batchPlan.batches.length > 1 && perSourceBatchConcurrency > 1) {
              get()._post(
                'assistant',
                `「${s.name}」共 ${batchPlan.batches.length} 批，将同时处理 ${perSourceBatchConcurrency} 批以缩短等待时间。`,
                'narration'
              )
            }
            let sourceFailed = false
            let activeBatchRequests = 0
            const markSourceFailure = (error: string): void => {
              if (sourceFailed) return
              sourceFailed = true
              pauseAfterFailure = true
              failures.push({ name: s.name, error })
              set((state) => ({
                cleaningProgress: {
                  ...state.cleaningProgress,
                  running: state.cleaningProgress.running.filter((name) => name !== s.name),
                  failed: state.cleaningProgress.failed + 1,
                  files: {
                    ...state.cleaningProgress.files,
                    [s.id]: { ...state.cleaningProgress.files[s.id], status: 'failed' }
                  }
                }
              }))
            }
            const runWithReservationBackpressure = async (
              label: string,
              run: () => ReturnType<typeof runModelRetry>
            ): Promise<Awaited<ReturnType<typeof runModelRetry>>> => {
              let reservationRetry = 0
              while (!cancelled && isCurrentSession()) {
                activeBatchRequests += 1
                let result: Awaited<ReturnType<typeof runModelRetry>>
                try {
                  result = await run()
                } finally {
                  activeBatchRequests = Math.max(0, activeBatchRequests - 1)
                }
                if (
                  result.ok || reservationRetry >= perSourceBatchConcurrency ||
                  !isTemporaryReservationContention(result.error, activeBatchRequests)
                ) return result
                reservationRetry += 1
                get()._post(
                  'assistant',
                  `${label}正在等待其他批次释放预留积分，释放后会自动继续，不会重复扣费。`,
                  'narration'
                )
                let waits = 0
                while (activeBatchRequests > 0 && !cancelled && isCurrentSession() && waits < 600) {
                  await new Promise<void>((resolve) => window.setTimeout(resolve, 500))
                  waits += 1
                  if (waits % 30 === 0 && activeBatchRequests > 0) {
                    const remainingSeconds = Math.max(0, 300 - Math.floor(waits / 2))
                    get()._post(
                      'assistant',
                      `${label}仍在等待其他批次完成，最多再等待约 ${remainingSeconds} 秒；等待期间不会重复扣费。`,
                      'narration'
                    )
                  }
                }
                if (activeBatchRequests > 0 && !cancelled && isCurrentSession()) {
                  return {
                    ok: false,
                    text: '',
                    error: '积分预留竞争超时，稍后重试即可，本次未扣费。'
                  }
                }
              }
              return { ok: false, text: '', error: '已停止' }
            }
            let nextBatch = 0
            const batchWorker = async (): Promise<void> => {
              while (!cancelled && !sourceFailed && isCurrentSession()) {
                const batchPosition = nextBatch++
                if (batchPosition >= batchPlan.batches.length) return
                const batch = batchPlan.batches[batchPosition]
                if (
                  batchPlan.batches.length > 1 &&
                  (batch.context.batchIndex === 1 || batch.context.batchIndex === batch.context.batchCount || batch.context.batchIndex % 5 === 0)
                ) {
                  get()._post(
                    'assistant',
                    `正在清洗「${s.name}」第 ${batch.context.batchIndex}/${batch.context.batchCount} 批……`,
                    'narration'
                  )
                }
                const batchTaskId = `${sessionId}:source_clean:${s.id}:batch-v7-planned:${batch.context.batchIndex}`
                const savedBatch = get().taskJournal[batchTaskId]
                if (savedBatch?.status === 'complete' && savedBatch.output?.trim()) {
                  batchOutputs[batchPosition] = savedBatch.output
                  set((state) => ({
                    cleaningProgress: {
                      ...state.cleaningProgress,
                      files: {
                        ...state.cleaningProgress.files,
                        [s.id]: {
                          ...state.cleaningProgress.files[s.id],
                          doneJobs: Math.min(
                            state.cleaningProgress.files[s.id]?.totalJobs || batchPlan.batches.length,
                            (state.cleaningProgress.files[s.id]?.doneJobs || 0) + 1
                          )
                        }
                      }
                    }
                  }))
                  continue
                }
                const res = await runWithReservationBackpressure(
                  `「${s.name}」第 ${batch.context.batchIndex} 批`,
                  () => runModelRetry(
                    buildExtractMessages(batch.source, batch.context),
                    () => {},
                    (fn) => {
                      if (fn) aborts.add(fn)
                    },
                    undefined,
                    1,
                    {
                      reportSessionId: sessionId,
                      taskType: 'source_clean',
                      taskKey: batchTaskId,
                      billingRequestId: batchTaskId,
                      isVision: planned?.method === 'model_vision',
                      sourceCount,
                      imageCount,
                      sourceId: s.id,
                      stepId: `batch-${batch.context.batchIndex}-of-${batch.context.batchCount}`
                    }
                  )
                )
                if (!isCurrentSession()) return
                if (!res.ok) {
                  const suffix = batchPlan.batches.length > 1
                    ? `（第 ${batch.context.batchIndex}/${batch.context.batchCount} 批）`
                    : ''
                  markSourceFailure(`${suffix}${res.error || '失败'}`)
                  continue
                }
                let verifiedText = res.text
                const missingEvidence = missingSourceCleanEvidenceIds(batch.context, verifiedText, batch.context.mode)
                if (missingEvidence.length) {
                  get()._post(
                    'assistant',
                    `「${s.name}」第 ${batch.context.batchIndex} 批漏了 ${missingEvidence.length} 个证据单元，正在只补做这一批……`,
                    'narration'
                  )
                  const repairTaskId = `${batchTaskId}:coverage-repair-v1`
                  const repair = await runWithReservationBackpressure(
                    `「${s.name}」第 ${batch.context.batchIndex} 批补做`,
                    () => runModelRetry(
                      buildExtractMessages(batch.source, batch.context),
                      () => {},
                      (fn) => {
                        if (fn) aborts.add(fn)
                      },
                      undefined,
                      0,
                      {
                        reportSessionId: sessionId,
                        taskType: 'source_clean',
                        taskKey: repairTaskId,
                        billingRequestId: repairTaskId,
                        isVision: planned?.method === 'model_vision',
                        sourceCount,
                        imageCount,
                        sourceId: s.id,
                        stepId: `batch-${batch.context.batchIndex}-coverage-repair`
                      }
                    )
                  )
                  if (!repair.ok || missingSourceCleanEvidenceIds(batch.context, repair.text, batch.context.mode).length) {
                    markSourceFailure(`第 ${batch.context.batchIndex}/${batch.context.batchCount} 批仍有证据未覆盖，已停止该文件，避免漏资料。`)
                    continue
                  }
                  verifiedText = repair.text
                }
                batchOutputs[batchPosition] = verifiedText
                set((state) => ({
                  taskJournal: {
                    ...state.taskJournal,
                    [batchTaskId]: {
                      kind: 'source_clean',
                      status: 'complete',
                      output: verifiedText,
                      updatedAt: new Date().toISOString()
                    }
                  },
                  cleaningProgress: {
                    ...state.cleaningProgress,
                    files: {
                      ...state.cleaningProgress.files,
                      [s.id]: {
                        ...state.cleaningProgress.files[s.id],
                        doneJobs: Math.min(
                          state.cleaningProgress.files[s.id]?.totalJobs || batchPlan.batches.length,
                          (state.cleaningProgress.files[s.id]?.doneJobs || 0) + 1
                        )
                      }
                    }
                  }
                }))
                scheduleCleaningCheckpointSave(get)
              }
            }
            await Promise.all(Array.from({ length: perSourceBatchConcurrency }, () => batchWorker()))
            if (!isCurrentSession()) return
            if (
              sourceFailed ||
              batchOutputs.filter((output) => Boolean(output?.trim())).length !== batchPlan.batches.length
            ) continue
            const cleanText = combineSourceCleanBatchOutputs(batchPlan, batchOutputs as string[])
            const coverage: CleaningCoverage = {
              mode: 'model_batches',
              recordCount: batchPlan.scheduledRecordCount,
              imageCount: planned?.method === 'model_vision'
                ? batchPlan.batches.reduce((sum, batch) => sum + (batch.source.dataUrl ? 1 : 0) + (batch.source.attachments?.length || 0), 0)
                : undefined,
              batchCount: batchPlan.batches.length,
              verifiedAt: new Date().toISOString()
            }
            set((st) => ({ cleanDetails: [...st.cleanDetails, { id: s.id, name: s.name, text: cleanText, coverage }] }))
            try {
              await window.api.storeSourceCleanCache(cacheInput, cleanText)
            } catch {
              // 写缓存失败只影响下次复用，不影响本次分析结果。
            }
            set((st) => ({
              cleaningProgress: {
                ...st.cleaningProgress,
                done: st.cleaningProgress.done + 1,
                running: st.cleaningProgress.running.filter((name) => name !== s.name),
                files: {
                  ...st.cleaningProgress.files,
                  [s.id]: { ...st.cleaningProgress.files[s.id], status: 'complete', doneJobs: st.cleaningProgress.files[s.id]?.totalJobs || batchPlan.batches.length }
                }
              }
            }))
            get()._post(
              'assistant',
              (batchPlan.mode === 'table_rows' || batchPlan.mode === 'semantic_rows') && batchPlan.originalRecordCount !== undefined
                ? `✅ 已清洗：${s.name}（${batchPlan.originalRecordCount} 条记录，${batchPlan.batches.length} 批全部完成）`
                : `✅ 已清洗：${s.name}（${batchPlan.batches.length} 批全部完成）`,
              'narration'
            )
          } catch (error) {
            pauseAfterFailure = true
            failures.push({ name: s.name, error: friendlyError(error) })
            set((st) => ({
              cleaningProgress: {
                ...st.cleaningProgress,
                running: st.cleaningProgress.running.filter((name) => name !== s.name),
                failed: st.cleaningProgress.failed + 1,
                files: {
                  ...st.cleaningProgress.files,
                  [s.id]: { ...st.cleaningProgress.files[s.id], status: 'failed' }
                }
              }
            }))
          } finally {
            if (visionSlot) activeVisionSources = Math.max(0, activeVisionSources - 1)
          }
        }
      }
      await Promise.all(Array.from({ length: conc }, () => worker()))
      if (!isCurrentSession()) return
      set({ abortFn: null })

      // 并发完成顺序不稳定；统一恢复为用户上传顺序，防止汇总、缓存和恢复时错配文件。
      const completedById = new Map(get().cleanDetails.map((detail) => [detail.id, detail]))
      set({ cleanDetails: usable.flatMap((source) => {
        const detail = completedById.get(source.id)
        return detail ? [detail] : []
      }) })

      if (cancelled) {
        set({ phase: get().cleanedData ? 'checkpoint1' : 'idle' })
        return
      }
      if (failures.length) {
        set((state) => ({
          cleaningProgress: {
            ...state.cleaningProgress,
            files: Object.fromEntries(Object.entries(state.cleaningProgress.files).map(([id, file]) => [
              id,
              file.status === 'waiting' ? { ...file, status: 'not_started' as const } : file
            ]))
          }
        }))
        const preview = failures
          .slice(0, 3)
          .map((failure) => `「${failure.name}」：${failure.error}`)
          .join('\n')
        const more = failures.length > 3 ? `\n另有 ${failures.length - 3} 份资料未完成。` : ''
        get()._post(
          'assistant',
          `⚠️ 有 ${failures.length} 份资料本轮未完成。发生异常后，软件没有再启动新的资料；当时已经在处理的资料已完成并保留：\n${preview}${more}\n请根据提示处理后再点「开始生成」，软件只会重试未完成的资料。`,
          'error'
        )
        set({ phase: get().cleanedData ? 'checkpoint1' : 'idle' })
        return
      }
    }

    const detailFull = get().cleanDetails.map((d) => `### ${d.name}\n${d.text}`).join('\n\n')
    set({
      cleanedData: `## 各来源清洗明细\n\n${detailFull}`,
      phase: 'checkpoint1'
    })
    get()._post(
      'assistant',
      isRerun
        ? '✅ 未完成资料已补充清洗。请核对文件归属和清洗内容，没问题点「确认，继续分析」。'
        : '✅ 所有资料已完成清洗并保存。请核对每份文件的归属、平台和清洗内容；确认后软件才会开始资料汇总与经营分析。',
      'checkpoint'
    )
  },

  _runAnalysis: async () => {
    const sessionId = get().analysisSessionId
    const isCurrentSession = (): boolean => get().analysisSessionId === sessionId
    set({ phase: 'analyzing' })
    const detailsById = new Map(get().cleanDetails.map((detail) => [detail.id, detail.text]))
    const analysisSources = get().sources.map((source) => ({
      ...source,
      platform: source.platform || inferSourcePlatform(source.name, detailsById.get(source.id) || source.text || '')
    }))
    if (analysisSources.some((source, index) => source.platform !== get().sources[index]?.platform)) {
      set({ sources: analysisSources })
    }
    const sufficiency = evaluateSourceSufficiency(REPORT_MODULES, analysisSources.map((source) => source.kindV1))
    if (sufficiency.blocked) {
      set({ phase: 'checkpoint1', abortFn: null })
      get()._post('assistant', sufficiency.blocked, 'error')
      return
    }
    const sourceCountV1 = topLevelSourceCount(analysisSources)
    const imageCountV1 = sourceImageCount(analysisSources)
    const activeReportSessionId = sessionId
    const updateModuleState = (key: ModuleKey, state: ModuleRunState): void => {
      set((current) => ({ moduleStates: { ...current.moduleStates, [key]: state } }))
    }
    const moduleByKey = new Map(REPORT_MODULES.map((module) => [module.key, module]))
    const runModule = async (module: typeof REPORT_MODULES[number]): Promise<void> => {
      if (!isCurrentSession()) return
      const skippedReason = sufficiency.skipped.get(module.key)
      if (skippedReason) {
        updateModuleState(module.key, { status: 'skipped', message: skippedReason, updatedAt: new Date().toISOString() })
        return
      }
      const savedTaskId = `${sessionId}:module:v2:${module.key}`
      const saved = get().taskJournal[savedTaskId]
      const outsideTargetedRetry = get().moduleRetryScope.length > 0 && !get().moduleRetryScope.includes(module.key)
      if (outsideTargetedRetry) {
        const retained = get().artifacts[module.id]
        const retainedState = get().moduleStates[module.key]
        if (retained?.trim()) {
          updateModuleState(module.key, {
            status: 'done',
            message: retainedState?.message,
            updatedAt: retainedState?.updatedAt || new Date().toISOString()
          })
          return
        }
        if (retainedState?.status === 'skipped') return
      }
      const moduleSources = analysisSources.flatMap((source) => {
        if (!source.kindV1 || !module.requiredSources.includes(source.kindV1)) return []
        const text = detailsById.get(source.id)
        return text ? [{ name: source.name, kindV1: source.kindV1, attribution: source.attribution, platform: source.platform, text }] : []
      })
      const upstream = module.dependsOn.flatMap((key) => {
        const dependency = moduleByKey.get(key)
        const output = dependency ? get().artifacts[dependency.id] : ''
        return dependency && output ? [{ key, title: `M${dependency.id} ${dependency.title}`, output }] : []
      })
      if (module.dependsOn.length > 0 && module.requiredSources.length === 0 && upstream.length === 0) {
        const message = `暂无分析：缺少${module.dependsOn.map((key) => moduleByTitle(key)).join('、')}的可用结果。`
        updateModuleState(module.key, { status: 'skipped', message, updatedAt: new Date().toISOString() })
        return
      }
      updateModuleState(module.key, { status: 'running', updatedAt: new Date().toISOString() })
      const prompt = await window.api.getModulePrompt(module.key)
      const missingDependencies = [
        ...module.dependsOn.flatMap((key) => {
        const dependency = moduleByKey.get(key)
        return dependency && !get().artifacts[dependency.id] ? [`M${dependency.id} ${dependency.title}`] : []
        }),
        ...(sufficiency.partial.get(module.key) ? [sufficiency.partial.get(module.key)!] : [])
      ]
      const requirements = [get().steering, get().moduleRetryInstructions[module.key]].filter(Boolean).join('\n')
      const messages = buildModuleMessages(module, { prompt, sources: moduleSources, upstream, missingDependencies, requirements })
      const inputFingerprint = fingerprintModuleMessages(messages, 'v2')
      const reusableInput = outsideTargetedRetry || saved?.inputFingerprint === inputFingerprint
      if (reusableInput && saved?.output?.trim() && isNoAnalysisOutput(saved.output)) {
        const output = normalizeNoAnalysisOutput(saved.output)
        updateModuleState(module.key, { status: 'skipped', message: output, updatedAt: saved.updatedAt })
        return
      }
      if (reusableInput && saved?.status === 'complete' && saved.output?.trim()) {
        const output = module.key === 'material-review'
            ? normalizeMaterialReviewOutput(saved.output)
            : saved.output
        set((state) => ({ artifacts: { ...state.artifacts, [module.id]: output } }))
        updateModuleState(module.key, { status: 'done', updatedAt: saved.updatedAt })
        return
      }
      if (module.key === 'benchmark-brands') {
        const message = '暂无分析：对标联网模块仅保留为旧版兼容，不参与v2六模块分析。'
        updateModuleState(module.key, { status: 'skipped', message, updatedAt: new Date().toISOString() })
        return
      }
      const moduleTaskContext = {
        reportSessionId: activeReportSessionId,
        taskType: MODULE_TASK_TYPES[module.key],
        taskKey: savedTaskId,
        billingRequestId: savedTaskId,
        isVision: false,
        sourceCount: sourceCountV1,
        imageCount: imageCountV1,
        stepId: module.key
      } as const
      let result = await runModelRetry(
        messages,
        () => {},
        (fn) => {
          if (isCurrentSession()) set({ abortFn: fn })
        },
        (attempt) => {
          if (isCurrentSession()) get()._post('assistant', `M${module.id} ${module.title}连接中断，正在重试（第${attempt}次）…`, 'narration')
        },
        3,
        moduleTaskContext
      )
      if (!isCurrentSession()) return
      if (!result.ok || !result.text.trim()) {
        const message = result.error || '模块没有返回内容'
        updateModuleState(module.key, { status: 'failed', message, updatedAt: new Date().toISOString() })
        set((state) => ({
          taskJournal: {
            ...state.taskJournal,
            [savedTaskId]: { kind: 'module', status: 'failed', output: result.text, inputFingerprint, updatedAt: new Date().toISOString() }
          }
        }))
        return
      }
      let moduleOutput = module.key === 'material-review'
        ? normalizeMaterialReviewOutput(result.text)
        : result.text
      let validationErrors = validateModuleOutput(module.key, moduleOutput, 'v2')
      if (validationErrors.length && !isNoAnalysisOutput(moduleOutput) && !isUserStop(result.error)) {
        get()._post('assistant', `M${module.id} ${module.title}缺少必要内容，正在自动补全，不需要手动重试。`, 'narration')
        for (let validationPass = 1; validationPass <= 2 && validationErrors.length > 0; validationPass++) {
          const corrected = await runModelRetry(
            [
              ...messages,
              { role: 'assistant' as const, content: moduleOutput.slice(0, 16_000) },
              {
                role: 'user' as const,
                content: moduleValidationRetryInstruction(module, validationErrors, validationPass)
              }
            ],
            () => {},
            (fn) => {
              if (isCurrentSession()) set({ abortFn: fn })
            },
            undefined,
            1,
            { ...moduleTaskContext, stepId: `${module.key}-validation-retry-${validationPass}` }
          )
          if (!corrected.ok || !corrected.text.trim()) break
          result = corrected
          moduleOutput = module.key === 'material-review'
            ? normalizeMaterialReviewOutput(corrected.text)
            : corrected.text
          validationErrors = validateModuleOutput(module.key, moduleOutput, 'v2')
          if (validationErrors.length > 0 && validationPass < 2) {
            get()._post('assistant', `M${module.id} ${module.title}仍是过程说明或缺项，正在做最后一次结构纠正。`, 'narration')
          }
        }
      }
      if (validationErrors.length) {
        const message = validationErrors.join('；')
        updateModuleState(module.key, { status: 'failed', message, updatedAt: new Date().toISOString() })
        set((state) => ({
          taskJournal: {
            ...state.taskJournal,
            [savedTaskId]: { kind: 'module', status: 'failed', output: moduleOutput, inputFingerprint, updatedAt: new Date().toISOString() }
          }
        }))
        return
      }
      if (isNoAnalysisOutput(moduleOutput)) {
        const output = normalizeNoAnalysisOutput(moduleOutput)
        set((state) => ({
          taskJournal: {
            ...state.taskJournal,
            [savedTaskId]: { kind: 'module', status: 'complete', output, inputFingerprint, updatedAt: new Date().toISOString() }
          }
        }))
        updateModuleState(module.key, { status: 'skipped', message: output, updatedAt: new Date().toISOString() })
        await window.api.saveLastProject(buildProjectSnapshot(get()))
        return
      }
      set((state) => ({
        artifacts: { ...state.artifacts, [module.id]: moduleOutput },
        taskJournal: {
          ...state.taskJournal,
          [savedTaskId]: { kind: 'module', status: 'complete', output: moduleOutput, inputFingerprint, updatedAt: new Date().toISOString() }
        }
      }))
      updateModuleState(module.key, { status: 'done', updatedAt: new Date().toISOString() })
      await window.api.saveLastProject(buildProjectSnapshot(get()))
    }

    for (const wave of [1, 2, 3] as const) {
      if (!isCurrentSession() || get().phase !== 'analyzing') return
      const runnable = REPORT_MODULES.filter((module) => module.wave === wave)
      get()._post('assistant', `正在执行第${wave}/3波：${runnable.map((module) => `M${module.id} ${module.title}`).join('、')}`, 'narration')
      const results = await Promise.allSettled(runnable.map((module) => runModule(module)))
      for (const [index, result] of results.entries()) {
        if (result.status !== 'rejected') continue
        const module = runnable[index]
        const message = friendlyError(result.reason)
        const taskId = `${sessionId}:module:v2:${module.key}`
        updateModuleState(module.key, { status: 'failed', message, updatedAt: new Date().toISOString() })
        set((state) => ({
          taskJournal: {
            ...state.taskJournal,
            [taskId]: { kind: 'module', status: 'failed', updatedAt: new Date().toISOString() }
          }
        }))
      }
    }
    if (!isCurrentSession()) return
    const outputByKey: Partial<Record<ModuleKey, string>> = {}
    const messageByKey: Partial<Record<ModuleKey, string>> = {}
    for (const module of REPORT_MODULES) {
      outputByKey[module.key] = get().artifacts[module.id]
      messageByKey[module.key] = get().moduleStates[module.key]?.message
    }
    const report = assembleModuleReport(REPORT_MODULES, outputByKey, messageByKey, get().legacyBenchmarkAppendix)
    set((state) => ({
      reportMarkdown: report,
      artifacts: { ...state.artifacts, [REPORT_STEP_ID]: report },
      reportStale: false,
      phase: 'done',
      abortFn: null
    }))
    await window.api.saveLastProject(buildProjectSnapshot(get()))
    await storeCompleteReportResult(get()).catch(() => undefined)
    const finishedStates = REPORT_MODULES.map((module) => get().moduleStates[module.key]?.status)
    const failedCount = finishedStates.filter((status) => status === 'failed').length
    const skippedCount = finishedStates.filter((status) => status === 'skipped').length
    const doneCount = finishedStates.filter((status) => status === 'done').length
    if (failedCount > 0) {
      get()._post(
        'assistant',
        `⚠️ 6模块流程已结束：成功 ${doneCount} 个、暂无分析 ${skippedCount} 个、失败 ${failedCount} 个。失败模块没有生成内容，可在左侧点击“重试本模块”；已有结果均已保留。`,
        'error'
      )
    } else {
      get()._post(
        'assistant',
        `✅ 6模块分析已完成：成功 ${doneCount} 个、暂无分析 ${skippedCount} 个。可直接检查并导出。`,
        'checkpoint'
      )
    }
    return

  },

  _rerunReport: async (latestFeedback) => {
    const sessionId = get().analysisSessionId
    const isCurrentSession = (): boolean => get().analysisSessionId === sessionId
    const { cleanedData, steering, artifacts } = get()
    const steeringAtStart = steering
    const reportFeedback = latestFeedback?.trim() || steering
    const previousReport = get().reportMarkdown
    const selectedParts = previousReport.trim() ? selectRevisionParts(reportFeedback) : FINAL_REPORT_PARTS
    const partialRevision = selectedParts.length < FINAL_REPORT_PARTS.length
    const revisionRunId = crypto.randomUUID()
    set({ phase: 'analyzing' })
    if (partialRevision) {
      get()._post(
        'assistant',
        `本次只重写：${selectedParts.map((part) => part.label).join('、')}；其他章节保持不变。`,
        'narration'
      )
    }
    const priorOutputs = SOP_STEPS.filter((s) => s.id < REPORT_STEP_ID && artifacts[s.id]).map((s) => ({
      id: s.id,
      title: `第${s.id}步 ${s.title}`,
      output: compactForFinalReport(artifacts[s.id])
    }))
    const res = await runFinalReportInParts({
      cleanedData: cleanedSummaryOnly(cleanedData),
      priorOutputs,
      feedback: reportFeedback,
      setAbort: (fn) => {
        if (isCurrentSession()) set({ abortFn: fn })
      },
      onProgress: (text) => {
        if (isCurrentSession() && !partialRevision) set({ reportMarkdown: text })
      },
      onRetry: (partLabel, n) => {
        if (isCurrentSession()) get()._post('assistant', `修订成稿「${partLabel}」连接中断，重试第 ${n} 次…`, 'narration')
      },
      taskContext: {
        reportSessionId: sessionId,
        taskType: 'revision_part',
        taskKeyPrefix: `${sessionId}:revision:${revisionRunId}`,
        sourceCount: get().sources.length,
        imageCount: sourceImageCount(get().sources)
      },
      parts: selectedParts
    })
    if (!isCurrentSession()) return
    if (!res.ok) {
      get()._post(
        'assistant',
        isUserStop(res.error) ? '已停止修订，上一份完整报告仍然保留。' : `⚠️ 修订中断：${res.error}`,
        isUserStop(res.error) ? 'narration' : 'error'
      )
      set({ phase: previousReport ? 'checkpoint2' : 'checkpoint1', reportMarkdown: previousReport })
      return
    }
    if (get().steering !== steeringAtStart) {
      set({ reportMarkdown: previousReport })
      get()._post('assistant', '检测到修订期间又有新要求，正在继续按最新要求修订。', 'narration')
      await get()._rerunReport()
      return
    }
    const nextReport = partialRevision
      ? mergeRevisionParts(previousReport, res.text, selectedParts)
      : res.text
    if (!nextReport) {
      get()._post('assistant', '局部修订返回的章节不完整，已保留上一份完整报告，请重试。', 'error')
      set({ phase: previousReport ? 'checkpoint2' : 'checkpoint1', reportMarkdown: previousReport })
      return
    }
    const structureErrors = validateReportStructure(nextReport)
    if (structureErrors.length) {
      get()._post(
        'assistant',
        `修订结果结构不完整，已保留上一份完整报告：\n${structureErrors.slice(0, 4).map((item) => `- ${item}`).join('\n')}`,
        'error'
      )
      set({ phase: previousReport ? 'checkpoint2' : 'checkpoint1', reportMarkdown: previousReport })
      return
    }
    const evidenceAudit = validateReportEvidenceLinks(nextReport, cleanedData)
    if (evidenceAudit.errors.length) {
      get()._post('assistant', evidenceAudit.errors.join('\n'), 'error')
      set({ phase: previousReport ? 'checkpoint2' : 'checkpoint1', reportMarkdown: previousReport })
      return
    }
    set((s) => ({
      artifacts: { ...s.artifacts, [REPORT_STEP_ID]: nextReport },
      reportMarkdown: nextReport,
      reportStale: false,
      phase: 'checkpoint2'
    }))
    try {
      await storeCompleteReportResult(get())
    } catch {
      // 修订结果已保存到项目；复用缓存失败不影响本次报告。
    }
    try {
      const charge = await window.api.getReportPointsCharge(sessionId)
      const wallet = await window.api.getPointsWallet()
      if (!isCurrentSession()) return
      get()._post(
        'assistant',
        `✅ 已完成修订，本次会话累计消耗 ${formatPointsValue(charge.chargedPoints)} 积分，剩余 ${formatPointsValue(wallet.balancePoints)} 积分。还要改可以继续说。`,
        'checkpoint'
      )
    } catch {
      if (!isCurrentSession()) return
      get()._post('assistant', '✅ 已按你的要求修订报告。还要改继续说，或点「确认定稿」。剩余积分可在页面顶部查看。', 'checkpoint')
    }
  },

  retryModule: async (key, instruction) => {
    if (get().readOnly) {
      get()._post('assistant', get().legacyNotice || '旧报告仅支持查看导出。', 'error')
      return
    }
    const affected = retryScopeForModules(REPORT_MODULES, get().moduleStates, key)
    const affectedIds = new Set(REPORT_MODULES.filter((module) => affected.has(module.key)).map((module) => module.id))
    set((state) => ({
      artifacts: Object.fromEntries(Object.entries(state.artifacts).filter(([id]) => !affectedIds.has(Number(id)) && Number(id) !== REPORT_STEP_ID)),
      taskJournal: Object.fromEntries(Object.entries(state.taskJournal).filter(([taskId]) =>
        ![...affected].some((moduleKey) => taskId.includes(`:module:v2:${moduleKey}`))
      )),
      moduleStates: Object.fromEntries(Object.entries(state.moduleStates).filter(([moduleKey]) => !affected.has(moduleKey as ModuleKey))),
      reportMarkdown: '',
      reportStale: false,
      phase: 'checkpoint1',
      moduleRetryInstructions: instruction ? { ...state.moduleRetryInstructions, [key]: instruction } : state.moduleRetryInstructions,
      moduleRetryScope: [...affected]
    }))
    get()._post('assistant', `正在重试 ${[...affected].map((moduleKey) => moduleByTitle(moduleKey)).join('、')}。已完成且不受影响的模块会直接复用。`, 'narration')
    try {
      await get()._runAnalysis()
    } finally {
      set((state) => ({
        moduleRetryInstructions: Object.fromEntries(
          Object.entries(state.moduleRetryInstructions).filter(([moduleKey]) => moduleKey !== key)
        ),
        moduleRetryScope: []
      }))
    }
  },

  confirmCheckpoint: async () => {
    const phase = get().phase
    if (phase === 'checkpoint1') {
      if (!get().cleanedData.trim()) {
        set({ phase: 'idle' })
        get()._post('assistant', '资料发生过变化，需要重新点「开始生成报告」完成清洗后再继续。', 'error')
        return
      }
      await get()._runAnalysis()
    }
    else if (phase === 'checkpoint2') {
      if (
        !get().reportMarkdown.trim() ||
        get().reportMarkdown !== get().artifacts[REPORT_STEP_ID]
      ) {
        set({ phase: 'checkpoint1' })
        get()._post('assistant', '报告内容不完整，请重新继续分析后再定稿。', 'error')
        return
      }
      const structureErrors = validateReportStructure(get().reportMarkdown)
      if (structureErrors.length) {
        get()._post(
          'assistant',
          `报告仍有结构问题，暂不能定稿：\n${structureErrors.slice(0, 4).map((item) => `- ${item}`).join('\n')}`,
          'error'
        )
        return
      }
      set({ phase: 'done' })
      get()._post('assistant', '✅ 报告已定稿，可在右侧导出 HTML / Markdown / Word。', 'narration')
    }
  },

  sendMessage: async (text) => {
    const t = text.trim()
    if (!t) return false
    const phase = get().phase
    get()._post('user', t)

    try {
      if (phase === 'cleaning' || phase === 'analyzing') {
        set((s) => ({ steering: (s.steering ? s.steering + '\n' : '') + t }))
        get()._post('assistant', '收到，我会在后续步骤里按这个调整。', 'narration')
        return true
      }
      if (phase === 'checkpoint1') {
        const match = /(?:模块\s*)?M?([1-6])/iu.exec(t)
        const module = match ? REPORT_MODULES.find((candidate) => candidate.id === Number(match[1])) : undefined
        if (/重试|重新分析|重做/u.test(t) && module && get().cleanDetails.length > 0) {
          await get().retryModule(module.key, t)
          return true
        }
        set((s) => ({ steering: (s.steering ? s.steering + '\n' : '') + t }))
        get()._post('assistant', '已记录为6模块分析的补充要求。确认资料后会自动应用。', 'narration')
        return true
      }
      if (phase === 'checkpoint2' || phase === 'done') {
        const match = /(?:模块\s*)?M?([1-6])/iu.exec(t)
        const module = match ? REPORT_MODULES.find((candidate) => candidate.id === Number(match[1])) : undefined
        if (!module) {
          get()._post('assistant', '新版按模块生成报告。请说明要重做的模块编号，例如“重试 M6，并重点看购买顾虑”。', 'narration')
          return true
        }
        await get().retryModule(module.key, t)
        return true
      }
      set((s) => ({ steering: (s.steering ? s.steering + '\n' : '') + t }))
      get()._post('assistant', '已保存为本次分析目标。上传资料后点「开始生成报告」即可。', 'narration')
      return true
    } catch (error) {
      set({
        abortFn: null,
        phase:
          phase === 'done'
            ? 'done'
            : phase === 'checkpoint2'
              ? 'checkpoint2'
            : phase === 'checkpoint1'
              ? 'checkpoint1'
              : get().cleanedData
                ? 'checkpoint1'
                : 'idle'
      })
      get()._post('assistant', `操作没有完成：${friendlyError(error)}`, 'error')
      return false
    }
  },

  abort: () => {
    get().abortFn?.()
  },

  exportReport: async (format) => {
    const { reportMarkdown: md, cleanDetails, phase, artifacts, reportStale, exportStatus } = get()
    if (exportStatus === '导出中…') return
    if (phase === 'cleaning' || phase === 'analyzing') {
      set({ exportStatus: '报告仍在生成，请完成后再导出。' })
      return
    }
    if (!artifacts[REPORT_STEP_ID] || md !== artifacts[REPORT_STEP_ID]) {
      set({ exportStatus: '当前预览尚未完成提交，请继续生成后再导出。' })
      return
    }
    if (!md.trim()) {
      set({ exportStatus: '还没有报告可导出。' })
      return
    }
    if (phase !== 'done' && !reportStale) {
      set({ exportStatus: '这还是待确认的初稿，请先点击“确认定稿”再导出。' })
      return
    }
    const structuralWarnings = validateReportStructure(md)
    if (structuralWarnings.length > 0) {
      set({ exportStatus: `成稿检查还有 ${structuralWarnings.length} 项，请先修正后再导出。` })
      return
    }
    set({ exportStatus: '导出中…', lastExportPath: '' })
    const name = defaultReportName(format)
    const displayMarkdown = reportMarkdownForDisplay(md, buildEvidenceSourceNameMap(cleanDetails))
    try {
      const res =
        format === 'html'
          ? await window.api.exportHtml(displayMarkdown, name)
          : format === 'md'
            ? await window.api.exportMarkdown(displayMarkdown, name)
            : await window.api.exportDocx(displayMarkdown, name)
      if (res.ok) set({ exportStatus: `已导出：${res.path}`, lastExportPath: res.path || '' })
      else if (res.canceled) set({ exportStatus: '', lastExportPath: '' })
      else set({ exportStatus: `导出失败：${friendlyError(res.error)}`, lastExportPath: '' })
    } catch (error) {
      set({ exportStatus: `导出失败：${friendlyError(error)}`, lastExportPath: '' })
    }
  },

  openLastExport: async () => {
    const { lastExportPath: path, openingExport } = get()
    if (!path || openingExport) return
    set({ openingExport: true })
    try {
      await window.api.openPath(path)
    } catch (error) {
      set({ exportStatus: `打开失败：${friendlyError(error)}`, lastExportPath: '' })
    } finally {
      set({ openingExport: false })
    }
  },

  showLastExportInFolder: async () => {
    const { lastExportPath: path, openingExport } = get()
    if (!path || openingExport) return
    set({ openingExport: true })
    try {
      await window.api.showItemInFolder(path)
    } catch (error) {
      set({ exportStatus: `打开文件夹失败：${friendlyError(error)}`, lastExportPath: '' })
    } finally {
      set({ openingExport: false })
    }
  }
}))
