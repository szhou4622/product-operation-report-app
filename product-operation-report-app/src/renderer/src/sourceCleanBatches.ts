import Papa from 'papaparse'
import type { SourceCleanCacheInput } from '../../shared/types'
import { SOURCE_TEXT_LIMIT } from '../../shared/reportVersions'

// 真实 50k Token 清洗请求在兼容中转上可能超过 90 秒才返回首包。
// 控制在约 28k 字符，让宽表分成更多但更可靠、单次预留更低的批次。
const CLEAN_BATCH_CHAR_LIMIT = 28_000
const MIN_TEXT_SPLIT_AT = 20_000
console.assert(CLEAN_BATCH_CHAR_LIMIT < SOURCE_TEXT_LIMIT, 'cleaning batch limit must remain below source text limit')

export interface SourceCleanBatchContext {
  batchIndex: number
  batchCount: number
  originalRecordCount?: number
  scheduledRecordCount?: number
  recordStart?: number
  recordEnd?: number
  sheetName?: string
  isMaterialTable: boolean
  originalTextChars: number
  /** Deterministic IDs that must be echoed by the cleaning result. */
  evidenceIds: string[]
  /** Compact receipt used when every row is sent but the model must not copy every row back. */
  coverageReceipt?: string
  mode: SourceCleanBatchPlan['mode']
}

export interface SourceCleanBatch {
  source: SourceCleanCacheInput
  context: SourceCleanBatchContext
}

export interface SourceCleanBatchPlan {
  mode: 'single' | 'table_rows' | 'semantic_rows' | 'text_chunks' | 'mixed_evidence'
  batches: SourceCleanBatch[]
  originalRecordCount?: number
  scheduledRecordCount?: number
  isMaterialTable: boolean
  originalTextChars: number
  degradedReason?: TableDegradedReason
}

export type TableDegradedReason = 'quotes' | 'too_few_rows' | 'too_wide'

type NormalizedTableRowsResult =
  | { ok: true; rows: string[][] }
  | { ok: false; reason: TableDegradedReason }

interface WorkbookBlock {
  sheetName?: string
  text: string
}

interface TablePiece {
  text: string
  sheetName?: string
  recordStart: number
  recordEnd: number
  isMaterialTable: boolean
  evidenceIds: string[]
}

export function sourceEvidenceScope(source: SourceCleanCacheInput): string {
  const content = source.text || source.dataUrl || ''
  const attachmentScope = (source.attachments || []).map((item) => {
    const data = item.dataUrl || ''
    const middle = Math.max(0, Math.floor(data.length / 2) - 256)
    return [item.name, String(data.length), data.slice(0, 512), data.slice(middle, middle + 512), data.slice(-512)].join('\u0000')
  }).join('\u0001')
  const middle = Math.max(0, Math.floor(content.length / 2) - 1024)
  // Evidence IDs only need to be compact and stable inside a report. Sampling the beginning,
  // middle and end prevents same-name/same-prefix exports from sharing a scope without hashing
  // hundreds of megabytes on the renderer thread.
  const text = [
    source.name,
    String(content.length),
    content.slice(0, 2048),
    content.slice(middle, middle + 2048),
    content.slice(-2048),
    attachmentScope
  ].join('\u0000')
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).toUpperCase().padStart(8, '0')
}

export function sourceEvidenceId(prefix: 'R' | 'T' | 'I', scope: string, index: number): string {
  return `POR-${prefix}-${scope}-${String(index).padStart(6, '0')}`
}

function splitCompleteText(text: string, limit = CLEAN_BATCH_CHAR_LIMIT): string[] {
  if (text.length <= limit) return [text]
  const chunks: string[] = []
  let offset = 0
  while (offset < text.length) {
    let end = Math.min(text.length, offset + limit)
    if (end < text.length) {
      const newline = text.lastIndexOf('\n', end)
      if (newline >= offset + Math.min(MIN_TEXT_SPLIT_AT, Math.floor(limit / 2))) end = newline + 1
    }
    if (end <= offset) end = Math.min(text.length, offset + limit)
    chunks.push(text.slice(offset, end))
    offset = end
  }
  return chunks
}

function workbookBlocks(text: string): WorkbookBlock[] {
  const marker = /^###\s*\u5de5\u4f5c\u8868\uff1a([^\r\n]+)\r?$/gmu
  const matches = [...text.matchAll(marker)]
  if (!matches.length) return [{ text }]
  const blocks: WorkbookBlock[] = []
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index]
    const start = (match.index || 0) + match[0].length
    const end = index + 1 < matches.length ? matches[index + 1].index || text.length : text.length
    const block = text.slice(start, end).replace(/^\r?\n/u, '').trim()
    if (block) blocks.push({ sheetName: match[1].trim(), text: block })
  }
  return blocks.length ? blocks : [{ text }]
}

