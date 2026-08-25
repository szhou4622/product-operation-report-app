import type {
  HtmlReportModel,
  HtmlReportSection,
  HtmlReportTable
} from './htmlReportModel'

export type HtmlReportVisualKind =
  | 'priority-lanes'
  | 'source-ledger'
  | 'product-facts'
  | 'percent-facets'
  | 'material-methods'
  | 'selling-point-matrix'
  | 'selling-strategy'
  | 'voc-insights'
  | 'ordinal-path'
  | 'audience-map'
  | 'content-mix'
  | 'execution-matrix'
  | 'action-roadmap'
  | 'limitations'
  | 'summary-only'

export interface HtmlReportSourceRef {
  sectionNumber: string
  tableIndex: number | null
  rowIndex: number | null
  columnIndex: number | null
  context: string
  rawValue: string
}

export interface HtmlReportMetricPresentation {
  label: string
  value: string
  sourceLabel: string
  source: HtmlReportSourceRef
}

export interface HtmlReportPriorityPresentation {
  rank: string
  audience: string
  judgment: string
  source: HtmlReportSourceRef
}

export interface HtmlReportTablePresentation {
  tableIndex: number
  mode: 'visible' | 'collapsed'
  rowCount: number
  columnCount: number
}

export interface HtmlReportPercentItemPresentation {
  label: string
  value: number
  display: string
  source: HtmlReportSourceRef
}

export interface HtmlReportPercentFacetPresentation {
  context: string
  group: string
  mode: 'stat' | 'bars'
  items: HtmlReportPercentItemPresentation[]
}

export interface HtmlReportContentMixPresentation {
  mode: 'stacked' | 'mainline'
  tableIndex: number
  items: Array<{
    label: string
    detail: string
    value: number | null
    source: HtmlReportSourceRef
  }>
}

export interface HtmlReportKeywordCloudItemPresentation {
  label: string
  count: number
  weight: 1 | 2 | 3 | 4 | 5
  sources: HtmlReportSourceRef[]
}

export interface HtmlReportKeywordCloudPresentation {
  title: string
  tableIndex: number
  totalOccurrences: number
  items: HtmlReportKeywordCloudItemPresentation[]
}

export interface HtmlReportDistributionItemPresentation {
  label: string
  value: number
  sources: HtmlReportSourceRef[]
}

export interface HtmlReportDistributionPresentation {
  title: string
  total: number
  unit: string
  totalSources: HtmlReportSourceRef[]
  items: HtmlReportDistributionItemPresentation[]
}

export interface HtmlReportSectionPresentation {
  sectionNumber: string
  visualKind: HtmlReportVisualKind
  visualSourceTableIndexes: number[]
  visualSources: HtmlReportSourceRef[]
  percentFacets: HtmlReportPercentFacetPresentation[]
  contentMix: HtmlReportContentMixPresentation | null
  keywordCloud: HtmlReportKeywordCloudPresentation | null
  executionDistributions: HtmlReportDistributionPresentation[]
  tables: HtmlReportTablePresentation[]
}

export interface HtmlReportPresentation {
  thesis: string
  primaryAudience: HtmlReportPriorityPresentation | null
  mainMetric: HtmlReportMetricPresentation | null
  supportingSignals: HtmlReportMetricPresentation[]
  priorities: HtmlReportPriorityPresentation[]
  sections: HtmlReportSectionPresentation[]
}

interface MetricCandidate extends HtmlReportMetricPresentation {
  score: number
}

const PLACEHOLDER_PATTERN = /需补充|待补证|待确认|未知|unknown|not available|n\/a/i
const RANGE_PATTERN =
  /[+-]?\d+(?:\.\d+)?\s*(?:-|–|—|~|～|至|到)\s*[+-]?\d+(?:\.\d+)?\s*(?:%|亿元|万元|万|元|人|条|件|单|次|倍|岁|个|款)?/i
const METRIC_PATTERN =
  /(?:ROI\s*[：:]?\s*)?[+-]?\d+(?:\.\d+)?\s*(?:%|亿元|万元|万|元|人|条|件|单|次|倍|个|款)/gi
const HAS_METRIC_PATTERN =
  /(?:ROI\s*[：:]?\s*)?[+-]?\d+(?:\.\d+)?\s*(?:%|亿元|万元|万|元|人|条|件|单|次|倍|个|款)/i
const PLATFORM_TERM_PATTERN =
  /巨量云图|微信小店|示例平台|视频号|抖音|快手|小红书|淘宝|天猫|京东|拼多多|抖店|千川|云图/g
const DISTRIBUTION_CONTEXT_PATTERN =
  /成交人群|购买画像|人群|性别|年龄|地域|地区|城市线级|用户构成|内容构成|素材结构|来源构成|类目构成|占比分布|分布/
