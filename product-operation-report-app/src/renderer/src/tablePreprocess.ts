import Papa from 'papaparse'
import { sourceKindLabel, type SourceCleanCacheInput } from '../../shared/types'
import { sourceEvidenceId, sourceEvidenceScope } from './sourceCleanBatches'

const MAX_STRUCTURED_TABLE_CHARS = 40 * 1024 * 1024
const MAX_TABLE_COLUMNS = 200

export interface TablePreprocessResult {
  text: string
  applied: boolean
  mode: 'original' | 'profile' | 'material' | 'product'
  originalRows: number
  retainedRows: number
  confidence: 'high' | 'fallback'
  canSkipModel: boolean
  processingSource: 'original' | 'local_table'
  sheetCount: number
  removedColumns: string[]
}

interface WorkbookBlock {
  sheetName?: string
  text: string
}

interface PreparedSheet {
  sheetName?: string
  headers: string[]
  body: string[][]
  removedColumns: string[]
  mode: TablePreprocessResult['mode']
  recognized: boolean
}

const fallbackResult = (text: string, originalRows = 0): TablePreprocessResult => ({
  text,
  applied: false,
  mode: 'original',
  originalRows,
  retainedRows: originalRows,
  confidence: 'fallback',
  canSkipModel: false,
  processingSource: 'original',
  sheetCount: 0,
  removedColumns: []
})

function cleanCell(value: unknown): string {
  return String(value ?? '').replace(/\u0000/gu, '').trim()
}

function workbookBlocks(text: string): WorkbookBlock[] {
  const marker = /^###\s*工作表：([^\r\n]+)\r?$/gmu
  const matches = [...text.matchAll(marker)]
  if (!matches.length) return [{ text }]
  const blocks: WorkbookBlock[] = []
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]
    const start = (match.index || 0) + match[0].length
    const end = index + 1 < matches.length ? matches[index + 1].index || text.length : text.length
    const blockText = text.slice(start, end).replace(/^\r?\n/u, '').trim()
    if (blockText) blocks.push({ sheetName: cleanCell(match[1]), text: blockText })
  }
  return blocks
}

function parseBlock(block: WorkbookBlock): { headers: string[]; body: string[][]; removedColumns: string[] } | null {
  const firstLine = block.text.split(/\r?\n/u).find((line) => line.trim()) || ''
  const delimiter = firstLine.includes('\t') ? '\t' : firstLine.includes(',') ? ',' : undefined
  const parsed = Papa.parse<string[]>(block.text, {
    skipEmptyLines: 'greedy',
    dynamicTyping: false,
    ...(delimiter ? { delimiter } : {})
  })
  if (parsed.errors.some((error) => error.type === 'Quotes')) return null
  const rows = parsed.data
    .map((row) => row.map(cleanCell))
    .filter((row) => row.some(Boolean))
  if (rows.length < 2) return null
  const width = Math.max(...rows.map((row) => row.length))
  if (width < 2 || width > MAX_TABLE_COLUMNS) return null
  const rawBody = rows.slice(1)
  const usedHeaders = new Set(rows[0].map(cleanCell).filter(Boolean))
  let unnamedColumn = 0
  const rawHeaders = Array.from({ length: width }, (_, column) => {
    const original = cleanCell(rows[0][column])
    if (original || !rawBody.some((row) => Boolean(row[column]))) return original
    let generated = ''
    do {
      unnamedColumn += 1
      generated = `未命名附加列${unnamedColumn}`
    } while (usedHeaders.has(generated))
    usedHeaders.add(generated)
    return generated
  })
  const activeColumns = Array.from({ length: width }, (_, column) => column).filter((column) =>
    Boolean(rawHeaders[column]) && rawBody.some((row) => Boolean(row[column]))
  )
  const removedColumns = rawHeaders.filter((header, column) => Boolean(header) && !activeColumns.includes(column))
  const headers = activeColumns.map((column) => rawHeaders[column])
  const body = rawBody.map((row) => activeColumns.map((column) => cleanCell(row[column])))
  if (!headers.every(Boolean) || new Set(headers).size !== headers.length || !body.length) return null
  const repeatedHeader = body.some((row) => row.every((cell, index) => cell === headers[index]))
  if (repeatedHeader) return null
  return { headers, body, removedColumns }
}

