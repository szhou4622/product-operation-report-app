import { create } from 'zustand'
import type {
  AppSettings,
  ChatMessage,
  CostOptimizationEvent,
  ModelTaskContext,
  ProjectPhase,
  ReportResultCacheInput,
  ReportResultCacheLookupResult,
  ReportResultCacheSnapshot,
  SavedProject,
  SourceCleanCacheInput,
  StepDependencyMap
} from '../../shared/types'
import { SOP_STEPS } from '../../shared/types'
import { FINAL_REPORT_PARTS } from './reportTemplate'
import { buildExtractMessages, buildFinalReportPartMessages, buildStepMessages, buildSummaryMessages, type PriorOutput } from './sop'
import { buildLocalTableCleanDetail, preprocessTableForModel, sourceForModel } from './tablePreprocess'

export interface Source {
  id: string
  name: string
  kind: 'image' | 'doc' | 'table' | 'other'
  dataUrl?: string
  text?: string
  size?: number
  parsing?: boolean
  error?: string
  warning?: string
  attribution?: string // 用户指定归属：自有数据 / 竞品数据 / ''(未定)
  platform?: string // 用户指定平台/来源：巨量云图 / 抖店罗盘 / 视频号 / 抖音 / 有米云...
  purpose?: string // 用户指定信息类型：人群画像数据 / 内容素材数据 / 交易数据 / 产品手卡...
  note?: string // 用户对这份文件的补充信息（平台/时间/内容/文件外说明）
}

const PARSE_CONCURRENCY = 1
export const MAX_CLEANING_CONCURRENCY = 4
const REPORT_STEP_ID = SOP_STEPS[SOP_STEPS.length - 1]?.id ?? 9
const CLEAN_DETAIL_MARKER = '\n\n---\n## 各来源清洗明细'
const FINAL_PRIOR_OUTPUT_LIMIT = 7000
const MAX_SINGLE_FILE_BYTES = 40 * 1024 * 1024
const MAX_TOTAL_UPLOAD_BYTES = 350 * 1024 * 1024
const MAX_IMAGE_FILE_BYTES = 25 * 1024 * 1024
const MAX_SOURCE_FILES = 200

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
}

const emptyCleaningProgress = (): CleaningProgress => ({ total: 0, done: 0, running: [], failed: 0 })
const isRunningPhase = (phase: Phase): boolean => phase === 'cleaning' || phase === 'analyzing'

function toSourceCleanCacheInput(source: Source): SourceCleanCacheInput {
  return {
    name: source.name,
    kind: source.kind,
    text: source.text,
    dataUrl: source.dataUrl,
    attribution: source.attribution,
    platform: source.platform,
    purpose: source.purpose,
    note: source.note
  }
}

function reportResultCacheInput(sources: Source[], userRequirements: string): ReportResultCacheInput {
  return {
    sources: sources.filter((source) => source.dataUrl || source.text).map(toSourceCleanCacheInput),
    userRequirements
  }
}

function hasCompleteReportSections(markdown: string): boolean {
  return Array.from({ length: 12 }, (_, section) =>
    new RegExp(`^##\\s+${section}(?:\\.|、|\\s)`, 'mu').test(markdown)
  ).every(Boolean)
}

function validReportCacheSnapshot(snapshot: ReportResultCacheSnapshot | undefined): snapshot is ReportResultCacheSnapshot {
  if (!snapshot?.cleanedData.trim() || !snapshot.reportMarkdown.trim()) return false
  if (!hasCompleteReportSections(snapshot.reportMarkdown)) return false
  return Array.from({ length: REPORT_STEP_ID }, (_, index) => index + 1).every((id) => snapshot.artifacts[id]?.trim())
}