const KEYWORD_STOP_WORDS = new Set(
  [
    '产品',
    '用户',
    '卖点',
    '场景',
    '我方',
    '已见',
    '包括',
    '表达',
    '可以',
    '适合',
    '使用',
    '以及',
    '对应',
    '主要',
    '当前',
    '信息',
    '更有',
    '感知',
    '进行',
    '好处',
    '人群',
    '素材',
    '补充',
    '具体',
    '机制',
    '品牌',
    '需要',
    '已经',
    '目前',
    '这个',
    '这种',
    '一个',
    '通过',
    '相关',
    '作为',
    '用于',
    '建议',
    '说明',
    '内容',
    '方向',
    '核心',
    '重点',
    '表现',
    '比较',
    '更加',
    '维度',
    '资料',
    '数据',
    '分析',
    '判断',
    '中有',
    '即可',
    '一次',
    '一袋',
    '部分',
    '记载',
    '出现',
    '来源',
    '证据',
    '文件',
    '表格',
    '数据表',
    '服务',
    '项目',
    '知道',
    '视频',
    '图片',
    '文档',
    '记录',
    '画像',
    '成交',
    '购买',
    '平台',
    '截图',
    '页面',
    '原始',
    '手卡',
    '核验',
    '规格',
    'csv',
    'tsv',
    'xlsx',
    'xls',
    'pptx',
    'ppt',
    'docx',
    'doc',
    'pdf',
    'txt',
    'markdown',
    'html',
    'zip',
    'top1',
    'top2',
    'top3',
    'top4',
    'top5',
    'top6',
    'top7',
    'top8',
    'top9',
    'top10'
  ].map((item) => item.toLocaleLowerCase('zh-CN'))
)

