import Papa from 'papaparse'
import type { SourceCleanCacheInput } from '../../shared/types'

const TABLE_PREPROCESS_THRESHOLD = 15_000
const LOCAL_TABLE_MAX_CHARS = 12_000
const PROFILE_ROWS_PER_GROUP = 30
const MATERIAL_TOP_ROWS = 120
const PRODUCT_TOP_ROWS = 100
const EDGE_ROWS = 20

export interface TablePreprocessResult {
  text: string
  applied: boolean
  mode: 'original' | 'profile' | 'material' | 'product'
  originalRows: number
  retainedRows: number
  confidence: 'high' | 'fallback'
  canSkipModel: boolean
  processingSource: 'original' | 'local_table'
}

const fallbackResult = (text: string, originalRows = 0): TablePreprocessResult => ({
  text,
  applied: false,
  mode: 'original',
  originalRows,
  retainedRows: originalRows,
  confidence: 'fallback',
  canSkipModel: false,
  processingSource: 'original'
})

function cleanCell(value: unknown, header = ''): string {
  const raw = String(value ?? '').replace(/\u0000/gu, '').trim()
  const limit = /文案|脚本|内容|备注/u.test(header) ? 2_000 : 1_200
  return raw.length > limit ? `${raw.slice(0, limit)}…（单元格已截断）` : raw
}

function numericValue(value: string): number | null {
  const clean = value.replace(/[,，￥¥$\s]/gu, '')
  const match = clean.match(/-?\d+(?:\.\d+)?/u)
  if (!match) return null
  let parsed = Number(match[0])
  if (!Number.isFinite(parsed)) return null
  if (/亿/u.test(clean)) parsed *= 100_000_000
  else if (/万/u.test(clean)) parsed *= 10_000
  if (/%/u.test(clean)) parsed /= 100
  return parsed
}