function normalizedTableRows(text: string): NormalizedTableRowsResult {
  const firstLine = text.split(/\r?\n/u).find((line) => line.trim()) || ''
  const delimiter = firstLine.includes('\t') ? '\t' : firstLine.includes(',') ? ',' : undefined
  const parsed = Papa.parse<string[]>(text, {
    skipEmptyLines: 'greedy',
    dynamicTyping: false,
    ...(delimiter ? { delimiter } : {})
  })
  if (parsed.errors.some((error) => error.type === 'Quotes')) return { ok: false, reason: 'quotes' }
  const rows = parsed.data
    .map((row) => row.map((cell) => String(cell ?? '').replace(/\u0000/gu, '').trim()))
    .filter((row) => row.some(Boolean))
  if (rows.length < 2) return { ok: false, reason: 'too_few_rows' }
  const width = Math.max(...rows.map((row) => row.length))
  if (width < 2) return { ok: false, reason: 'too_few_rows' }
  if (width > 200) return { ok: false, reason: 'too_wide' }
  const activeColumns = Array.from({ length: width }, (_, column) => column).filter((column) =>
    rows.some((row) => Boolean(row[column]?.trim()))
  )
  return { ok: true, rows: rows.map((row) => activeColumns.map((column) => row[column] || '')) }
}

function tablePieces(
  block: WorkbookBlock,
  rows: string[][],
  globalRecordOffset: number,
  scope: string
): TablePiece[] | null {
  const [headers, ...body] = rows
  const isMaterialTable = headers.some((header) => /\u539f\u89c6\u9891|3\s*\u79d2|\u6587\u6848|\u811a\u672c|\u7d20\u6750|\u89c6\u89d2|\u5185\u5bb9\u5f62\u5f0f/u.test(header))
  const headerCsv = Papa.unparse([['__\u8bc1\u636eID', ...headers]], { newline: '\n' })
  // 异常超长表头不适合按行重复，回退到完整文本分段，仍然不丢字符。
  if (headerCsv.length > Math.floor(CLEAN_BATCH_CHAR_LIMIT / 2)) return null
  const pieces: TablePiece[] = []
  let currentRows: string[] = []
  let currentStart = 0
  let currentChars = 0
  let currentEvidenceIds: string[] = []

  const flush = (endLocalIndex: number): void => {
    if (!currentRows.length) return
    pieces.push({
      text: `${headerCsv}\n${currentRows.join('\n')}`,
      sheetName: block.sheetName,
      recordStart: globalRecordOffset + currentStart + 1,
      recordEnd: globalRecordOffset + endLocalIndex + 1,
      isMaterialTable,
      evidenceIds: currentEvidenceIds
    })
    currentRows = []
    currentChars = 0
    currentEvidenceIds = []
  }

  body.forEach((row, localIndex) => {
    const rowEvidenceId = sourceEvidenceId('R', scope, globalRecordOffset + localIndex + 1)
    const rowCsv = Papa.unparse([[rowEvidenceId, ...row]], { newline: '\n' })
    const candidateLength = headerCsv.length + 1 + currentChars + rowCsv.length
    if (currentRows.length && candidateLength > CLEAN_BATCH_CHAR_LIMIT) {
      flush(localIndex - 1)
    }
    if (!currentRows.length) currentStart = localIndex
    if (headerCsv.length + 1 + rowCsv.length <= CLEAN_BATCH_CHAR_LIMIT) {
      currentRows.push(rowCsv)
      currentEvidenceIds.push(rowEvidenceId)
      currentChars += rowCsv.length + 1
      return
    }

    flush(localIndex - 1)
    const fragmentLimit = Math.max(4_000, CLEAN_BATCH_CHAR_LIMIT - headerCsv.length - 300)
    const fragments = splitCompleteText(rowCsv, fragmentLimit)
    fragments.forEach((fragment, fragmentIndex) => {
      pieces.push({
        text: [
          headerCsv,
          `\u3010\u8d85\u957f\u8bb0\u5f55\u5206\u6bb5\u3011\u7b2c ${globalRecordOffset + localIndex + 1} \u6761\u8bb0\u5f55\uff0c\u7247\u6bb5 ${fragmentIndex + 1}/${fragments.length}\u3002\u7247\u6bb5\u9700\u4e0e\u540c\u4e00\u6761\u8bb0\u5f55\u7684\u5176\u4ed6\u7247\u6bb5\u5408\u5e76\u7406\u89e3\u3002`,
          fragment
        ].join('\n'),
        sheetName: block.sheetName,
        recordStart: globalRecordOffset + localIndex + 1,
        recordEnd: globalRecordOffset + localIndex + 1,
        isMaterialTable,
        evidenceIds: [rowEvidenceId]
      })
    })
    currentStart = localIndex + 1
  })
  flush(body.length - 1)
  return pieces
}