function snapshotForReportCache(state: StoreState): ReportResultCacheSnapshot | null {
  if (!hasCompleteReportSections(state.reportMarkdown)) return null
  if (!Array.from({ length: REPORT_STEP_ID }, (_, index) => index + 1).every((id) => state.artifacts[id]?.trim())) return null
  const detailsById = new Map(state.cleanDetails.map((detail) => [detail.id, detail]))
  const cleanDetails = state.sources.flatMap((source) => {
    const detail = detailsById.get(source.id)
    return detail ? [{ name: source.name, text: detail.text }] : []
  })
  if (cleanDetails.length !== state.sources.filter((source) => source.dataUrl || source.text).length) return null
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

export function friendlyError(value: unknown): string {
  const raw = (value instanceof Error ? value.message : String(value || '')).replace(/\s+/g, ' ').trim()
  if (!raw) return '操作没有完成，请重试。'
  if (/已停止|aborted|aborterror/i.test(raw)) return '已停止。'
  if (/enospc|no space left|磁盘空间不足|磁盘已满/i.test(raw)) {
    return '磁盘空间不足，无法保存文件。请清理空间或改存到其他磁盘后重试。'
  }
  if (/ebusy|resource busy|being used|另一个程序正在使用|文件.*占用/i.test(raw)) {
    return '文件正在被其他程序占用。请关闭同名的 Word 或浏览器文件后重试。'
  }
  if (/eperm|eacces|permission denied|access denied|operation not permitted|拒绝访问/i.test(raw)) {
    return '文件可能正在被占用，或保存位置没有权限。请关闭同名文件，或改存到桌面后重试。'
  }
  if (/enoent|path not found|找不到.*路径/i.test(raw)) {
    return '保存位置已不存在。请重新选择桌面或其他文件夹后重试。'
  }
  if (/enametoolong|filename.*too long|path.*too long|文件名.*过长|路径.*过长/i.test(raw)) {
    return '文件名或保存路径太长。请缩短文件名，或直接保存到桌面。'
  }
  if (/timeout|timed out|超时/i.test(raw)) return '请求超时，请检查网络后重试。'
  if (/401|unauthorized|invalid api key|authentication/i.test(raw)) return '模型服务授权失败，请联系软件管理员。'
  if (/404|model.*not found|not found.*model/i.test(raw)) return '模型地址或模型名称不正确，请到设置中检查。'
  if (/429|rate limit|quota|insufficient_quota/i.test(raw)) {
    const wait = raw.match(/等待\s*(\d+)\s*秒/)
    return wait
      ? `模型服务繁忙或额度受限，建议等待 ${wait[1]} 秒后重试。`
      : '模型服务繁忙或额度受限，请稍后重试。'
  }
  if (/fetch failed|econnreset|enotfound|terminated|network/i.test(raw)) {
    return '网络连接失败，请检查网络和模型地址后重试。'
  }
  return raw.slice(0, 280)
}

const isUserStop = (value: unknown): boolean => /已停止|aborted/i.test(String(value || ''))

function restorePhase(project: SavedProject): Phase {
  if (project.phase === 'cleaning') return 'idle'
  if (project.phase === 'analyzing') return project.cleanedData ? 'checkpoint1' : 'idle'
  return project.phase as Phase
}

export function buildProjectSnapshot(state: {
  projectRevision: number
  sources: Source[]
  messages: ChatMsg[]
  cleanedData: string
  cleanDetails: { id: string; name: string; text: string }[]
  artifacts: Record<number, string>
  reportMarkdown: string
  reportStale: boolean
  phase: Phase
  steering: string
}): SavedProject {
  return {
    revision: state.projectRevision,
    sources: state.sources.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      text: s.text,
      dataUrl: s.dataUrl,
      error: s.error,
      warning: s.warning,
      attribution: s.attribution,
      platform: s.platform,
      purpose: s.purpose,
      note: s.note,
      size: s.size
    })),
    messages: state.messages.map((m) => ({
      id: m.id,
      role: m.role,
      text: m.text,
      kind: m.kind
    })),
    cleanedData: state.cleanedData,
    cleanDetails: state.cleanDetails,
    artifacts: state.artifacts,
    reportMarkdown: isRunningPhase(state.phase)
      ? state.artifacts[REPORT_STEP_ID] || ''
      : state.reportMarkdown,
    reportStale: state.reportStale,
    phase: state.phase as ProjectPhase,
    steering: state.steering,
    updatedAt: new Date().toISOString()
  }
}

function classify(name: string): Source['kind'] {
  const ext = name.toLowerCase().split('.').pop() || ''
  if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) return 'image'
  if (['xlsx', 'xls', 'csv'].includes(ext)) return 'table'
  if (['pdf', 'docx', 'doc', 'pptx', 'ppt', 'md', 'markdown', 'txt'].includes(ext)) return 'doc'
  return 'other'
}

const SUPPORTED_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'webp', 'gif',
  'xlsx', 'xls', 'csv',
  'pdf', 'docx', 'doc', 'pptx', 'ppt', 'md', 'markdown', 'txt',
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

const inferPlatform = (name: string): string => {
  const n = name.toLowerCase()
  if (n.includes('视频号') || n.includes('wechat') || n.includes('weixin')) return '视频号'
  if (n.includes('抖音') || n.includes('douyin')) return '抖音'
  if (n.includes('云图')) return '巨量云图'
  if (n.includes('罗盘')) return '抖店罗盘'
  if (n.includes('有米')) return '有米云'
  if (n.includes('蝉妈妈') || n.includes('查妈妈')) return '蝉妈妈'
  if (n.includes('淘宝')) return '淘宝'
  if (n.includes('天猫')) return '天猫'
  if (n.includes('小红书') || n.includes('xiaohongshu')) return '小红书'
  if (n.includes('飞书') || n.includes('base')) return '飞书Base'
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

const toSourceLike = (
  s: Source
): {
  name: string
  kind: string
  text?: string
  dataUrl?: string
  attribution?: string
  platform?: string
  purpose?: string
  note?: string
} => ({
  name: s.name,
  kind: s.kind,
  text: s.text,
  dataUrl: s.dataUrl,
  attribution: s.attribution,
  platform: s.platform,
  purpose: s.purpose,
  note: s.note
})

function cleanedSummaryOnly(cleanedData: string): string {
  const index = cleanedData.indexOf(CLEAN_DETAIL_MARKER)
  return index >= 0 ? cleanedData.slice(0, index).trim() : cleanedData
}

function compactForFinalReport(text: string, limit = FINAL_PRIOR_OUTPUT_LIMIT): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n\n（以上为该步骤关键产出节选；最终成稿只保留经营决策需要的信息，不要复述过程。）`
}

async function runFinalReportInParts(params: {
  cleanedData: string
  priorOutputs: PriorOutput[]
  feedback: string
  setAbort: (fn: (() => void) | null) => void
  onProgress: (text: string) => void
  onRetry: (partLabel: string, n: number) => void
  taskContext: {
    reportSessionId: string
    taskType: 'final_part' | 'revision_part'
    taskKeyPrefix: string
    sourceCount: number
    imageCount: number
  }
  parts?: typeof FINAL_REPORT_PARTS
}): Promise<{ ok: boolean; text: string; error?: string }> {
  let full = ''
  for (const part of params.parts || FINAL_REPORT_PARTS) {
    const messages = buildFinalReportPartMessages({
      part,
      cleanedData: params.cleanedData,
      priorOutputs: params.priorOutputs,
      feedback: params.feedback
    })
    let current = ''
    const res = await runModelRetry(
      messages,
      (acc) => {
        current = acc
        params.onProgress(`${full}${acc}`)
      },
      params.setAbort,
      (n) => params.onRetry(part.label, n),
      2,
      {
        reportSessionId: params.taskContext.reportSessionId,
        taskType: params.taskContext.taskType,
        taskKey: `${params.taskContext.taskKeyPrefix}:${part.id}`,
        isVision: false,
        sourceCount: params.taskContext.sourceCount,
        imageCount: params.taskContext.imageCount,
        partId: part.id
      }
    )
    if (!res.ok) return { ok: false, text: full + current, error: res.error }
    full = `${full}${res.text.trim()}\n\n`
    params.onProgress(full)
  }
  return { ok: true, text: full.trim() }
}

const REVISION_PART_KEYWORDS: Record<(typeof FINAL_REPORT_PARTS)[number]['id'], RegExp> = {
  'part-0-4': /结论|数据来源|产品基础|一方数据|竞品|素材打法/u,
  'part-5-8': /卖点|人群|场景|内容主线/u,
  'part-9': /脚本|选题|3\s*秒|执行方向|视频分类|创作视角/u,
  'part-10-11': /经营建议|行动建议|限制|风险|近期|中期|验证项/u
}

function partForSection(section: number): (typeof FINAL_REPORT_PARTS)[number] | undefined {
  return FINAL_REPORT_PARTS.find((part) => part.sections.includes(String(section)))
}

export function selectRevisionParts(feedback: string): typeof FINAL_REPORT_PARTS {
  const selected = new Set<string>()
  for (const match of feedback.matchAll(/(?:第\s*)?(10|11|[0-9])\s*[-—至到]\s*(10|11|[0-9])\s*章/gu)) {
    const start = Number(match[1])
    const end = Number(match[2])
    for (let section = Math.min(start, end); section <= Math.max(start, end); section++) {
      const part = partForSection(section)
      if (part) selected.add(part.id)
    }
  }
  for (const match of feedback.matchAll(/(?:第\s*)?(10|11|[0-9])\s*章/gu)) {
    const part = partForSection(Number(match[1]))
    if (part) selected.add(part.id)
  }
  if (!selected.size) {
    for (const part of FINAL_REPORT_PARTS) {
      if (REVISION_PART_KEYWORDS[part.id].test(feedback)) selected.add(part.id)
    }
  }
  return selected.size
    ? (FINAL_REPORT_PARTS.filter((part) => selected.has(part.id)) as typeof FINAL_REPORT_PARTS)
    : FINAL_REPORT_PARTS
}

function sectionHeadingStart(markdown: string, section: string): number {
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const match = new RegExp(`^##\\s*${escaped}(?:[.、：:\\s]|$)`, 'mu').exec(markdown)
  return match?.index ?? -1
}