function reasoningColumn(header: string): boolean {
  return /思考过程|推理过程|chain\s*of\s*thought|reasoning/iu.test(header)
}

function materialCoreComplete(headers: string[]): boolean {
  const hasSource = headers.some((header) => /原视频|视频链接|素材(?:ID|编号|名称)|文件名/u.test(header))
  const hasText = headers.some((header) => /完整文案|脚本文案|口播文案|口播字幕|字幕|脚本/u.test(header))
  const structured = headers.filter((header) => /前三秒|3秒|素材类型|视角分析|内容形式|场景标签|卖点排序/u.test(header)).length
  return hasSource && hasText && structured >= 2
}

function removableAiWrapper(header: string, hasCompleteMaterialCore: boolean): boolean {
  if (!hasCompleteMaterialCore) return false
  if (/^(?:豆包|标签分析)(?:\.|$)/u.test(header)) return true
  return /\.(?:输出结果|思考结果)$/u.test(header) && !/^视角分析$/u.test(header)
}

function duplicateColumns(headers: string[], body: string[][]): Set<number> {
  const removed = new Set<number>()
  for (let right = 1; right < headers.length; right += 1) {
    for (let left = 0; left < right; left += 1) {
      if (removed.has(left)) continue
      let hasValue = false
      let equal = true
      for (const row of body) {
        const a = cleanCell(row[left])
        const b = cleanCell(row[right])
        hasValue ||= Boolean(a || b)
        if (a !== b) {
          equal = false
          break
        }
      }
      if (hasValue && equal) {
        removed.add(right)
        break
      }
    }
  }
  return removed
}

function tableMode(headers: string[]): TablePreprocessResult['mode'] {
  const text = headers.join('|')
  if (/3秒|文案|素材|视角分析|内容形式|场景标签|卖点排序/u.test(text)) return 'material'
  if (/商品|产品|SKU|货品|成交|销售|订单|金额|消耗|曝光|点击|转化|退款/u.test(text)) return 'product'
  if (/标签类型|人群|画像|年龄|性别|地区|占比|比例/u.test(text)) return 'profile'
  return 'original'
}

function recognizedBusinessTable(headers: string[]): boolean {
  return headers.some((header) =>
    /产品|商品|SKU|货品|素材|视频|文案|脚本|成交|销售|订单|金额|消耗|曝光|点击|转化|退款|人群|画像|标签|占比|评价|评论|反馈|场景|卖点|平台|日期|时间/u.test(header)
  )
}

function prepareSheet(block: WorkbookBlock): PreparedSheet | null {
  const parsed = parseBlock(block)
  if (!parsed) return null
  const duplicate = duplicateColumns(parsed.headers, parsed.body)
  const completeMaterial = materialCoreComplete(parsed.headers)
  const keep = parsed.headers.map((header, index) => ({ header, index })).filter(({ header, index }) =>
    !reasoningColumn(header) && !duplicate.has(index) && !removableAiWrapper(header, completeMaterial)
  )
  if (keep.length < 2) return null
  const indexes = keep.map(({ index }) => index)
  const headers = indexes.map((index) => parsed.headers[index])
  const body = parsed.body.map((row) => indexes.map((index) => cleanCell(row[index])))
  const removedColumns = [
    ...parsed.removedColumns,
    ...parsed.headers.filter((_header, index) => !indexes.includes(index))
  ]
  return {
    sheetName: block.sheetName,
    headers,
    body,
    removedColumns,
    mode: tableMode(headers),
    recognized: recognizedBusinessTable(headers)
  }
}

function serializeSheets(sheets: PreparedSheet[]): string {
  return sheets.map((sheet, index) => [
    `### 工作表：${sheet.sheetName || `Sheet${index + 1}`}`,
    Papa.unparse([sheet.headers, ...sheet.body], { newline: '\n' })
  ].join('\n')).join('\n\n')
}

function preparedWorkbook(text: string): PreparedSheet[] | null {
  if (!text.trim() || text.length > MAX_STRUCTURED_TABLE_CHARS) return null
  const blocks = workbookBlocks(text)
  if (!blocks.length) return null
  const sheets = blocks.map(prepareSheet)
  return sheets.every((sheet): sheet is PreparedSheet => Boolean(sheet)) ? sheets : null
}