function tableBatchPlan(
  source: SourceCleanCacheInput,
  text: string,
  semanticSummary = false
): { plan: SourceCleanBatchPlan | null; degradedReason?: TableDegradedReason } {
  const blocks = workbookBlocks(text)
  const pieces: TablePiece[] = []
  let recordOffset = 0
  let material = false
  for (const block of blocks) {
    const normalized = normalizedTableRows(block.text)
    if (!normalized.ok) return { plan: null, degradedReason: normalized.reason }
    const bodyCount = normalized.rows.length - 1
    const next = tablePieces(block, normalized.rows, recordOffset, sourceEvidenceScope(source))
    if (!next?.length) return { plan: null, degradedReason: 'too_wide' }
    pieces.push(...next)
    material ||= next.some((piece) => piece.isMaterialTable)
    recordOffset += bodyCount
  }
  const batchCount = pieces.length
  const batches = pieces.map((piece, index) => ({
    source: { ...source, text: piece.text },
    context: {
      batchIndex: index + 1,
      batchCount,
      originalRecordCount: recordOffset,
      scheduledRecordCount: recordOffset,
      recordStart: piece.recordStart,
      recordEnd: piece.recordEnd,
      sheetName: piece.sheetName,
      isMaterialTable: material,
      originalTextChars: text.length,
      evidenceIds: piece.evidenceIds,
      coverageReceipt: semanticSummary
        ? `POR-B-${sourceEvidenceScope(source)}-${String(index + 1).padStart(4, '0')}|ROWS:${piece.recordStart}-${piece.recordEnd}|COUNT:${piece.evidenceIds.length}`
        : undefined,
      mode: semanticSummary ? 'semantic_rows' as const : 'table_rows' as const
    }
  }))
  return { plan: {
    mode: semanticSummary ? 'semantic_rows' : 'table_rows',
    batches,
    originalRecordCount: recordOffset,
    scheduledRecordCount: recordOffset,
    isMaterialTable: material,
    originalTextChars: text.length
  } }
}

function buildTextSourceCleanBatchPlan(
  input: SourceCleanCacheInput,
  options: { semanticSummary?: boolean } = {}
): SourceCleanBatchPlan {
  const source: SourceCleanCacheInput = { ...input, attachments: undefined }
  const text = source.text || ''
  const scope = sourceEvidenceScope(source)
  if (source.kind === 'image' || !text) {
    return {
      mode: 'single',
      batches: [{
        source,
        context: {
          batchIndex: 1,
          batchCount: 1,
          isMaterialTable: false,
          originalTextChars: text.length,
          evidenceIds: [sourceEvidenceId('I', scope, 1)],
          mode: 'single'
        }
      }],
      isMaterialTable: false,
      originalTextChars: text.length
    }
  }
  if (source.kind === 'table') {
    const table = tableBatchPlan(source, text, Boolean(options.semanticSummary))
    if (table.plan) return table.plan
    const parts = splitCompleteText(text)
    const mode = parts.length > 1 ? 'text_chunks' : 'single'
    return {
      mode,
      batches: parts.map((part, index) => ({
        source: { ...source, text: `【证据片段ID】${sourceEvidenceId('T', scope, index + 1)}\n${part}` },
        context: {
          batchIndex: index + 1,
          batchCount: parts.length,
          isMaterialTable: false,
          originalTextChars: text.length,
          evidenceIds: [sourceEvidenceId('T', scope, index + 1)],
          mode
        }
      })),
      isMaterialTable: false,
      originalTextChars: text.length,
      degradedReason: table.degradedReason
    }
  }
  const parts = splitCompleteText(text)
  const mode = parts.length > 1 ? 'text_chunks' : 'single'
  return {
    mode,
    batches: parts.map((part, index) => ({
      source: { ...source, text: `\u3010\u8bc1\u636e\u7247\u6bb5ID\u3011${sourceEvidenceId('T', scope, index + 1)}\n${part}` },
      context: {
        batchIndex: index + 1,
        batchCount: parts.length,
        isMaterialTable: false,
        originalTextChars: text.length,
        evidenceIds: [sourceEvidenceId('T', scope, index + 1)],
        mode
      }
    })),
    isMaterialTable: false,
    originalTextChars: text.length
  }
}