function partBounds(
  markdown: string,
  part: (typeof FINAL_REPORT_PARTS)[number]
): { start: number; end: number; text: string } | null {
  for (const section of part.sections) {
    if (sectionHeadingStart(markdown, section) < 0) return null
  }
  const start = part.id === 'part-0-4' ? 0 : sectionHeadingStart(markdown, part.sections[0])
  if (start < 0) return null
  const laterBoundaries = part.id === 'part-0-4'
    ? ['5', '9', '10']
    : part.id === 'part-5-8'
      ? ['9', '10']
      : part.id === 'part-9'
        ? ['10']
        : []
  const ends = laterBoundaries.map((section) => sectionHeadingStart(markdown, section)).filter((index) => index > start)
  const end = ends.length ? Math.min(...ends) : markdown.length
  return { start, end, text: markdown.slice(start, end).trim() }
}

function extractedPart(markdown: string, part: (typeof FINAL_REPORT_PARTS)[number]): string | null {
  return partBounds(markdown, part)?.text ?? null
}

export function mergeRevisionParts(
  previousReport: string,
  generatedParts: string,
  selectedParts: typeof FINAL_REPORT_PARTS
): string | null {
  let merged = previousReport
  const replacements = selectedParts.map((part) => ({
    part,
    previous: partBounds(previousReport, part),
    replacement: extractedPart(generatedParts, part)
  }))
  if (replacements.some((item) => !item.previous || !item.replacement)) return null
  const positions = replacements.map((item) => {
    const previous = item.previous!
    return { ...item, start: previous.start, end: previous.end }
  }).sort((a, b) => b.start - a.start)
  for (const item of positions) {
    const before = merged.slice(0, item.start)
    const after = merged.slice(item.end)
    const separator = after && !item.replacement!.endsWith('\n\n') ? '\n\n' : ''
    merged = `${before}${item.replacement!.trim()}${separator}${after}`
  }
  return merged.trim()
}

// 包装流式调用为 Promise，并暴露中止函数
function runModel(
  messages: ChatMessage[],
  onAcc: (acc: string) => void,
  setAbort: (fn: (() => void) | null) => void,
  context: ModelTaskContext
): Promise<{ ok: boolean; text: string; error?: string }> {
  return new Promise((resolve) => {
    let acc = ''
    let settled = false
    let publishTimer: number | null = null
    let lastPublished = ''
    const publish = (text: string): void => {
      if (text === lastPublished) return
      lastPublished = text
      onAcc(text)
    }
    const flush = (text = acc): void => {
      if (publishTimer !== null) {
        window.clearTimeout(publishTimer)
        publishTimer = null
      }
      publish(text)
    }
    const done = (r: { ok: boolean; text: string; error?: string }): void => {
      if (settled) return
      settled = true
      flush(r.text)
      setAbort(null)
      resolve(r)
    }
    try {
      const handle = window.api.sendChat(messages, context, {
        onChunk: (d) => {
          acc += d
          if (publishTimer === null) {
            publishTimer = window.setTimeout(() => {
              publishTimer = null
              publish(acc)
            }, 60)
          }
        },
        onDone: (full) => done({ ok: true, text: full || acc }),
        onError: (msg) => done({ ok: false, text: acc, error: friendlyError(msg) })
      })
      setAbort(() => {
        handle.abort()
        done({ ok: false, text: acc, error: '已停止' })
      })
    } catch (error) {
      done({ ok: false, text: acc, error: friendlyError(error) })
    }
  })
}

