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

export interface HtmlReportSectionPresentation {
  sectionNumber: string
  visualKind: HtmlReportVisualKind
  visualSourceTableIndexes: number[]
  visualSources: HtmlReportSourceRef[]
  percentFacets: HtmlReportPercentFacetPresentation[]
  contentMix: HtmlReportContentMixPresentation | null
  tables: HtmlReportTablePresentation[]
}

export interface HtmlReportPresentation {
  thesis: string
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
  /成交人群|购买画像|性别|年龄|地域|地区|城市线级|人群构成|用户构成|内容构成|素材结构|来源构成|类目构成|占比分布|分布/

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

function buildPercentFacets(section: HtmlReportSection): HtmlReportPercentFacetPresentation[] {
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
          return {
            context: [table.context, platform, dimension, text(table.headers[valueIndex] || '')]
              .filter(Boolean)
              .join(' · '),
            items: completeItems
          }
        })
        .filter((facet): facet is HtmlReportPercentFacetPresentation => Boolean(facet))
    })
  })
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
          tableMatches(table, [/类型/, /原始\s*3\s*秒开头/, /可复用方向/])
      ).slice(0, 1)
    }
    case 'selling-point-matrix':
      return matches((table) => tableMatches(table, [/卖点维度/, /我方产品卖点/])).slice(0, 1)
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
    '11': 'limitations'
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
  const alwaysVisibleMainTable = new Set(['0', '2', '6', '7', '10'])
  const tables = section.tables.map((table, tableIndex) => {
    const compact = table.rows.length <= 6 && table.headers.length <= 4
    const primary = tableIndex === 0 && alwaysVisibleMainTable.has(section.number)
    return {
      tableIndex,
      mode: primary || compact ? ('visible' as const) : ('collapsed' as const),
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
    tables
  }
}

function metricCandidates(model: HtmlReportModel): MetricCandidate[] {
  const sectionPriority: Record<string, number> = { '3': 60, '0': 52, '2': 42, '4': 34 }
  const candidates: MetricCandidate[] = []
  const seen = new Set<string>()

  for (const section of model.sections) {
    const baseScore = sectionPriority[section.number]
    if (!baseScore) continue
    section.tables.forEach((table, tableIndex) => {
      const platformIndex = findHeaderIndex(table, /平台|渠道|数据来源|来源/)
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
          const labelCellIndex = row.findIndex(
            (candidate, index) =>
              index !== columnIndex &&
              index !== platformIndex &&
              Boolean(text(candidate)) &&
              !HAS_METRIC_PATTERN.test(text(candidate))
          )
          const platform = platformIndex >= 0 ? shorten(row[platformIndex] || '', 24) : ''
          const dimension = shorten(row[labelCellIndex] || header || '关键数据', 22)
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
            [platform || table.context, metricMeaning].filter(Boolean).join(' / ') || '关键数据',
            34
          )
          const sourceLabel = [platform, table.context, header].filter(Boolean).join(' / ') || `第 ${section.number} 章`
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
  const section = model.sections.find((candidate) => candidate.number === '0')
  if (!section) return []
  const tableIndex = section.tables.findIndex((table) => tableMatches(table, [/优先级/, /核心人群/]))
  if (tableIndex < 0) return []
  const table = section.tables[tableIndex]
  const rankIndex = Math.max(0, findHeaderIndex(table, /优先级/))
  const audienceIndex = Math.max(0, findHeaderIndex(table, /核心人群/))
  const judgmentIndex = Math.max(0, findHeaderIndex(table, /关键判断|判断/))
  return table.rows.slice(0, 4).map((row, rowIndex) => ({
    rank: shorten(row[rankIndex] || `P${rowIndex + 1}`, 8),
    audience: shorten(row[audienceIndex] || '', 54),
    judgment: shorten(row[judgmentIndex] || row[2] || '', 112),
    source: {
      sectionNumber: '0',
      tableIndex,
      rowIndex,
      columnIndex: audienceIndex,
      context: table.context,
      rawValue: row[audienceIndex] || ''
    }
  }))
}

export function buildHtmlReportPresentation(model: HtmlReportModel): HtmlReportPresentation {
  const conclusion = model.sections.find((section) => section.number === '0')
  const thesis =
    conclusion?.paragraphs.find((paragraph) => !/^生成日期\s*[：:]/.test(paragraph)) ||
    '报告结论与关键证据见下方各章节。'
  const metrics = metricCandidates(model).filter((metric) => metric.score >= 55)
  return {
    thesis,
    mainMetric: metrics[0] || null,
    supportingSignals: metrics.slice(1, 4),
    priorities: buildPriorities(model),
    sections: model.sections.map(buildSectionPresentation)
  }
}