export function preprocessTableForModel(text: string): TablePreprocessResult {
  const sheets = preparedWorkbook(text)
  if (!sheets) return fallbackResult(text)
  const originalRows = sheets.reduce((sum, sheet) => sum + sheet.body.length, 0)
  const removedColumns = [...new Set(sheets.flatMap((sheet) => sheet.removedColumns))]
  const normalized = serializeSheets(sheets)
  const recognized = sheets.every((sheet) => sheet.recognized)
  if (!recognized && !removedColumns.length) return fallbackResult(text, originalRows)
  const modes = new Set(sheets.map((sheet) => sheet.mode))
  const mode = modes.size === 1 ? sheets[0].mode : 'original'
  return {
    text: normalized,
    applied: normalized !== text || removedColumns.length > 0,
    mode,
    originalRows,
    retainedRows: originalRows,
    confidence: recognized ? 'high' : 'fallback',
    canSkipModel: recognized,
    processingSource: normalized !== text || recognized ? 'local_table' : 'original',
    sheetCount: sheets.length,
    removedColumns
  }
}

function metadataValue(value: string | undefined, fallback: string): string {
  return value?.trim() || fallback
}

export function buildLocalTableCleanDetail(
  source: SourceCleanCacheInput,
  result = source.text ? preprocessTableForModel(source.text) : fallbackResult('')
): string | null {
  if (source.kind !== 'table' || !result.canSkipModel || result.confidence !== 'high') return null
  const sheets = preparedWorkbook(result.text)
  if (!sheets?.length) return null
  const bodyCount = sheets.reduce((sum, sheet) => sum + sheet.body.length, 0)
  if (bodyCount !== result.originalRows || bodyCount !== result.retainedRows) return null
  const attribution = metadataValue(source.attribution, '自有数据')
  const platform = metadataValue(source.platform, '需补充')
  const purpose = sourceKindLabel(source.kindV1, source.purpose || '') || '结构化表格数据'
  const note = source.note?.trim() ? `\n用户补充：${source.note.trim()}` : ''
  const scope = sourceEvidenceScope(source)
  let rowOffset = 0
  const evidenceIds = new Set<string>()
  const evidenceSheets = sheets.map((sheet, sheetIndex) => {
    const rows = sheet.body.map((row) => {
      rowOffset += 1
      const evidenceId = sourceEvidenceId('R', scope, rowOffset)
      evidenceIds.add(evidenceId)
      return [evidenceId, ...row]
    })
    return [
      `### 工作表：${sheet.sheetName || `Sheet${sheetIndex + 1}`}`,
      Papa.unparse([['__证据ID', ...sheet.headers], ...rows], { newline: '\n' })
    ].join('\n')
  })
  if (rowOffset !== bodyCount || evidenceIds.size !== bodyCount) return null
  const removed = result.removedColumns.length
    ? `；已移除无效或重复列：${result.removedColumns.join('、')}`
    : ''
  return [
    `分类：${attribution} | ${platform} | ${purpose} | 需从表格字段确认 | 表格 | 本机完整读取 ${result.sheetCount} 个工作表、${bodyCount} 条有效记录`,
    '',
    '## 清洗后内容',
    `来源文件：${source.name}`,
    '处理方式：本机高可信结构化整理（未调用模型，本文件未扣清洗积分）',
    `来源归属：${attribution}；平台/来源：${platform}；信息类型：${purpose}${note}`,
    `完整性核对：程序已保留全部 ${bodyCount} 条记录，并逐行生成 ${evidenceIds.size} 个唯一证据ID${removed}。`,
    '以下内容只来自原表格；未出现的信息不得推测：',
    '',
    evidenceSheets.join('\n\n')
  ].join('\n')
}

export const tablePreprocessInternals = {
  MAX_STRUCTURED_TABLE_CHARS,
  MAX_TABLE_COLUMNS,
  workbookBlocks,
  parseBlock,
  duplicateColumns,
  reasoningColumn,
  materialCoreComplete,
  recognizedBusinessTable
}