// 带重试的调用：仅在"网络中断且尚无任何输出"时重试，避免重复内容；用户主动停止不重试
async function runModelRetry(
  messages: ChatMessage[],
  onAcc: (acc: string) => void,
  setAbort: (fn: (() => void) | null) => void,
  onRetry?: (n: number) => void,
  retries = 2,
  taskContext?: Omit<ModelTaskContext, 'attempt'>
): Promise<{ ok: boolean; text: string; error?: string }> {
  if (!taskContext) throw new Error('模型任务缺少必要标识。')
  let res = await runModel(messages, onAcc, setAbort, { ...taskContext, attempt: 1 })
  let n = 0
  while (
    !res.ok &&
    n < retries &&
    !res.text &&
    /fetch failed|ECONNRESET|terminated|network|网络连接失败|服务繁忙|额度受限|429/i.test(res.error || '')
  ) {
    n++
    onRetry?.(n)
    if (/服务繁忙|额度受限|429/i.test(res.error || '')) {
      const wait = res.error?.match(/等待\s*(\d+)\s*秒/)
      const delay = wait ? Math.min(60, Number(wait[1])) * 1000 : 1200 * n
      let stopped = false
      await new Promise<void>((resolve) => {
        const timer = window.setTimeout(resolve, delay)
        setAbort(() => {
          stopped = true
          window.clearTimeout(timer)
          resolve()
        })
      })
      setAbort(null)
      if (stopped) return { ok: false, text: '', error: '已停止' }
    }
    res = await runModel(messages, onAcc, setAbort, { ...taskContext, attempt: n + 1 })
  }
  return res
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
  cleanDetails: { id: string; name: string; text: string }[]
  artifacts: Record<number, string>
  reportMarkdown: string
  reportStale: boolean
  abortFn: (() => void) | null
  steering: string
  exportStatus: string
  lastExportPath: string
  openingExport: boolean
  cleaningProgress: CleaningProgress

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
  setSourceNote: (id: string, note: string) => void
  startGeneration: () => Promise<void>
  acceptReportReuse: () => Promise<void>
  regenerateReport: () => Promise<void>
  confirmCheckpoint: () => Promise<void>
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
  'cleanedData' | 'phase' | 'abortFn' | 'exportStatus' | 'cleaningProgress' | 'reportReuseOffer'
> => ({
  cleanedData: '',
  phase: 'idle',
  abortFn: null,
  exportStatus: '',
  cleaningProgress: emptyCleaningProgress(),
  reportReuseOffer: null
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
  reportMarkdown: '',
  reportStale: false,
  abortFn: null,
  steering: '',
  exportStatus: '',
  lastExportPath: '',
  openingExport: false,
  cleaningProgress: emptyCleaningProgress(),

  init: async () => {
    const [settings, sopRules, lastProject, previousProject] = await Promise.all([
      window.api.getSettings(),
      window.api.getSopRules(),
      window.api.loadLastProject(),
      window.api.loadPreviousProject()
    ])
    const restoredReport =
      lastProject?.phase === 'analyzing'
        ? lastProject.artifacts?.[REPORT_STEP_ID] || ''
        : lastProject?.reportMarkdown || ''
    const restoredArtifacts = { ...(lastProject?.artifacts || {}) }
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
    set({
      initialized: true,
      persistencePaused: false,
      projectRevision: lastProject?.revision || 0,
      analysisSessionId: crypto.randomUUID(),
      previousProjectAvailable: Boolean(previousProject),
      settings,
      sopRules,
      settingsOpen: settings.managedModel?.enabled ? !settings.managedModel.configured : !settings.profiles.length,
      reportReuseOffer: null,
      sources: lastProject
        ? lastProject.sources.map((source) => ({
            ...source,
            parsing: false,
            error:
              source.error || source.text || source.dataUrl
                ? source.error
                : '上次文件解析未完成，请删除后重新上传。'
          }))
        : [],
      messages: restoredMessages,
      cleanedData: lastProject?.cleanedData || '',
      cleanDetails: Array.isArray(lastProject?.cleanDetails) ? lastProject.cleanDetails : [],
      artifacts: restoredArtifacts,
      reportMarkdown: restoredReport,
      reportStale: Boolean(lastProject?.reportStale),
      phase: lastProject ? restorePhase(lastProject) : 'idle',
      steering: lastProject?.steering || '',
      abortFn: null,
      exportStatus: '',
      lastExportPath: '',
      openingExport: false,
      cleaningProgress: emptyCleaningProgress()
    })
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
      reportMarkdown: current.reportMarkdown,
      reportStale: current.reportStale,
      phase: current.phase,
      abortFn: current.abortFn,
      steering: current.steering,
      exportStatus: current.exportStatus,
      lastExportPath: current.lastExportPath,
      openingExport: false,
      cleaningProgress: current.cleaningProgress,
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
      reportMarkdown: '',
      reportStale: false,
      phase: 'idle' as Phase,
      abortFn: null,
      steering: '',
      exportStatus: '',
      lastExportPath: '',
      openingExport: false,
      cleaningProgress: emptyCleaningProgress(),
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

    const restoredReport =
      previous.phase === 'analyzing'
        ? previous.artifacts?.[REPORT_STEP_ID] || ''
        : previous.reportMarkdown || ''
    const restoredArtifacts = { ...(previous.artifacts || {}) }
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

    const restoredState = {
      sources: previous.sources.map((source) => ({
        ...source,
        parsing: false,
        error:
          source.error || source.text || source.dataUrl
            ? source.error
            : '上次文件解析未完成，请删除后重新上传。'
      })),
      messages: restoredMessages,
      cleanedData: previous.cleanedData || '',
      cleanDetails: Array.isArray(previous.cleanDetails) ? previous.cleanDetails : [],
      artifacts: restoredArtifacts,
      reportMarkdown: restoredReport,
      reportStale: Boolean(previous.reportStale),
      phase: restorePhase(previous),
      steering: previous.steering || '',
      abortFn: null,
      exportStatus: '',
      lastExportPath: '',
      openingExport: false,
      cleaningProgress: emptyCleaningProgress(),
      projectRevision: current.projectRevision + 1,
      analysisSessionId: crypto.randomUUID(),
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
    }> = []
    const rejected: Source[] = []
    const incomingFiles = Array.from(files)
    const availableSlots = Math.max(0, MAX_SOURCE_FILES - get().sources.length)
    if (incomingFiles.length > availableSlots) {
      get()._post(
        'assistant',
        `一次分析最多保留 ${MAX_SOURCE_FILES} 个文件，本次有 ${incomingFiles.length - availableSlots} 个文件未加入。请先完成这一份，再新建分析处理其余文件。`,
        'error'
      )
    }
    let acceptedBytes = get().sources.reduce(
      (sum, source) => sum + (source.parsing || source.dataUrl || source.text ? source.size || 0 : 0),
      0
    )

    for (const file of incomingFiles.slice(0, availableSlots)) {
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
        platform: inferPlatform(name),
        purpose: inferPurpose(name)
      }
      const reject = (error: string): void => {
        rejected.push({ ...base, error })
      }
      if (!SUPPORTED_EXTS.has(e)) {
        reject(`已忽略：暂不支持 .${e || '未知'} 文件。支持截图、CSV/XLSX、PDF、Word/PPTX、Markdown/TXT、ZIP。`)
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
      acceptedBytes += file.size
      acceptedJobs.push({
        id: base.id,
        file,
        name,
        ext: e,
        kind: e === 'zip' ? ('other' as Source['kind']) : classify(file.name),
        attribution: base.attribution,
        platform: base.platform,
        purpose: base.purpose
      })
    }

    const jobs = acceptedJobs

    if (!jobs.length && rejected.length) {
      set((s) =>
        s.analysisSessionId === sessionId && !isRunningPhase(s.phase)
          ? { sources: [...s.sources, ...rejected] }
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
          ...rejected,
          ...jobs.map((job) => ({
            id: job.id,
            name: job.name,
            kind: job.kind,
            size: job.file.size,
            parsing: true,
            attribution: job.attribution,
            platform: job.platform,
            purpose: job.purpose
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
            const items = [...archiveItems]
            let imageIndex = 0
            const processArchiveImages = async (): Promise<void> => {
              while (imageIndex < archiveItems.length) {
                const index = imageIndex++
                const item = archiveItems[index]
                if (!item.ok || item.kind !== 'image' || !item.dataUrl) continue
                try {
                  const blob = await (await fetch(item.dataUrl)).blob()
                  const imageFile = new File([blob], item.name, { type: blob.type })
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
                (sum, source) => sum + (source.parsing || source.dataUrl || source.text ? source.size || 0 : 0),
                0
              )
              const availableSlots = Math.max(0, MAX_SOURCE_FILES - retainedSources.length)
              const overflowCount = Math.max(0, items.length - availableSlots)
              const itemSlots = overflowCount ? Math.max(0, availableSlots - 1) : availableSlots
              const retainedItems = items.slice(0, itemSlots)
              const expandedBytes = retainedItems.reduce((sum, item) => sum + (item.size || 0), 0)
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
                      error: `已忽略：压缩包解压后的资料会使总量超过 ${formatBytes(MAX_TOTAL_UPLOAD_BYTES)}，请分批分析。`,
                      attribution: job.attribution,
                      platform: job.platform,
                      purpose: job.purpose
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
                    platform: inferPlatform(`${job.name}/${it.name}`),
                    purpose: inferPurpose(`${job.name}/${it.name}`),
                    note: `来自压缩包：${job.name}`
                  })),
                  ...(overflowCount && availableSlots
                    ? [
                        {
                          id: crypto.randomUUID(),
                          name: `${job.name}：数量提示`,
                          kind: 'other' as const,
                          parsing: false,
                          error: `已忽略：压缩包展开后会超过 ${MAX_SOURCE_FILES} 份资料，本包有 ${overflowCount} 个条目未加入。请新建另一份分析处理。`
                        }
                      ]
                    : [])
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
          set((s) =>
            s.analysisSessionId === sessionId
              ? {
                  sources: s.sources.map((a) =>
                    a.id === job.id
                      ? {
                          ...a,
                          parsing: false,
                          text: parsed.ok ? parsed.text : undefined,
                          error: parsed.ok ? undefined : parsed.error,
                          warning: parsed.ok ? parsed.warning : undefined
                        }
                      : a
                  )
                }
              : s
          )
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
          .filter((source) => (source.dataUrl || source.text) && !source.attribution)
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
    const { sources, phase } = get()
    if (phase === 'cleaning' || phase === 'analyzing') return
    if (sources.some((s) => s.parsing)) {
      get()._post('assistant', '还有文件正在本地解析，请等解析完成后再开始生成。', 'narration')
      return
    }
    const unconfirmed = sources.filter((s) => (s.dataUrl || s.text) && !s.attribution)
    if (unconfirmed.length) {
      get()._post('assistant', `还有 ${unconfirmed.length} 份资料没有确认归属。请在文件下方点“自有数据”或“竞品数据”。`, 'narration')
      return
    }
    if (!sources.some((s) => s.dataUrl || s.text)) {
      get()._post('assistant', '还没有可用的资料。请先上传截图/表格/文档/zip/文件夹，再点「开始生成」。', 'narration')
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
    const usable = get().sources.filter((source) => source.dataUrl || source.text)
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
      phase: 'checkpoint2',
      abortFn: null,
      cleaningProgress: emptyCleaningProgress()
    })
    get()._post('assistant', '✅ 已恢复上次的完整报告。请核对后点击「确认定稿」。', 'checkpoint')
    void recordOptimizationEvent(
      optimizationEvent(`report-reuse:${sessionId}:${offer.cacheKey}`, sessionId, 'report_cache_reuse', {
        // 汇总 1 次 + 分析 8 次 + 四段成稿 4 次；文件清洗可能本来也会走本地缓存，因此不计入。
        skippedModelRequests: 13,
        reusedReports: 1
      })
    )
  },

  regenerateReport: async () => {
    set({ reportReuseOffer: null })
    await get()._startPaidGeneration()
  },

  _startPaidGeneration: async () => {
    const { settings, sources, phase } = get()
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

  // 分批清洗：并发抽取每个文件(最多4个) → 汇总(输入截断+失败重试)，避免大请求被中转掐断
  _runCleaning: async (isRerun) => {
    const sessionId = get().analysisSessionId
    const isCurrentSession = (): boolean => get().analysisSessionId === sessionId
    set({ phase: 'cleaning', cleanedData: '' })
    const usable = get().sources.filter((s) => s.dataUrl || s.text)
    const sourceCount = usable.length
    const imageCount = usable.filter((s) => s.kind === 'image').length
    const usableIds = new Set(usable.map((s) => s.id))
    // 丢掉已删除文件的旧明细；只抽取还没处理过的文件（支持中断续跑 / 补传后只洗新文件）
    set((st) => ({ cleanDetails: st.cleanDetails.filter((d) => usableIds.has(d.id)) }))
    const doneIds = new Set(get().cleanDetails.map((d) => d.id))
    const todo = usable.filter((s) => !doneIds.has(s.id))
    set({
      cleaningProgress: {
        total: todo.length,
        done: 0,
        running: [],
        failed: 0
      }
    })

    if (todo.length) {
      const conc = Math.min(MAX_CLEANING_CONCURRENCY, todo.length)
      get()._post(
        'assistant',
        `${isRerun ? '补充' : '开始'}清洗 ${todo.length} 份资料（并发 ${conc} 个，更快）……`,
        'narration'
      )

      const aborts = new Set<() => void>()
      let cancelled = false
      const failedRef: { current: { name: string; error: string } | null } = { current: null }
      set({ abortFn: () => { cancelled = true; aborts.forEach((fn) => fn()) } })

      let next = 0
      const worker = async (): Promise<void> => {
        while (!cancelled && !failedRef.current) {
          const i = next++
          if (i >= todo.length) return
          const s = todo[i]
          set((st) => ({
            cleaningProgress: {
              ...st.cleaningProgress,
              running: [...st.cleaningProgress.running, s.name].slice(0, 4)
            }
          }))
          get()._post('assistant', `⏳ 清洗：${s.name}`, 'narration')
          const cacheInput = toSourceCleanCacheInput(s)
          try {
            const cached = await window.api.lookupSourceCleanCache(cacheInput)
            if (!isCurrentSession()) return
            if (cached.hit && cached.text) {
              set((st) => ({ cleanDetails: [...st.cleanDetails, { id: s.id, name: s.name, text: cached.text! }] }))
              set((st) => ({
                cleaningProgress: {
                  ...st.cleaningProgress,
                  done: st.cleaningProgress.done + 1,
                  running: st.cleaningProgress.running.filter((name) => name !== s.name)
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
          if (s.kind === 'table' && cacheInput.text) {
            const localResult = preprocessTableForModel(cacheInput.text)
            const localDetail = buildLocalTableCleanDetail(cacheInput, localResult)
            if (localDetail) {
              set((st) => ({ cleanDetails: [...st.cleanDetails, { id: s.id, name: s.name, text: localDetail }] }))
              try {
                await window.api.storeSourceCleanCache(cacheInput, localDetail)
              } catch {
                // 本次本地清洗已经完成，缓存写入失败只影响下次复用。
              }
              set((st) => ({
                cleaningProgress: {
                  ...st.cleaningProgress,
                  done: st.cleaningProgress.done + 1,
                  running: st.cleaningProgress.running.filter((name) => name !== s.name)
                }
              }))
              get()._post('assistant', `✅ 本机已整理结构化表格：${s.name}`, 'narration')
              await recordOptimizationEvent(
                optimizationEvent(`local-clean:${sessionId}:${s.id}`, sessionId, 'local_source_clean', {
                  localCompletedFiles: 1,
                  skippedModelRequests: 1
                })
              )
              continue
            }
          }
          const modelSource = sourceForModel(cacheInput)
          const res = await runModelRetry(
            buildExtractMessages(modelSource),
            () => {},
            (fn) => {
              if (fn) aborts.add(fn)
            },
            undefined,
            2,
            {
              reportSessionId: sessionId,
              taskType: 'source_clean',
              taskKey: `${sessionId}:source_clean:${s.id}`,
              isVision: s.kind === 'image',
              sourceCount,
              imageCount,
              sourceId: s.id
            }
          )
          if (!isCurrentSession()) return
          if (!res.ok) {
            if (!failedRef.current) failedRef.current = { name: s.name, error: res.error || '失败' }
            set((st) => ({
              cleaningProgress: {
                ...st.cleaningProgress,
                running: st.cleaningProgress.running.filter((name) => name !== s.name),
                failed: st.cleaningProgress.failed + 1
              }
            }))
            return
          }
          set((st) => ({ cleanDetails: [...st.cleanDetails, { id: s.id, name: s.name, text: res.text }] }))
          try {
            await window.api.storeSourceCleanCache(cacheInput, res.text)
          } catch {
            // 写缓存失败只影响下次复用，不影响本次分析结果。
          }
          set((st) => ({
            cleaningProgress: {
              ...st.cleaningProgress,
              done: st.cleaningProgress.done + 1,
              running: st.cleaningProgress.running.filter((name) => name !== s.name)
            }
          }))
          get()._post('assistant', `✅ 已清洗：${s.name}`, 'narration')
        }
      }
      await Promise.all(Array.from({ length: conc }, () => worker()))
      if (!isCurrentSession()) return
      set({ abortFn: null })

      if (cancelled) {
        set({ phase: get().cleanedData ? 'checkpoint1' : 'idle' })
        return
      }
      if (failedRef.current) {
        const f = failedRef.current
        get()._post(
          'assistant',
          `⚠️ 「${f.name}」清洗失败：${f.error}。已完成的会保留，再点「开始生成」会跳过它们只洗剩下的。`,
          'error'
        )
        set({ phase: get().cleanedData ? 'checkpoint1' : 'idle' })
        return
      }
    }

    // 汇总：输入按文件截断（避免请求过大），网络错误自动重试一次
    get()._post('assistant', '正在汇总「① 资料分类总览」…', 'narration')
    const details = get().cleanDetails.map((d) => ({ name: d.name, text: d.text }))
    const blockId = get()._post('assistant', '', 'report-block')
    const res = await runModelRetry(
      buildSummaryMessages(details, get().steering),
      (acc) => {
        if (isCurrentSession()) get()._update(blockId, acc)
      },
      (fn) => {
        if (isCurrentSession()) set({ abortFn: fn })
      },
      (n) => {
        if (isCurrentSession()) get()._post('assistant', `汇总连接中断，正在重试（第 ${n} 次）…`, 'narration')
      },
      2,
      {
        reportSessionId: sessionId,
        taskType: 'summary',
        taskKey: `${sessionId}:summary`,
        isVision: false,
        sourceCount,
        imageCount
      }
    )
    if (!isCurrentSession()) return
    if (!res.ok) {
      get()._update(blockId, (res.text || '') + `\n\n⚠️ 汇总失败：${res.error}`)
      set({ phase: get().cleanedData ? 'checkpoint1' : 'idle' })
      return
    }

    // cleanedData = 汇总(总览+竞品+人群方向) + 各文件完整明细（供后续分析用，不截断）
    const detailFull = get().cleanDetails.map((d) => `### ${d.name}\n${d.text}`).join('\n\n')
    set({
      cleanedData: `${res.text}\n\n---\n## 各来源清洗明细\n\n${detailFull}`,
      phase: 'checkpoint1'
    })
    get()._post(
      'assistant',
      isRerun
        ? '✅ 已按你的要求重新归一（见上）。再核对一下「① 资料分类总览」和「竞品情况」；没问题点「确认，继续分析」，还要改继续说。'
        : '✅ 资料已清洗归一（见上）。请重点核对三处：\n' +
            '① 最上面的「① 资料分类总览」——每份文件的归属、平台/来源、信息类型对不对。不对就直接说，如「xxx.png 是竞品数据」「这份是自有数据」。\n' +
            '②「竞品情况」——若没发现竞品资料，我已按 8 类方向给了候选竞品 + 采集清单：可去采集后拖进来打字「重新归一」，或确认用推荐方向继续（会标注待验证），或打字指定竞品名。\n' +
            '③「初步人群方向」是否对。\n\n都没问题 → 点「确认，继续分析」；要纠偏 → 直接打字。',
      'checkpoint'
    )
  },

  _runAnalysis: async () => {
    const sessionId = get().analysisSessionId
    const isCurrentSession = (): boolean => get().analysisSessionId === sessionId
    set({ phase: 'analyzing' })
    const { sopRules, cleanedData } = get()
    for (const step of SOP_STEPS) {
      if (get().phase !== 'analyzing') return
      const isReportStep = step.id === REPORT_STEP_ID
      // 已完成的非成稿步骤直接跳过（支持中断后续跑）
      if (!isReportStep && get().artifacts[step.id]) continue

      const priorOutputs = isReportStep
        ? SOP_STEPS.filter((s) => s.id < step.id && get().artifacts[s.id]).map((s) => ({
            id: s.id,
            title: `第${s.id}步 ${s.title}`,
            output: compactForFinalReport(get().artifacts[s.id])
          }))
        : priorOutputsForStep(step.id, get().artifacts)
      if (isReportStep) {
        const previousReport = get().reportMarkdown
        const reportFeedback = get().steering
        get()._post('assistant', '⏳ 正在整合成稿…', 'narration')
        const res = await runFinalReportInParts({
          cleanedData: cleanedSummaryOnly(cleanedData),
          priorOutputs,
          feedback: reportFeedback,
          setAbort: (fn) => {
            if (isCurrentSession()) set({ abortFn: fn })
          },
          onProgress: (text) => {
            if (isCurrentSession()) set({ reportMarkdown: text })
          },
          onRetry: (partLabel, n) => {
            if (isCurrentSession()) get()._post('assistant', `成稿「${partLabel}」连接中断，重试第 ${n} 次…`, 'narration')
          },
          taskContext: {
            reportSessionId: sessionId,
            taskType: 'final_part',
            taskKeyPrefix: `${sessionId}:final_part`,
            sourceCount: get().sources.length,
            imageCount: get().sources.filter((source) => source.kind === 'image').length
          }
        })
        if (!isCurrentSession()) return
        if (!res.ok) {
          get()._post(
            'assistant',
            isUserStop(res.error)
              ? '已停止生成，上一份完整报告仍然保留。需要时可继续分析。'
              : `⚠️ 成稿中断：${res.error}。修好后点「确认，继续分析」可继续。`,
            isUserStop(res.error) ? 'narration' : 'error'
          )
          set({ phase: 'checkpoint1', reportMarkdown: previousReport })
          return
        }
        if (get().steering !== reportFeedback) {
          set({ reportMarkdown: previousReport })
          get()._post('assistant', '检测到你在成稿期间补充了新要求，正在自动按新要求再修订一次。', 'narration')
          await get()._rerunReport()
          return
        }
        set((s) => ({
          artifacts: { ...s.artifacts, [REPORT_STEP_ID]: res.text },
          reportMarkdown: res.text,
          reportStale: false
        }))
      } else {
        const messages = buildStepMessages({
          stepId: step.id,
          stepTitle: step.title,
          sopRules,
          cleanedData,
          priorOutputs,
          feedback: get().steering
        })
        get()._post('assistant', `⏳ 正在：${step.title}…`, 'narration')
        const res = await runModelRetry(
          messages,
          () => {},
          (fn) => set({ abortFn: fn }),
          (n) => get()._post('assistant', `${step.title}连接中断，重试第 ${n} 次…`, 'narration'),
          2,
          {
            reportSessionId: sessionId,
            taskType: 'analysis_step',
            taskKey: `${sessionId}:analysis_step:${step.id}`,
            isVision: false,
            sourceCount: get().sources.length,
            imageCount: get().sources.filter((source) => source.kind === 'image').length,
            stepId: String(step.id)
          }
        )
        if (!isCurrentSession()) return
        if (!res.ok) {
          get()._post(
            'assistant',
            isUserStop(res.error)
              ? `已停止「${step.title}」，已完成的内容已经保留。需要时可继续分析。`
              : `⚠️ ${step.title}中断：${res.error}。修好后点「确认，继续分析」可继续（已完成的步骤会跳过）。`,
            isUserStop(res.error) ? 'narration' : 'error'
          )
          set({ phase: 'checkpoint1' })
          return
        }
        set((s) => ({ artifacts: { ...s.artifacts, [step.id]: res.text } }))
        get()._post('assistant', `✅ ${step.title} 完成`, 'narration')
      }
    }
    if (!isCurrentSession()) return
    set({ phase: 'checkpoint2' })
    try {
      await storeCompleteReportResult(get())
    } catch {
      // 完整报告已生成；缓存失败不能影响本次结果和积分结算。
    }
    try {
      await window.api.getReportPointsCharge(sessionId)
      if (!isCurrentSession()) return
      get()._post(
        'assistant',
        '报告已完成，剩余积分可在页面顶部查看。',
        'narration'
      )
    } catch {
      if (!isCurrentSession()) return
      get()._post('assistant', '报告已完成，剩余积分可在页面顶部查看。', 'narration')
    }
    get()._post(
      'assistant',
      '✅ 报告初稿已生成（右侧）。需要改哪里直接说（如：经营建议再具体、第 9 步选题加几条），或点「确认定稿」。',
      'checkpoint'
    )
  },

  _rerunReport: async (latestFeedback) => {
    const sessionId = get().analysisSessionId
    const isCurrentSession = (): boolean => get().analysisSessionId === sessionId
    const { sopRules, cleanedData, steering, artifacts } = get()
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
        imageCount: get().sources.filter((source) => source.kind === 'image').length
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
      await window.api.getReportPointsCharge(sessionId)
      if (!isCurrentSession()) return
      get()._post(
        'assistant',
        '✅ 已按你的要求修订报告。还要改继续说，或点「确认定稿」。剩余积分可在页面顶部查看。',
        'checkpoint'
      )
    } catch {
      if (!isCurrentSession()) return
      get()._post('assistant', '✅ 已按你的要求修订报告。还要改继续说，或点「确认定稿」。剩余积分可在页面顶部查看。', 'checkpoint')
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
        set((s) => {
          const committedReport = s.artifacts[REPORT_STEP_ID] || s.reportMarkdown
          return {
            steering: (s.steering ? s.steering + '\n' : '') + t,
            artifacts: committedReport ? { [REPORT_STEP_ID]: committedReport } : {},
            reportStale: Boolean(committedReport)
          }
        })
        get()._post('assistant', '好的，按你的要求重新清洗归一……', 'narration')
        await get()._runCleaning(true)
        return true
      }
      if (phase === 'checkpoint2' || phase === 'done') {
        set((s) => ({ steering: (s.steering ? s.steering + '\n' : '') + t }))
        get()._post('assistant', '好的，按你的要求修订报告……', 'narration')
        await get()._rerunReport(t)
        return true
      }
      set((s) => ({ steering: (s.steering ? s.steering + '\n' : '') + t }))
      get()._post('assistant', '已保存为本次分析目标。上传资料后点「开始生成报告」即可。', 'narration')
      return true
    } catch (error) {
      set({
        abortFn: null,
        phase:
          phase === 'checkpoint2' || phase === 'done'
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
    const { reportMarkdown: md, phase, artifacts, reportStale, exportStatus } = get()
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
    set({ exportStatus: '导出中…', lastExportPath: '' })
    const name = defaultReportName(format)
    try {
      const res =
        format === 'html'
          ? await window.api.exportHtml(md, name)
          : format === 'md'
            ? await window.api.exportMarkdown(md, name)
            : await window.api.exportDocx(md, name)
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