export function buildSourceCleanBatchPlan(
  source: SourceCleanCacheInput,
  options: { semanticSummary?: boolean } = {}
): SourceCleanBatchPlan {
  const base = buildTextSourceCleanBatchPlan(source, options)
  const attachments = (source.attachments || []).filter(
    (item): item is typeof item & { dataUrl: string } => Boolean(item.dataUrl)
  )
  if (!attachments.length) return base

  const scope = sourceEvidenceScope(source)
  const imageBatches: SourceCleanBatch[] = []
  for (let offset = 0; offset < attachments.length; offset += 4) {
    const group = attachments.slice(offset, offset + 4)
    const evidenceIds = group.map((_, index) => sourceEvidenceId('I', scope, offset + index + 1))
    imageBatches.push({
      source: {
        ...source,
        dataUrl: undefined,
        text: [
          '【PPT/Office内嵌图片证据】以下图片属于同一个原始文件，不是独立上传资料。',
          ...group.map((item, index) => `${evidenceIds[index]} | ${item.name}`)
        ].join('\n'),
        attachments: group
      },
      context: {
        batchIndex: 0,
        batchCount: 0,
        isMaterialTable: false,
        originalTextChars: source.text?.length || 0,
        evidenceIds,
        mode: 'text_chunks'
      }
    })
  }
  const textBatches = source.text || source.dataUrl ? base.batches : []
  const batches = [...textBatches, ...imageBatches]
  return {
    ...base,
    mode: 'mixed_evidence',
    batches: batches.map((batch, index) => ({
      ...batch,
      context: { ...batch.context, batchIndex: index + 1, batchCount: batches.length }
    })),
    originalTextChars: source.text?.length || 0
  }
}

export function combineSourceCleanBatchOutputs(plan: SourceCleanBatchPlan, outputs: string[]): string {
  if (outputs.length !== plan.batches.length || outputs.some((output) => !output.trim())) {
    throw new Error('\u6e05\u6d17\u6279\u6b21\u4e0d\u5b8c\u6574\uff0c\u672c\u6587\u4ef6\u4e0d\u80fd\u6807\u8bb0\u4e3a\u5df2\u5b8c\u6210\u3002')
  }
  const missing = plan.batches.flatMap((batch, index) =>
    missingSourceCleanEvidenceIds(batch.context, outputs[index], batch.context.mode)
  )
  if (missing.length) {
    const preview = missing.slice(0, 8).join('\u3001')
    throw new Error(
      `\u6e05\u6d17\u7ed3\u679c\u672a\u8986\u76d6 ${missing.length} \u4e2a\u8bc1\u636e\u5355\u5143\uff08${preview}${missing.length > 8 ? '\u7b49' : ''}\uff09\uff0c\u672c\u6587\u4ef6\u4e0d\u80fd\u6807\u8bb0\u4e3a\u5df2\u5b8c\u6210\u3002`
    )
  }
  const coverage = plan.mode === 'table_rows' || plan.mode === 'semantic_rows'
    ? [
        '## \u7cfb\u7edf\u5b8c\u6574\u6027\u6838\u5bf9',
        `- \u539f\u59cb\u6709\u6548\u8bb0\u5f55\uff1a${plan.originalRecordCount || 0} \u6761`,
        `- \u5df2\u9001\u5165\u6e05\u6d17\u6d41\u7a0b\uff1a${plan.scheduledRecordCount || 0} \u6761`,
        `- \u52a8\u6001\u6e05\u6d17\u6279\u6b21\uff1a${plan.batches.length} \u6279`,
        ...(plan.isMaterialTable
          ? [`- \u5df2\u8986\u76d6\u7d20\u6750\u6570\u91cf\uff1a${plan.scheduledRecordCount || 0} \u6761\uff08\u6309\u539f\u89c6\u9891/\u6709\u6548\u6570\u636e\u884c\u8ba1\u6570\uff0c\u4e0d\u6309\u4ea7\u54c1\u79cd\u7c7b\u8ba1\u6570\uff09`] : []),
        plan.mode === 'semantic_rows'
          ? `- 模型输入覆盖：${plan.scheduledRecordCount || 0} 条记录全部进入语义批次；${plan.batches.length} 个批次回执均已核对。`
          : `- \u6a21\u578b\u8fd4\u56de\u8986\u76d6\uff1a${plan.batches.flatMap((batch) => batch.context.evidenceIds).length} \u4e2a\u8bc1\u636eID\u5747\u5df2\u901a\u8fc7\u7a0b\u5e8f\u6838\u5bf9\u3002`,
        plan.mode === 'semantic_rows'
          ? '- 完整性结论：全部有效记录均已送入模型读取；输出只保留批次结论和有效来源锚点，不逐行复写原表。'
          : '- \u5b8c\u6574\u6027\u7ed3\u8bba\uff1a\u5168\u90e8\u6709\u6548\u8bb0\u5f55\u5747\u5df2\u9001\u5165\u6e05\u6d17\u4e14\u8fd4\u56de\u8986\u76d6\u8bc1\u636eID\uff0c\u672a\u505a\u62bd\u6837\u6216\u56fa\u5b9a\u6761\u6570\u622a\u65ad\u3002'
      ].join('\n')
    : [
        '## \u7cfb\u7edf\u5b8c\u6574\u6027\u6838\u5bf9',
        `- \u539f\u59cb\u62bd\u53d6\u6587\u672c\uff1a${plan.originalTextChars.toLocaleString('zh-CN')} \u5b57\u7b26`,
        `- \u52a8\u6001\u6e05\u6d17\u6279\u6b21\uff1a${plan.batches.length} \u6279`,
        `- \u6a21\u578b\u8fd4\u56de\u8986\u76d6\uff1a${plan.batches.flatMap((batch) => batch.context.evidenceIds).length} \u4e2a\u8bc1\u636e\u7247\u6bb5ID\u5747\u5df2\u901a\u8fc7\u7a0b\u5e8f\u6838\u5bf9\u3002`,
        '- 完整性结论：本文件未能按行核对，仅完成文本分段覆盖核对；请结合资料确认页重点检查关键字段。'
      ].join('\n')
  const firstLines = outputs[0].trim().split(/\r?\n/u)
  const firstClassification = firstLines.shift() || ''
  const firstBody = firstLines.join('\n').trim()
  const rest = outputs.slice(1).map((output, index) => `### \u6e05\u6d17\u6279\u6b21 ${index + 2}/${outputs.length}\n${output.trim()}`)
  // 保留模型输出的首行分类，但把系统统计的完整性核对放在所有模型摘要之前，
  // 避免用户先看到单批数量而误以为是整份文件数量。
  return [firstClassification, coverage, firstBody, ...rest].filter(Boolean).join('\n\n')
}