function text(value: string): string {
  return value
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function shorten(value: string, max: number): string {
  const normalized = text(value)
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized
}

function findHeaderIndex(table: HtmlReportTable, pattern: RegExp): number {
  return table.headers.findIndex((header) => pattern.test(text(header)))
}

function tableMatches(table: HtmlReportTable, patterns: RegExp[]): boolean {
  return patterns.every((pattern) => table.headers.some((header) => pattern.test(text(header))))
}

function parseStrictPercent(value: string): number | null {
  const match = text(value).match(/^(\d+(?:\.\d+)?)\s*%$/)
  if (!match) return null
  const number = Number(match[1])
  return Number.isFinite(number) && number >= 0 && number <= 100 ? number : null
}

function platformTerms(value: string): string[] {
  return Array.from(new Set(text(value).match(PLATFORM_TERM_PATTERN) || []))
}

function distributionDimension(value: string): string {
  const normalized = text(value)
  if (/^(?:男|女|男性|女性)$/.test(normalized)) return 'gender'
  if (
    /\d+\s*(?:-|–|—|~|～|至|到)\s*\d+\s*岁?|岁以上|岁以下|银发|中年|青年|年轻|老年/.test(
      normalized
    )
  ) {
    return 'age'
  }
  if (/一线|二线|三线|四线|五线|城市|城镇|乡镇|省|市|地区|地域/.test(normalized)) {
    return 'region'
  }
  if (/已婚|未婚|已育|未育|婚育/.test(normalized)) return 'marriage'
  if (/高消费|中消费|低消费|消费层级/.test(normalized)) return 'consumption'
  return ''
}

function sourceRef(
  section: HtmlReportSection,
  tableIndex: number,
  rowIndex: number,
  columnIndex: number
): HtmlReportSourceRef {
  const table = section.tables[tableIndex]
  return {
    sectionNumber: section.number,
    tableIndex,
    rowIndex,
    columnIndex,
    context: table.context,
    rawValue: table.rows[rowIndex]?.[columnIndex] || ''
  }
}

function buildStrictPercentFacets(section: HtmlReportSection): HtmlReportPercentFacetPresentation[] {
  return section.tables.flatMap((table, tableIndex) => {
    const platformIndex = findHeaderIndex(table, /平台|渠道|数据来源|来源/)
    if (
      platformIndex < 0 &&
      (platformTerms(table.context).length !== 1 ||
        !DISTRIBUTION_CONTEXT_PATTERN.test(text(table.context)))
    ) {
      return []
    }
    const dimensionIndex = table.headers.findIndex(
      (header, index) =>
        index !== platformIndex &&
        /^(?:(?:指标|画像|人群)?维度|分组|属性|指标类型)$/.test(text(header))
    )
    const categoryIndex = table.headers.findIndex(
      (header, index) =>
        index !== platformIndex &&
        index !== dimensionIndex &&
        /类别|人群|名称|标签|细分|选项|区间/.test(text(header))
    )
    const labelIndex = categoryIndex >= 0 ? categoryIndex : table.headers.findIndex(
      (header, index) =>
        index !== platformIndex && /维度|人群|类别|指标|名称|内容主线/.test(text(header))
    )
    const percentIndexes = table.headers
      .map((_, index) => index)
      .filter(
        (index) =>
          index !== platformIndex &&
          /占比|比例|数据|率|份额|渗透/.test(text(table.headers[index] || '')) &&
          table.rows.filter((row) => parseStrictPercent(row[index] || '') !== null).length >= 2
      )
    return percentIndexes.flatMap((valueIndex) => {
      const descriptiveIndexes = table.headers
        .map((header, index) => ({ header: text(header), index }))
        .filter(
          ({ header, index }) =>
            index !== platformIndex &&
            index !== valueIndex &&
            !/经营含义|说明|备注|建议|用途|限制|原因|判断|结论/.test(header)
        )
        .map(({ index }) => index)
      if (
        descriptiveIndexes.length > 1 &&
        (dimensionIndex < 0 || categoryIndex < 0)
      ) {
        return []
      }
      const rowsByGroup = new Map<
        string,
        {
          platform: string
          dimension: string
          rows: Array<{ row: string[]; rowIndex: number }>
        }
      >()
      table.rows.forEach((row, rowIndex) => {
        if (!row.some((cell) => Boolean(text(cell)))) return
        const platform = platformIndex >= 0 ? text(row[platformIndex] || '未标明来源') : ''
        const dimension =
          dimensionIndex >= 0 && dimensionIndex !== labelIndex
            ? text(row[dimensionIndex] || '未标明维度')
            : ''
        const key = `${platform}\u0000${dimension}`
        const group = rowsByGroup.get(key) || { platform, dimension, rows: [] }
        group.rows.push({ row, rowIndex })
        rowsByGroup.set(key, group)
      })
      return Array.from(rowsByGroup.values())
        .map(({ platform, dimension, rows }) => {
          const items = rows.map(({ row, rowIndex }) => {
            const value = parseStrictPercent(row[valueIndex] || '')
            const fallbackLabelIndex = row.findIndex(
              (cell, index) =>
                index !== platformIndex && index !== valueIndex && Boolean(text(cell))
            )
            const resolvedLabelIndex =
              labelIndex >= 0 && labelIndex !== valueIndex ? labelIndex : fallbackLabelIndex
            const rawLabel = text(row[resolvedLabelIndex] || '')
            if (
              (categoryIndex >= 0 && !rawLabel) ||
              /占|其中|分母|率|比例|份额|渗透|转化|复购|点击|客单|ROI|GMV|成交额|销售额|金额|订单量|用户数/i.test(
                rawLabel
              ) ||
              /^(?:性别|年龄|地域|地区|城市线级|婚育|消费层级|人群)$/.test(rawLabel) ||
              (platformIndex < 0 && platformTerms(rawLabel).length > 0)
            ) {
              return null
            }
            return value === null
              ? null
              : {
                  label: shorten(rawLabel || '数据', 34),
                  value,
                  display: shorten(row[valueIndex] || '', 20),
                  source: sourceRef(section, tableIndex, rowIndex, valueIndex)
                }
          })
          if (items.some((item) => item === null)) return null
          const completeItems = items.filter(
            (item): item is HtmlReportPercentItemPresentation => Boolean(item)
          )
          if (completeItems.length < 2 || completeItems.length > 8) return null
          if (new Set(completeItems.map((item) => item.label)).size !== completeItems.length) {
            return null
          }
          if (dimensionIndex < 0) {
            const inferred = completeItems.map((item) => distributionDimension(item.label))
            const known = Array.from(new Set(inferred.filter(Boolean)))
            if (known.length > 1 || (known.length === 1 && inferred.some((value) => !value))) {
              return null
            }
            if (known.length === 0 && !DISTRIBUTION_CONTEXT_PATTERN.test(text(table.context))) {
              return null
            }
          }
          const conciseV1 = section.number === 'M2'
          return {
            context: conciseV1
              ? dimension || table.context || text(table.headers[valueIndex] || '数据')
              : [table.context, platform, dimension, text(table.headers[valueIndex] || '')].filter(Boolean).join(' · '),
            group: conciseV1
              ? platform || table.context || '分平台数据'
              : [table.context, platform].filter(Boolean).join(' · '),
            mode: 'bars' as const,
            items: completeItems
          }
        })
        .filter((facet): facet is NonNullable<typeof facet> => Boolean(facet))
    })
  })
}

const INLINE_DISTRIBUTION_DIMENSION_PATTERN =
  /^(?:性别|年龄|婚育|人群标签|地域|地区|家庭结构|消费层级|城市线级)$/
const INLINE_PERCENT_SEGMENT_PATTERN = /^(.+?)\s*(\d+(?:\.\d+)?)\s*%$/

function parseInlinePercentItems(
  rawValue: string
): Array<{ label: string; value: number; display: string }> {
  const normalized = text(rawValue)
  if (!normalized || /约|近|超过|不足|以上占比|合计|大约/.test(normalized)) return []
  const segments = normalized
    .split(/[，,、；;]/)
    .map((segment) => segment.trim())
    .filter(Boolean)
  if (segments.length === 0 || segments.length > 6) return []
  const items = segments.map((segment) => {
    const match = segment.match(INLINE_PERCENT_SEGMENT_PATTERN)
    if (!match) return null
    const value = Number(match[2])
    const label = text(match[1])
      .replace(/^(?:其中|约)\s*/, '')
      .replace(/[：:]$/, '')
      .trim()
    if (
      !label ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 100 ||
      /复购|转化|点击|客单|ROI|GMV|成交额|销售额|金额|订单/.test(label)
    ) {
      return null
    }
    return {
      label: shorten(label, 30),
      value,
      display: `${match[2]}%`
    }
  })
  if (items.some((item) => item === null)) return []
  const completeItems = items.filter(
    (item): item is { label: string; value: number; display: string } => Boolean(item)
  )
  if (new Set(completeItems.map((item) => item.label)).size !== completeItems.length) return []
  return completeItems
}

function buildInlinePercentFacets(
  section: HtmlReportSection
): HtmlReportPercentFacetPresentation[] {
  return section.tables.flatMap((table, tableIndex) => {
    if (
      platformTerms(table.context).length !== 1 ||
      !DISTRIBUTION_CONTEXT_PATTERN.test(text(table.context))
    ) {
      return []
    }
    const dimensionIndex = table.headers.findIndex((header) =>
      /^(?:维度|画像维度|人群维度)$/.test(text(header))
    )
    const valueIndex = table.headers.findIndex(
      (header) => /关键数据|占比数据|人群数据/.test(text(header)) && !/经营含义/.test(text(header))
    )
    const categoryIndex = table.headers.findIndex((header) =>
      /类别|选项|区间|细分/.test(text(header))
    )
    if (dimensionIndex < 0 || valueIndex < 0 || categoryIndex >= 0) return []
    return table.rows.flatMap((row, rowIndex) => {
      const dimension = text(row[dimensionIndex] || '')
      if (!INLINE_DISTRIBUTION_DIMENSION_PATTERN.test(dimension)) return []
      const parsedItems = parseInlinePercentItems(row[valueIndex] || '')
      if (parsedItems.length === 0) return []
      return [
        {
          context: dimension,
          group: table.context || `第 ${section.number} 章`,
          mode: parsedItems.length === 1 ? ('stat' as const) : ('bars' as const),
          items: parsedItems.map((item) => ({
            ...item,
            source: sourceRef(section, tableIndex, rowIndex, valueIndex)
          }))
        }
      ]
    })
  })
}

function buildPercentFacets(section: HtmlReportSection): HtmlReportPercentFacetPresentation[] {
  return [...buildStrictPercentFacets(section), ...buildInlinePercentFacets(section)]
}

function buildContentMix(section: HtmlReportSection): HtmlReportContentMixPresentation | null {
  for (let tableIndex = 0; tableIndex < section.tables.length; tableIndex++) {
    const table = section.tables[tableIndex]
    const ratioIndex = findHeaderIndex(table, /建议占比/)
    if (ratioIndex < 0) continue
    const nonEmptyRows = table.rows
      .map((row, rowIndex) => ({ row, rowIndex }))
      .filter(({ row }) => row.some((cell) => Boolean(text(cell))))
    const parsed = nonEmptyRows.map(({ row, rowIndex }) => {
      const value = parseStrictPercent(row[ratioIndex] || '')
      return value === null
        ? null
        : {
            label: shorten(row[0] || '内容主线', 34),
            detail: '',
            value,
            source: sourceRef(section, tableIndex, rowIndex, ratioIndex)
          }
    })
    const items = parsed.filter(
      (item): item is NonNullable<(typeof parsed)[number]> => Boolean(item)
    )
    const total = items.reduce((sum, item) => sum + item.value, 0)
    if (
      nonEmptyRows.length >= 2 &&
      nonEmptyRows.length <= 6 &&
      parsed.every(Boolean) &&
      Math.abs(total - 100) < 0.01
    ) {
      return { mode: 'stacked', tableIndex, items }
    }
  }
  const tableIndex = section.tables.findIndex((table) =>
    tableMatches(table, [/内容主线/, /对应人群/])
  )
  if (tableIndex < 0) return null
  const table = section.tables[tableIndex]
  const rows = table.rows
    .map((row, rowIndex) => ({ row, rowIndex }))
    .filter(({ row }) => row.some((cell) => Boolean(text(cell))))
    .slice(0, 5)
  if (rows.length === 0) return null
  return {
    mode: 'mainline',
    tableIndex,
    items: rows.map(({ row, rowIndex }) => ({
      label: shorten(row[0] || '', 42),
      detail: shorten(row[2] || row[1] || '', 78),
      value: null,
      source: sourceRef(section, tableIndex, rowIndex, 0)
    }))
  }
}

function keywordTokens(value: string): string[] {
  let normalized = text(value)
    .replace(/(?:来源|对应证据|证据(?:ID|编号)?|数据来源)[：:][\s\S]*$/u, '')
    .replace(/https?:\/\/\S+/giu, ' ')
    .replace(/[^\s，,；;。]*\.(?:csv|tsv|xlsx?|pptx?|docx?|pdf|txt|md|markdown|html?|zip)\b/giu, ' ')
  if (!normalized || /^(?:需补充|待补证|待确认|未知|暂无)[。.!！\s]*$/u.test(normalized)) return []
  normalized = normalized.replace(/需补充|待补证|待确认|未知|暂无/gu, ' ')
  const phrasePatterns = [
    /免[\p{Script=Han}]{1,4}/gu,
    /(?:不|低|少|减)[\p{Script=Han}\d.%]{1,7}/gu,
    /[\p{Script=Han}]{1,7}(?:益生菌|发酵|萃取|烘焙|冻干|压榨|直投|芥菜|原料|材质|面料)/gu,
    /[鲜脆爽酸香甜咸辣糯软酥]{2,6}/gu,
    /\d+(?:\.\d+)?(?:天|小时|个月|年|%)(?:恒温|低温|自然)?(?:发酵|熟成|腌制|烘焙)?/gu
  ]
  const phrases = phrasePatterns
    .flatMap((pattern) => normalized.match(pattern) || [])
    .map((phrase) => phrase.trim())
    .filter((phrase) => phrase.length >= 2 && phrase.length <= 14)
  const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' })
  const words = Array.from(segmenter.segment(normalized))
    .filter((segment) => segment.isWordLike)
    .map((segment) => segment.segment.trim())
    .filter((token) => {
      if (!/^(?:[\p{Script=Han}]{2,8}|[A-Za-z][A-Za-z0-9.+-]{1,15})$/u.test(token)) return false
      const normalizedToken = token.toLocaleLowerCase('zh-CN')
      return (
        !KEYWORD_STOP_WORDS.has(normalizedToken) &&
        !/^\d/.test(normalizedToken) &&
        !/文件|数据|来源|服务|项目|视频|图片|文档|记录|画像|成交|购买|证据|平台|补证|核验/u.test(token)
      )
    })
  return Array.from(new Set([...phrases, ...words])).filter((token) => {
    const normalizedToken = token.toLocaleLowerCase('zh-CN')
    return (
      !KEYWORD_STOP_WORDS.has(normalizedToken) &&
      !/文件|数据|来源|服务|项目|视频|图片|文档|记录|画像|成交|购买|证据|平台|补证|核验/u.test(token)
    )
  })
}

function buildKeywordCloud(section: HtmlReportSection): HtmlReportKeywordCloudPresentation | null {
  const tableIndex = section.tables.findIndex((table) =>
    tableMatches(table, [/卖点维度/, /我方产品卖点/])
  )
  if (tableIndex < 0) return null
  const table = section.tables[tableIndex]
  const sellingPointColumns = table.headers
    .map((header, index) => ({ header: text(header), index }))
    .filter(({ header, index }) =>
      index > 0 &&
      /(?:我方|产品|核心|主要|原始|可用).*卖点|卖点(?:原文|表达|内容)?/u.test(header) &&
      !/好处|证据|来源|依据|限制|备注|补充|状态|维度/u.test(header)
    )
    .map(({ index }) => index)
  if (sellingPointColumns.length === 0) return null
  if (section.number === 'M5' || (section.number === 'M4' && /卖点/u.test(section.title))) {
    const columnIndex = sellingPointColumns[0]
    const ordered = new Map<string, { label: string; count: number; sources: HtmlReportSourceRef[] }>()
    table.rows.forEach((row, rowIndex) => {
      const label = text(row[columnIndex] || '').split('｜')[0].replace(/^TOP\s*\d+\s*/iu, '').trim()
      if (!label || /暂无|需补充|未知/u.test(label)) return
      const key = label.toLocaleLowerCase('zh-CN')
      const current = ordered.get(key) || { label, count: 0, sources: [] }
      current.count += 1
      current.sources.push(sourceRef(section, tableIndex, rowIndex, columnIndex))
      ordered.set(key, current)
    })
    const items = Array.from(ordered.values()).slice(0, 12)
    if (items.length >= 3) {
      return {
        title: '真实卖点清单',
        tableIndex,
        totalOccurrences: items.reduce((sum, item) => sum + item.count, 0),
        items: items.map((item, index) => ({
          ...item,
          weight: Math.max(1, 5 - Math.floor(index / 3)) as 1 | 2 | 3 | 4 | 5
        }))
      }
    }
  }
  const entries = new Map<
    string,
    { label: string; count: number; sources: Map<string, HtmlReportSourceRef> }
  >()
  table.rows.forEach((row, rowIndex) => {
    sellingPointColumns.forEach((columnIndex) => {
      const rawValue = row[columnIndex] || ''
      const source = sourceRef(section, tableIndex, rowIndex, columnIndex)
      keywordTokens(rawValue).forEach((label) => {
        const key = label.toLocaleLowerCase('zh-CN')
        const entry = entries.get(key) || { label, count: 0, sources: new Map() }
        entry.count += 1
        entry.sources.set(`${rowIndex}:${columnIndex}`, source)
        entries.set(key, entry)
      })
    })
  })
  const candidates = Array.from(entries.values())
    .filter((entry) => entry.count >= 2)
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh-CN'))
    .slice(0, 24)
  if (candidates.length < 6) return null
  const min = Math.min(...candidates.map((entry) => entry.count))
  const max = Math.max(...candidates.map((entry) => entry.count))
  const weightFor = (count: number): 1 | 2 | 3 | 4 | 5 => {
    if (max === min) return 3
    return Math.max(1, Math.min(5, Math.round(1 + ((count - min) / (max - min)) * 4))) as
      | 1
      | 2
      | 3
      | 4
      | 5
  }
  return {
    title: '卖点关键词频次',
    tableIndex,
    totalOccurrences: candidates.reduce((sum, entry) => sum + entry.count, 0),
    items: candidates.map((entry) => ({
      label: entry.label,
      count: entry.count,
      weight: weightFor(entry.count),
      sources: Array.from(entry.sources.values())
    }))
  }
}

function buildExecutionDistributions(
  section: HtmlReportSection
): HtmlReportDistributionPresentation[] {
  const tableIndex = section.tables.findIndex((table) =>
    tableMatches(table, [/脚本编号/, /视频分类/, /视角/])
  )
  if (tableIndex < 0) return []
  const table = section.tables[tableIndex]
  const idIndex = findHeaderIndex(table, /脚本编号/)
  const classIndex = findHeaderIndex(table, /视频分类/)
  const perspectiveIndex = findHeaderIndex(table, /视角/)
  if (idIndex < 0 || classIndex < 0 || perspectiveIndex < 0) return []
  const uniqueRows = Array.from(
    new Map(
      table.rows
        .map((row, rowIndex) => ({ row, rowIndex }))
        .filter(({ row }) => Boolean(text(row[idIndex] || '')))
        .map(({ row, rowIndex }) => [text(row[idIndex]), { row, rowIndex }] as const)
    ).values()
  )
  if (uniqueRows.length === 0) return []
  const readClass = (value: string): string =>
    text(value).match(/^(3\.(?:1|2|99))(?:\s|$)/)?.[1] || ''
  const classLabels = ['3.1', '3.2', '3.99']
  const classItems = classLabels.map((label) => {
    const matches = uniqueRows.filter(({ row }) => readClass(row[classIndex] || '') === label)
    return {
      label,
      value: matches.length,
      sources: matches.map(({ rowIndex }) => sourceRef(section, tableIndex, rowIndex, classIndex))
    }
  })
  const otherClasses = uniqueRows.filter(({ row }) => !readClass(row[classIndex] || ''))
  if (otherClasses.length > 0) {
    classItems.push({
      label: '其他分类',
      value: otherClasses.length,
      sources: otherClasses.map(({ rowIndex }) =>
        sourceRef(section, tableIndex, rowIndex, classIndex)
      )
    })
  }

  const perspectiveLabels = ['商家', '用户', '专业']
  const readPerspective = (value: string): string =>
    text(value).replace(/\s+/g, '').replace(/视角$/, '')
  const perspectiveItems = perspectiveLabels.map((label) => {
    const matches = uniqueRows.filter(
      ({ row }) => readPerspective(row[perspectiveIndex] || '') === label
    )
    return {
      label: `${label}视角`,
      value: matches.length,
      sources: matches.map(({ rowIndex }) =>
        sourceRef(section, tableIndex, rowIndex, perspectiveIndex)
      )
    }
  })
  const otherPerspectives = uniqueRows.filter(
    ({ row }) => !perspectiveLabels.includes(readPerspective(row[perspectiveIndex] || ''))
  )
  if (otherPerspectives.length > 0) {
    perspectiveItems.push({
      label: '其他视角',
      value: otherPerspectives.length,
      sources: otherPerspectives.map(({ rowIndex }) =>
        sourceRef(section, tableIndex, rowIndex, perspectiveIndex)
      )
    })
  }
  const totalSources = uniqueRows.map(({ rowIndex }) =>
    sourceRef(section, tableIndex, rowIndex, idIndex)
  )
  return [
    {
      title: '视频分类',
      total: uniqueRows.length,
      unit: '条',
      totalSources,
      items: classItems
    },
    {
      title: '内容视角',
      total: uniqueRows.length,
      unit: '条',
      totalSources,
      items: perspectiveItems
    }
  ]
}

function findVisualSourceIndexes(section: HtmlReportSection, kind: HtmlReportVisualKind): number[] {
  const matches = (predicate: (table: HtmlReportTable) => boolean): number[] =>
    section.tables
      .map((table, index) => (predicate(table) ? index : -1))
      .filter((index) => index >= 0)

  switch (kind) {
    case 'priority-lanes':
      return matches((table) => tableMatches(table, [/优先级/, /核心人群/])).slice(0, 1)
    case 'source-ledger':
      return matches((table) => tableMatches(table, [/数据类型/, /来源/, /本次用途/])).slice(0, 1)
    case 'product-facts':
      return matches((table) => tableMatches(table, [/模块/, /当前判断/])).slice(0, 1)
    case 'percent-facets':
      return Array.from(
        new Set(
          buildPercentFacets(section)
            .flatMap((facet) => facet.items)
            .map((item) => item.source.tableIndex)
            .filter((index): index is number => index !== null)
        )
      )
    case 'material-methods': {
      const percent = findVisualSourceIndexes(section, 'percent-facets')
      if (percent.length) return percent
      return matches(
        (table) =>
          tableMatches(table, [/竞品开头/, /打法本质/]) ||
          tableMatches(table, [/类型/, /(?:原始\s*3\s*秒开头|数据依据)/, /可复用方向/])
      ).slice(0, 3)
    }
    case 'selling-point-matrix':
      return matches((table) => tableMatches(table, [/卖点维度/, /我方产品卖点/])).slice(0, 1)
    case 'selling-strategy':
      return matches((table) =>
        tableMatches(table, [/卖点维度/, /我方产品卖点/]) ||
        tableMatches(table, [/排序/, /真实卖点/])
      ).slice(0, 2)
    case 'voc-insights':
      return matches((table) => tableMatches(table, [/排名/, /需求词/, /频次/, /占比/, /代表原话/])).slice(0, 4)
    case 'ordinal-path':
      return matches((table) => tableMatches(table, [/排序/, /用户视角卖点/])).slice(0, 1)
    case 'audience-map':
      return matches((table) => tableMatches(table, [/成交人群/, /核心卖点/, /核心场景/])).slice(0, 1)
    case 'content-mix': {
      const contentMix = buildContentMix(section)
      return contentMix ? [contentMix.tableIndex] : []
    }
    case 'execution-matrix':
      return matches((table) => tableMatches(table, [/脚本编号/, /视频分类/, /视角/])).slice(0, 1)
    default:
      return []
  }
}

function visualKindForSection(section: HtmlReportSection): HtmlReportVisualKind {
  if (section.number === 'M4' && /卖点/u.test(section.title)) {
    return findVisualSourceIndexes(section, 'selling-strategy').length > 0 ? 'selling-strategy' : 'summary-only'
  }
  if (section.number === 'M5' && /VOC|用户真实需求/iu.test(section.title)) {
    return findVisualSourceIndexes(section, 'voc-insights').length > 0 ? 'voc-insights' : 'summary-only'
  }
  if (section.number === 'M6' && /人群.*卖点.*场景/u.test(section.title)) {
    return findVisualSourceIndexes(section, 'audience-map').length > 0 ? 'audience-map' : 'summary-only'
  }
  const kindBySection: Record<string, HtmlReportVisualKind> = {
    '0': 'priority-lanes',
    '1': 'source-ledger',
    '2': 'product-facts',
    '3': 'percent-facets',
    '4': 'material-methods',
    '5': 'selling-point-matrix',
    '6': 'ordinal-path',
    '7': 'audience-map',
    '8': 'content-mix',
    '9': 'execution-matrix',
    '10': 'action-roadmap',
    '11': 'limitations',
    M1: 'product-facts',
    M2: 'percent-facets',
    M3: 'material-methods',
    M4: 'source-ledger',
    M5: 'selling-point-matrix',
    M6: 'ordinal-path',
    M7: 'ordinal-path',
    M8: 'audience-map'
  }
  const preferred = kindBySection[section.number] || 'summary-only'
  if (preferred === 'action-roadmap' || preferred === 'limitations') {
    return section.listItems.length > 0 ? preferred : 'summary-only'
  }
  return findVisualSourceIndexes(section, preferred).length > 0 ? preferred : 'summary-only'
}

function buildSectionPresentation(section: HtmlReportSection): HtmlReportSectionPresentation {
  const visualKind = visualKindForSection(section)
  const percentFacets =
    visualKind === 'percent-facets' || visualKind === 'material-methods'
      ? buildPercentFacets(section)
      : []
  const contentMix = visualKind === 'content-mix' ? buildContentMix(section) : null
  const keywordCloud =
    visualKind === 'selling-point-matrix' || visualKind === 'selling-strategy' ? buildKeywordCloud(section) : null
  const executionDistributions =
    visualKind === 'execution-matrix' ? buildExecutionDistributions(section) : []
  const plannedIndexes =
    visualKind === 'summary-only' ? [] : findVisualSourceIndexes(section, visualKind)
  const visualSourceTableIndexes =
    percentFacets.length > 0
      ? Array.from(
          new Set(
            percentFacets
              .flatMap((facet) => facet.items)
              .map((item) => item.source.tableIndex)
              .filter((index): index is number => index !== null)
          )
        )
      : contentMix
        ? [contentMix.tableIndex]
        : plannedIndexes
  const visualSources: HtmlReportSourceRef[] =
    percentFacets.length > 0
      ? percentFacets.flatMap((facet) => facet.items.map((item) => item.source))
      : contentMix
        ? contentMix.items.map((item) => item.source)
        : visualSourceTableIndexes.flatMap((tableIndex) => {
            const table = section.tables[tableIndex]
            return table.rows.flatMap((row, rowIndex) =>
              row
                .map((rawValue, columnIndex) => ({
                  sectionNumber: section.number,
                  tableIndex,
                  rowIndex,
                  columnIndex,
                  context: table.context,
                  rawValue
                }))
                .filter((source) => Boolean(text(source.rawValue)))
            )
          })
  if (
    visualSources.length === 0 &&
    (visualKind === 'action-roadmap' || visualKind === 'limitations')
  ) {
    visualSources.push(
      ...section.listItems.map((rawValue, rowIndex) => ({
        sectionNumber: section.number,
        tableIndex: null,
        rowIndex,
        columnIndex: null,
        context: section.title,
        rawValue
      }))
    )
  }
  const alwaysVisibleMainTable = new Set(['0', '2', '6', '7', '10', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8'])
  const tables = section.tables.map((table, tableIndex) => {
    const compact = table.rows.length <= 6 && table.headers.length <= 4
    const primary = tableIndex === 0 && alwaysVisibleMainTable.has(section.number)
    const v2DecisionTable =
      (section.number === 'M2' && /核心人群TOP5/u.test(table.context)) ||
      (section.number === 'M4' && /真实卖点统一排序/u.test(table.context))
    return {
      tableIndex,
      mode: primary || compact || v2DecisionTable ? ('visible' as const) : ('collapsed' as const),
      rowCount: table.rows.length,
      columnCount: table.headers.length
    }
  })
  return {
    sectionNumber: section.number,
    visualKind,
    visualSourceTableIndexes,
    visualSources,
    percentFacets,
    contentMix,
    keywordCloud,
    executionDistributions,
    tables
  }
}

function metricCandidates(model: HtmlReportModel): MetricCandidate[] {
  const sectionPriority: Record<string, number> = { '3': 60, '0': 52, '2': 42, '4': 34, M2: 62, M1: 38, M3: 32 }
  const candidates: MetricCandidate[] = []
  const seen = new Set<string>()

  for (const section of model.sections) {
    const baseScore = sectionPriority[section.number]
    if (!baseScore) continue
    section.tables.forEach((table, tableIndex) => {
      const platformIndex = findHeaderIndex(table, /平台|渠道|数据来源|来源/)
      const m2DimensionIndex = section.number === 'M2' ? findHeaderIndex(table, /^维度$/u) : -1
      const m2CategoryIndex = section.number === 'M2' ? findHeaderIndex(table, /类别|标签|细分|选项|区间/u) : -1
      table.rows.forEach((row, rowIndex) => {
        if (row.some((cell) => PLACEHOLDER_PATTERN.test(text(cell)))) return
        row.forEach((cell, columnIndex) => {
          const raw = text(cell)
          if (!raw || RANGE_PATTERN.test(raw)) return
          const hits = raw.match(METRIC_PATTERN) || []
          if (hits.length !== 1) return
          const value = hits[0].replace(/\s+/g, '')
          const header = text(table.headers[columnIndex] || '')
          if (/年龄|岁|日期|时间|编号|序号/.test(header)) return
          const fallbackLabelCellIndex = row.findIndex(
            (candidate, index) =>
              index !== columnIndex &&
              index !== platformIndex &&
              Boolean(text(candidate)) &&
              !HAS_METRIC_PATTERN.test(text(candidate))
          )
          const labelCellIndex = m2CategoryIndex >= 0 ? m2CategoryIndex : fallbackLabelCellIndex
          const platform = platformIndex >= 0 ? shorten(row[platformIndex] || '', 24) : ''
          const dimension = shorten(row[labelCellIndex] || header || '关键数据', 22)
          const m2Dimension = m2DimensionIndex >= 0 ? shorten(row[m2DimensionIndex] || '', 22) : ''
          const semanticText = `${header} ${dimension} ${raw}`
          if (/规格|包装|SKU|型号|净含量|容量|尺寸|价格|单价|原价|到手价|数量|件数/.test(semanticText)) {
            return
          }
          const isPercent = /%/.test(value)
          const hasBusinessSemantics =
            /GMV|成交额|成交金额|销售额|销售金额|销量|订单量|订单数|ROI|投产|客单|转化率|点击率|复购率|退货率|渗透率|占比|比例|份额|消耗|曝光|用户数|人数/.test(
              semanticText
            )
          if (!hasBusinessSemantics && !(isPercent && /关键数据|数据|率/.test(header))) return
          const rawDescriptor = shorten(raw.replace(METRIC_PATTERN, ' ').replace(/[：:，,（）()]/g, ' '), 20)
          const metricMeaning =
            rawDescriptor ||
            (isPercent && dimension && !/占比|比例|率|份额|渗透/.test(dimension)
              ? `${dimension}占比`
              : dimension)
          const label = shorten(
            section.number === 'M2'
              ? metricMeaning || '关键数据'
              : [platform || table.context, metricMeaning].filter(Boolean).join(' / ') || '关键数据',
            34
          )
          const sourceLabel = section.number === 'M2'
            ? [platform, m2Dimension || table.context].filter(Boolean).join(' / ') || '平台成交画像'
            : [platform, table.context, header].filter(Boolean).join(' / ') || `第 ${section.number} 章`
          const key = `${section.number}|${label}|${value}|${sourceLabel}`
          if (seen.has(key)) return
          seen.add(key)
          let score = baseScore
          if (/%/.test(value)) score += 18
          if (/关键数据|占比|比例|GMV|成交|销售|ROI|金额|客单/.test(header)) score += 14
          if (platform) score += 5
          if (table.context) score += 3
          candidates.push({
            label,
            value,
            sourceLabel,
            source: {
              sectionNumber: section.number,
              tableIndex,
              rowIndex,
              columnIndex,
              context: table.context,
              rawValue: cell
            },
            score
          })
        })
      })
    })
  }

  return candidates.sort((a, b) => b.score - a.score)
}

function buildPriorities(model: HtmlReportModel): HtmlReportPriorityPresentation[] {
  const section = model.sections.find((candidate) => candidate.number === '0') ||
    model.sections.find((candidate) => candidate.number === 'M2')
  if (!section) return []
  const tableIndex = section.tables.findIndex((table) =>
    tableMatches(table, [/优先级/, /核心人群|人群标签/])
  )
  if (tableIndex < 0) return []
  const table = section.tables[tableIndex]
  const rankIndex = Math.max(0, findHeaderIndex(table, /优先级/))
  const audienceIndex = Math.max(0, findHeaderIndex(table, /核心人群|人群标签/))
  const judgmentIndex = Math.max(0, findHeaderIndex(table, /关键判断|判断|决策动机/))
  return table.rows.slice(0, 4).map((row, rowIndex) => ({
    rank: shorten(row[rankIndex] || `P${rowIndex + 1}`, 8),
    audience: shorten(row[audienceIndex] || '', 54),
    judgment: shorten(row[judgmentIndex] || row[2] || '', 112),
    source: {
      sectionNumber: section.number,
      tableIndex,
      rowIndex,
      columnIndex: audienceIndex,
      context: table.context,
      rawValue: row[audienceIndex] || ''
    }
  }))
}

function balancedSupportingSignals(metrics: MetricCandidate[]): HtmlReportMetricPresentation[] {
  const m2 = metrics.filter((metric) => metric.source.sectionNumber === 'M2')
  const platformOf = (metric: HtmlReportMetricPresentation): string =>
    metric.sourceLabel.split('/')[0]?.trim() || ''
  const platforms = Array.from(new Set(m2.map(platformOf).filter(Boolean)))
  if (platforms.length <= 1) return metrics.slice(0, 3)

  const coverageByLabel = new Map<string, Set<string>>()
  for (const metric of m2) {
    const platform = platformOf(metric)
    if (!platform) continue
    const coverage = coverageByLabel.get(metric.label) || new Set<string>()
    coverage.add(platform)
    coverageByLabel.set(metric.label, coverage)
  }
  const preference = (label: string): number =>
    /女性占比/u.test(label) ? 3 : /年龄|消费/u.test(label) ? 2 : 1
  const commonLabel = Array.from(coverageByLabel.entries())
    .filter(([, coverage]) => coverage.size >= 2)
    .sort((left, right) => preference(right[0]) - preference(left[0]) || right[1].size - left[1].size)[0]?.[0]

  const selected: HtmlReportMetricPresentation[] = []
  const usedPlatforms = new Set<string>()
  for (const metric of commonLabel ? m2.filter((item) => item.label === commonLabel) : m2) {
    const platform = platformOf(metric)
    if (!platform || usedPlatforms.has(platform)) continue
    selected.push(metric)
    usedPlatforms.add(platform)
    if (selected.length >= 3) break
  }
  return selected.length >= 2 ? selected : metrics.slice(0, 3)
}

export function buildHtmlReportPresentation(model: HtmlReportModel): HtmlReportPresentation {
  const conclusion = model.sections.find((section) => section.number === '0')
  const productModule = model.sections.find((section) => section.number === 'M1')
  const thesis =
    conclusion?.paragraphs.find((paragraph) => !/^生成日期\s*[：:]/.test(paragraph)) ||
    productModule?.paragraphs.find((paragraph) => !/^来源\s*[：:]/u.test(paragraph)) ||
    '报告结论与关键证据见下方各章节。'
  const metrics = metricCandidates(model).filter((metric) => metric.score >= 55)
  const priorities = buildPriorities(model)
  const primaryAudience = priorities.find((item) => item.source.sectionNumber === 'M2') || null
  return {
    thesis,
    primaryAudience,
    mainMetric: primaryAudience ? null : metrics[0] || null,
    supportingSignals: primaryAudience ? balancedSupportingSignals(metrics) : metrics.slice(1, 4),
    priorities,
    sections: model.sections.map(buildSectionPresentation)
  }
}