function firstTableBlock(text: string): string {
  const lines = text.split(/\r?\n/u)
  const firstData = lines.findIndex((line) => line.trim() && !/^###\s*工作表/u.test(line.trim()))
  return firstData > 0 ? lines.slice(firstData).join('\n') : text
}

function parsedRows(text: string): string[][] | null {
  const block = firstTableBlock(text)
  const firstLine = block.split(/\r?\n/u).find((line) => line.trim()) || ''
  const delimiter = firstLine.includes('\t') ? '\t' : firstLine.includes(',') ? ',' : undefined
  const parsed = Papa.parse<string[]>(block, {
    skipEmptyLines: 'greedy',
    dynamicTyping: false,
    ...(delimiter ? { delimiter } : {})
  })
  // PapaParse may emit a delimiter-detection warning for very long CSV cells even
  // when the first row gives us a reliable separator. Malformed quoting is the
  // unsafe case; delimiter warnings alone should not disable preprocessing.
  if (parsed.errors.some((error) => error.type === 'Quotes')) return null
  const rows = parsed.data
    .map((row) => row.map((cell) => cleanCell(cell)))
    .filter((row) => row.some(Boolean))
  if (rows.length < 2) return null
  const width = Math.max(...rows.map((row) => row.length))
  if (width < 2 || width > 200) return null
  const activeColumns = Array.from({ length: width }, (_, index) => index).filter((index) =>
    rows.some((row) => Boolean(row[index]?.trim()))
  )
  const compact = rows.map((row) => activeColumns.map((index) => row[index] || ''))
  const [header, ...body] = compact
  const seen = new Set<string>()
  const uniqueBody = body.filter((row) => {
    const key = JSON.stringify(row)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return [header, ...uniqueBody]
}

function uselessGeneratedColumn(header: string): boolean {
  const normalized = header.trim()
  return (
    !normalized ||
    /思考过程/u.test(normalized) ||
    /^(?:豆包|标签分析|视角分析)(?:\.|$)/u.test(normalized) ||
    /^(?:内容形式)\.(?:输出结果|思考过程)$/u.test(normalized)
  )
}

const PRODUCT_FIELD_PATTERNS = [
  /^统计周期$/u,
  /^(?:商品名称|商品编码|SKU|货品|载体|品类|自卖\/合作)$/u,
  /^(?:结算金额|成交金额|净成交金额|用户支付金额|退款后用户支付金额.*)$/u,
  /^(?:成交订单数|净成交订单数|退款后成交订单数.*|成交件数|成交人数|成交客单价)$/u,
  /^投放消耗/u,
  /^投放贡献成交/u,
  /^投放效率/u,
  /^(?:商品曝光人数|商品点击人数|商品曝光次数|商品点击次数)$/u,
  /^(?:曝光点击率|曝光支付率|点击支付率).*/u,
  /^(?:退款金额|成交退款金额|退款订单数|退款人数|退款件数|退款率|发货前退款率|发货后退款率).*/u,
  /^(?:加购人数|访问加购转化率|加购支付转化率)$/u,
  /^(?:评价好评率|好评数|商品差评率|评价差评率|投诉工单量|投诉率)$/u
]

function usefulProductColumn(header: string, index: number): boolean {
  if (index < 3) return true
  return PRODUCT_FIELD_PATTERNS.some((pattern) => pattern.test(header.trim()))
}

function selectColumns(rows: string[][], indexes: number[]): string[][] {
  return rows.map((row, rowIndex) =>
    indexes.map((index) => cleanCell(row[index] || '', rowIndex === 0 ? '' : rows[0][index] || ''))
  )
}

function scoreIndex(headers: string[], patterns: RegExp[]): number {
  for (const pattern of patterns) {
    const index = headers.findIndex((header) => pattern.test(header))
    if (index >= 0) return index
  }
  return -1
}

function takeRankedRows(body: string[][], scoreAt: number, top: number): string[][] {
  const indexed = body.map((row, index) => ({ row, index, score: numericValue(row[scoreAt] || '') }))
  const withScore = indexed.filter((item) => item.score !== null)
  if (!withScore.length) return []
  const selected = new Set<number>()
  withScore
    .sort((a, b) => (b.score || 0) - (a.score || 0) || a.index - b.index)
    .slice(0, top)
    .forEach((item) => selected.add(item.index))
  // A blank metric is not evidence that the row is unimportant. Preserve those
  // rows so preprocessing never discards records it cannot rank reliably.
  indexed.filter((item) => item.score === null).forEach((item) => selected.add(item.index))
  indexed.slice(0, EDGE_ROWS).forEach((item) => selected.add(item.index))
  indexed.slice(-EDGE_ROWS).forEach((item) => selected.add(item.index))
  return indexed.filter((item) => selected.has(item.index)).map((item) => item.row)
}

function profileRows(headers: string[], body: string[][]): string[][] {
  const groupAt = scoreIndex(headers, [/标签类型/u, /维度/u, /分类/u])
  const metricAt = scoreIndex(headers, [/占比/u, /比例/u, /份额/u])
  if (groupAt < 0 || metricAt < 0) return []
  const groups = new Map<string, { row: string[]; index: number; score: number | null }[]>()
  body.forEach((row, index) => {
    const group = row[groupAt]?.trim() || '未分类'
    const list = groups.get(group) || []
    list.push({ row, index, score: numericValue(row[metricAt] || '') })
    groups.set(group, list)
  })
  const selected: { row: string[]; index: number }[] = []
  for (const list of groups.values()) {
    list
      .sort((a, b) => (b.score ?? Number.NEGATIVE_INFINITY) - (a.score ?? Number.NEGATIVE_INFINITY) || a.index - b.index)
      .slice(0, PROFILE_ROWS_PER_GROUP)
      .forEach((item) => selected.push(item))
  }
  return selected.sort((a, b) => a.index - b.index).map((item) => item.row)
}

function evidenceSummary(headers: string[], body: string[][]): string[] {
  const lines = [`保留字段（${headers.length} 个）：${headers.slice(0, 40).join('、')}${headers.length > 40 ? '等' : ''}`]
  const numeric: string[] = []
  for (let column = 0; column < headers.length && numeric.length < 8; column++) {
    const header = headers[column] || `第${column + 1}列`
    if (/时间|日期|编码|编号|ID/u.test(header)) continue
    const values = body
      .map((row) => ({ raw: row[column]?.trim() || '', value: numericValue(row[column] || '') }))
      .filter((item) => item.raw)
    const measured = values.filter((item): item is { raw: string; value: number } => item.value !== null)
    if (measured.length < 2 || measured.length / Math.max(1, values.length) < 0.6) continue
    const ordered = measured.slice().sort((a, b) => a.value - b.value)
    numeric.push(`${header}：${ordered[0].raw} 至 ${ordered[ordered.length - 1].raw}`)
  }
  if (numeric.length) lines.push(`真实数值范围：${numeric.join('；')}`)

  const categories: string[] = []
  for (let column = 0; column < headers.length && categories.length < 5; column++) {
    const header = headers[column] || ''
    if (!/标签类型|分类|品类|载体|素材类型|视角|内容形式|人群/u.test(header)) continue
    const values = body.map((row) => row[column]?.trim() || '').filter(Boolean)
    const counts = new Map<string, number>()
    values.forEach((value) => counts.set(value, (counts.get(value) || 0) + 1))
    if (counts.size < 2 || counts.size > 20 || values.length < 3) continue
    const top = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'))
      .slice(0, 5)
      .map(([value, count]) => `${value} ${count}行(${((count / values.length) * 100).toFixed(1)}%)`)
    categories.push(`${header}：${top.join('、')}`)
  }
  if (categories.length) lines.push(`记录分类占比：${categories.join('；')}`)
  return lines
}

function buildDigest(
  mode: Exclude<TablePreprocessResult['mode'], 'original'>,
  headers: string[],
  body: string[][],
  retained: string[][]
): string {
  const omitted = Math.max(0, body.length - retained.length)
  const modeLabel = mode === 'profile' ? '成交画像' : mode === 'material' ? '素材数据' : '商品数据'
  const note = [
    `【本机表格预处理】已识别为${modeLabel}，原始有效记录 ${body.length} 行，发送模型 ${retained.length} 行。`,
    omitted
      ? `省略 ${omitted} 行重复或低优先级记录；原始文件仍完整保存在项目中。模型不得把省略部分推测为事实。`
      : '未省略有效记录。',
    mode === 'profile'
      ? `画像按标签类型保留每类占比前 ${PROFILE_ROWS_PER_GROUP} 项。`
      : `优先保留真实成交、销售、订单、消耗或播放指标靠前的记录，并保留表格首尾各 ${EDGE_ROWS} 行。`,
    ...evidenceSummary(headers, body)
  ].join('\n')
  return `${note}\n\n${Papa.unparse([headers, ...retained], { newline: '\n' })}`
}

export function preprocessTableForModel(text: string): TablePreprocessResult {
  const rows = parsedRows(text)
  if (!rows) return fallbackResult(text)
  let [headers, ...body] = rows
  const parsedOriginalRows = body.length
  const headerText = headers.join('|')
  const hasSemanticField = headers.some((header) =>
    /文案|脚本|正文|评论|评价内容|内容详情|标题|描述|备注|话术|口播|字幕|3秒/u.test(header.trim())
  )
  const canonical = Papa.unparse([headers, ...body], { newline: '\n' })
  if (text.length <= TABLE_PREPROCESS_THRESHOLD) {
    const workbookMarkers = text.match(/^###\s*工作表/gmu)?.length || 0
    const normalizedHeaders = headers.map((header) => header.trim())
    const uniqueHeaders = new Set(normalizedHeaders)
    const repeatedHeader = body.some((row) =>
      row.length === headers.length && row.every((cell, index) => cell.trim() === normalizedHeaders[index])
    )
    const structurallyReliable =
      body.length > 0 &&
      headers.length <= 50 &&
      normalizedHeaders.every(Boolean) &&
      uniqueHeaders.size === normalizedHeaders.length &&
      workbookMarkers <= 1 &&
      !repeatedHeader
    const canSkipModel = structurallyReliable && !hasSemanticField && canonical.length <= LOCAL_TABLE_MAX_CHARS
    return {
      text: canonical,
      applied: canonical !== text,
      mode: 'original',
      originalRows: parsedOriginalRows,
      retainedRows: body.length,
      confidence: canSkipModel ? 'high' : 'fallback',
      canSkipModel,
      processingSource: canSkipModel ? 'local_table' : 'original'
    }
  }
  let mode: TablePreprocessResult['mode'] = 'original'
  let retained: string[][] = []

  if (/(?:标签类型|维度).*(?:占比|比例)|(?:占比|比例).*(?:标签类型|维度)/u.test(headerText)) {
    mode = 'profile'
    retained = profileRows(headers, body)
  } else if (/3秒|文案|素材|视角|内容形式/u.test(headerText)) {
    mode = 'material'
    const keep = headers.map((header, index) => ({ header, index })).filter(({ header }) => !uselessGeneratedColumn(header))
    const indexes = keep.map(({ index }) => index)
    ;[headers, ...body] = selectColumns([headers, ...body], indexes)
    const scoreAt = scoreIndex(headers, [/成交金额|成交|GMV|销售额/u, /消耗金额|消耗/u, /销量|订单/u, /播放/u])
    retained = scoreAt >= 0 ? takeRankedRows(body, scoreAt, MATERIAL_TOP_ROWS) : []
  } else if (/商品|SKU|货品/u.test(headerText)) {
    mode = 'product'
    const keep = headers
      .map((header, index) => ({ header, index }))
      .filter(({ header, index }) => !uselessGeneratedColumn(header) && usefulProductColumn(header, index))
    const indexes = keep.map(({ index }) => index)
    ;[headers, ...body] = selectColumns([headers, ...body], indexes)
    const scoreAt = scoreIndex(headers, [/成交金额|GMV|销售额|支付金额/u, /销量|订单|成交件数/u, /消耗/u])
    retained = scoreAt >= 0 ? takeRankedRows(body, scoreAt, PRODUCT_TOP_ROWS) : []
  }

  if (mode === 'original' || !retained.length) {
    return fallbackResult(text, parsedOriginalRows)
  }
  const digest = buildDigest(mode, headers, body, retained)
  if (digest.length >= text.length * 0.95) {
    return fallbackResult(text, parsedOriginalRows)
  }
  // 超长表格的摘要可能省略记录，只用于降低模型输入，不能直接替代模型清洗。
  return {
    text: digest,
    applied: true,
    mode,
    originalRows: parsedOriginalRows,
    retainedRows: retained.length,
    confidence: 'fallback',
    canSkipModel: false,
    processingSource: 'local_table'
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
  const attribution = metadataValue(source.attribution, '自有数据')
  const platform = metadataValue(source.platform, '需补充')
  const purpose = metadataValue(source.purpose, '结构化表格数据')
  const note = source.note?.trim() ? `\n用户补充：${source.note.trim()}` : ''
  const detail = [
    `分类：${attribution} | ${platform} | ${purpose} | 需从表格字段确认 | 表格 | 已在本机完成空行、空列与重复行清理，共 ${result.retainedRows} 条有效记录`,
    '',
    '## 清洗后内容',
    `来源文件：${source.name}`,
    '处理方式：本机高可信结构化清洗（未调用模型）',
    `来源归属：${attribution}；平台/来源：${platform}；信息类型：${purpose}${note}`,
    '以下内容只来自原表格；未出现的信息不得推测：',
    '',
    result.text
  ].join('\n')
  return detail.length <= LOCAL_TABLE_MAX_CHARS ? detail : null
}

export function sourceForModel(source: SourceCleanCacheInput): SourceCleanCacheInput {
  if (source.kind !== 'table' || !source.text) return source
  const result = preprocessTableForModel(source.text)
  return result.applied ? { ...source, text: result.text } : source
}

export const tablePreprocessInternals = {
  TABLE_PREPROCESS_THRESHOLD,
  LOCAL_TABLE_MAX_CHARS,
  PROFILE_ROWS_PER_GROUP,
  MATERIAL_TOP_ROWS,
  PRODUCT_TOP_ROWS,
  numericValue
}