export function missingSourceCleanEvidenceIds(
  context: SourceCleanBatchContext,
  output: string,
  mode: SourceCleanBatchPlan['mode']
): string[] {
  if (mode === 'semantic_rows') {
    const receipt = context.coverageReceipt
    if (!receipt || !output.includes(`COVERAGE:${receipt}`)) return receipt ? [receipt] : [...context.evidenceIds]
    const cited = [...output.matchAll(/POR-R-[A-F0-9]{8}-\d{6}/gu)].map((match) => match[0])
    const allowed = new Set(context.evidenceIds)
    return cited.some((id) => !allowed.has(id)) ? [receipt] : []
  }
  if (mode !== 'table_rows') return context.evidenceIds.filter((id) => !output.includes(id))
  if (output.length > 2_048) {
    const offsets = context.evidenceIds.map((id) => output.indexOf(id)).filter((offset) => offset >= 0)
    if (offsets.length === context.evidenceIds.length && Math.min(...offsets) >= output.length - 2_048) {
      return [...context.evidenceIds]
    }
  }
  const lines = output.split(/\r?\n/u)
  const headerIndex = lines.findIndex((line) => /^\s*["']?__证据ID["']?\s*[,\t]/u.test(line))
  if (headerIndex < 0) return [...context.evidenceIds]
  const parsed = Papa.parse<string[]>(
    lines.slice(headerIndex).filter((line) => !/^\s*```/u.test(line)).join('\n'),
    { skipEmptyLines: 'greedy', dynamicTyping: false }
  )
  const rows = parsed.data
    .map((row) => row.map((cell) => String(cell ?? '').trim()))
    .filter((row) => row.some(Boolean))
  const dataRows = rows.slice(1).filter((row) => row.length >= 2 && row.slice(1).some(Boolean))
  if (dataRows.length < context.evidenceIds.length) return [...context.evidenceIds]
  const counts = new Map<string, number>()
  for (const row of dataRows) counts.set(row[0], (counts.get(row[0]) || 0) + 1)
  return context.evidenceIds.filter((id) => counts.get(id) !== 1)
}

export const sourceCleanBatchInternals = {
  CLEAN_BATCH_CHAR_LIMIT,
  splitCompleteText,
  workbookBlocks,
  normalizedTableRows,
  SOURCE_TEXT_COMPATIBILITY_LIMIT: SOURCE_TEXT_LIMIT
}
