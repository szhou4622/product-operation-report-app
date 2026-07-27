import { marked } from 'marked'
import {
  buildHtmlReportPresentation,
  type HtmlReportPresentation,
  type HtmlReportSectionPresentation
} from './htmlReportPresentation'
import { renderReportStyles, type ReportThemeTokens } from './htmlReportStyles'
import {
  decodeHtmlEntities,
  parseHtmlReportModel,
  plainText,
  shorten,
  stripProductVisualBrief,
  type HtmlReportDirection,
  type HtmlReportModel,
  type HtmlReportSection,
  type HtmlReportTable
} from './htmlReportModel'

export type {
  HtmlReportContentMixPresentation,
  HtmlReportMetricPresentation,
  HtmlReportPercentFacetPresentation,
  HtmlReportPercentItemPresentation,
  HtmlReportPresentation,
  HtmlReportSectionPresentation,
  HtmlReportSourceRef,
  HtmlReportTablePresentation,
  HtmlReportVisualKind
} from './htmlReportPresentation'
export { buildHtmlReportPresentation } from './htmlReportPresentation'
export { parseHtmlReportModel, stripProductVisualBrief } from './htmlReportModel'
export type {
  HtmlReportDirection,
  HtmlReportModel,
  HtmlReportSection,
  HtmlReportTable,
  HtmlReportVisualBrief
} from './htmlReportModel'

interface HeadingInfo {
  level: number
  text: string
  id: string
}

const THEME_TOKENS: Record<HtmlReportDirection, ReportThemeTokens> = {
  'household-field-guide': {
    paper: '#f4f1e9',
    paperAlt: '#ece7dc',
    surface: '#fffdf8',
    ink: '#252821',
    inkSoft: '#3f463b',
    muted: '#687062',
    line: '#d9d2c5',
    lineStrong: '#b8ae9d',
    accent: '#9b4a2c',
    accentStrong: '#74341f',
    accentSoft: '#f3e1d8',
    series1: '#9b4a2c',
    series2: '#ba7658',
    series3: '#879b72',
    series4: '#c2a46f',
    warning: '#8b4b28',
    warningSoft: '#f5e5d7',
    radius: '12px',
    shadow: '0 20px 50px rgba(69, 52, 35, 0.09)',
    fontDisplay: '"Microsoft YaHei UI", "PingFang SC", sans-serif',
    fontBody: '"Microsoft YaHei", "PingFang SC", sans-serif',
    fontData: 'Consolas, "SFMono-Regular", monospace'
  },
  'restrained-catalogue': {
    paper: '#eef1f5',
    paperAlt: '#e2e7ed',
    surface: '#fbfcfe',
    ink: '#111821',
    inkSoft: '#2d3744',
    muted: '#66717e',
    line: '#d3dae3',
    lineStrong: '#aeb8c5',
    accent: '#294f9b',
    accentStrong: '#1c3975',
    accentSoft: '#e3eaf8',
    series1: '#294f9b',
    series2: '#6f8dc5',
    series3: '#94a2b8',
    series4: '#536278',
    warning: '#8c4b35',
    warningSoft: '#f5e7e2',
    radius: '6px',
    shadow: '0 24px 64px rgba(29, 43, 66, 0.10)',
    fontDisplay: '"Microsoft YaHei UI", "PingFang SC", sans-serif',
    fontBody: '"Microsoft YaHei", "PingFang SC", sans-serif',
    fontData: 'Consolas, "SFMono-Regular", monospace'
  },
  'technical-workbench': {
    paper: '#edf3f5',
    paperAlt: '#e1eaed',
    surface: '#fbfdfd',
    ink: '#122027',
    inkSoft: '#304149',
    muted: '#61747c',
    line: '#cfdbdf',
    lineStrong: '#a8babf',
    accent: '#0a6876',
    accentStrong: '#074d58',
    accentSoft: '#dcecef',
    series1: '#0a6876',
    series2: '#4c8d96',
    series3: '#78949a',
    series4: '#3d6670',
    warning: '#9a5b27',
    warningSoft: '#f4e8d8',
    radius: '4px',
    shadow: '0 18px 48px rgba(29, 63, 72, 0.08)',
    fontDisplay: '"Microsoft YaHei UI", "PingFang SC", sans-serif',
    fontBody: '"Microsoft YaHei", "PingFang SC", sans-serif',
    fontData: 'Consolas, "SFMono-Regular", monospace'
  },
  'calm-evidence': {
    paper: '#f0f4f0',
    paperAlt: '#e4ece5',
    surface: '#fbfdfb',
    ink: '#17221b',
    inkSoft: '#334238',
    muted: '#68766c',
    line: '#d2ddd4',
    lineStrong: '#aabbaa',
    accent: '#4b6e5a',
    accentStrong: '#365342',
    accentSoft: '#dfebe3',
    series1: '#4b6e5a',
    series2: '#7e9d89',
    series3: '#a2b4a5',
    series4: '#6d8373',
    warning: '#8a5d2e',
    warningSoft: '#f3e9db',
    radius: '14px',
    shadow: '0 20px 54px rgba(45, 71, 53, 0.08)',
    fontDisplay: '"Microsoft YaHei UI", "PingFang SC", sans-serif',
    fontBody: '"Microsoft YaHei", "PingFang SC", sans-serif',
    fontData: 'Consolas, "SFMono-Regular", monospace'
  },
  'energetic-social': {
    paper: '#f6f1f3',
    paperAlt: '#ede3e7',
    surface: '#fffafb',
    ink: '#25191d',
    inkSoft: '#45353b',
    muted: '#77646b',
    line: '#dfd1d6',
    lineStrong: '#c4aeb6',
    accent: '#ab3f62',
    accentStrong: '#7f2949',
    accentSoft: '#f1dce4',
    series1: '#ab3f62',
    series2: '#cf708d',
    series3: '#d99b75',
    series4: '#6f789e',
    warning: '#91512f',
    warningSoft: '#f5e6dc',
    radius: '16px',
    shadow: '0 22px 54px rgba(78, 41, 55, 0.09)',
    fontDisplay: '"Microsoft YaHei UI", "PingFang SC", sans-serif',
    fontBody: '"Microsoft YaHei", "PingFang SC", sans-serif',
    fontData: 'Consolas, "SFMono-Regular", monospace'
  },
  'utilitarian-decision-brief': {
    paper: '#edf0f3',
    paperAlt: '#dfe5ea',
    surface: '#fafcfd',
    ink: '#17212b',
    inkSoft: '#334252',
    muted: '#647282',
    line: '#cfd8e1',
    lineStrong: '#a5b2bf',
    accent: '#365571',
    accentStrong: '#253e54',
    accentSoft: '#dce6ee',
    series1: '#365571',
    series2: '#66829a',
    series3: '#899cae',
    series4: '#4d6b5e',
    warning: '#8a5530',
    warningSoft: '#f3e7da',
    radius: '3px',
    shadow: '0 18px 42px rgba(29, 45, 61, 0.08)',
    fontDisplay: '"Microsoft YaHei UI", "PingFang SC", sans-serif',
    fontBody: '"Microsoft YaHei", "PingFang SC", sans-serif',
    fontData: 'Consolas, "SFMono-Regular", monospace'
  },
  'material-editorial': {
    paper: '#f2f0e9',
    paperAlt: '#e6e3d8',
    surface: '#fcfbf6',
    ink: '#24241f',
    inkSoft: '#41443b',
    muted: '#6e7166',
    line: '#d8d4c8',
    lineStrong: '#b6b0a1',
    accent: '#50634f',
    accentStrong: '#384738',
    accentSoft: '#e0e7de',
    series1: '#50634f',
    series2: '#7f8e72',
    series3: '#9d7b61',
    series4: '#6f7468',
    warning: '#875338',
    warningSoft: '#f1e5dc',
    radius: '8px',
    shadow: '0 22px 58px rgba(59, 56, 43, 0.09)',
    fontDisplay: '"Microsoft YaHei UI", "PingFang SC", sans-serif',
    fontBody: '"Microsoft YaHei", "PingFang SC", sans-serif',
    fontData: 'Consolas, "SFMono-Regular", monospace'
  },
  'neutral-evidence': {
    paper: '#eef2f5',
    paperAlt: '#e3e9ee',
    surface: '#fbfcfd',
    ink: '#17212b',
    inkSoft: '#334150',
    muted: '#657383',
    line: '#d2dbe3',
    lineStrong: '#aab7c3',
    accent: '#255e78',
    accentStrong: '#19465c',
    accentSoft: '#deebf0',
    series1: '#255e78',
    series2: '#608ca0',
    series3: '#8faab6',
    series4: '#687c88',
    warning: '#8d5531',
    warningSoft: '#f3e7dc',
    radius: '10px',
    shadow: '0 20px 52px rgba(38, 58, 74, 0.08)',
    fontDisplay: '"Microsoft YaHei UI", "PingFang SC", sans-serif',
    fontBody: '"Microsoft YaHei", "PingFang SC", sans-serif',
    fontData: 'Consolas, "SFMono-Regular", monospace'
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function extractHeadings(markdown: string): HeadingInfo[] {
  const used = new Map<string, number>()
  return markdown
    .split('\n')
    .map((line) => line.match(/^(#{2,3})\s+(.+)$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => {
      const text = plainText(match[2])
      const base =
        text
          .toLowerCase()
          .replace(/[^\p{L}\p{N}]+/gu, '-')
          .replace(/^-+|-+$/g, '') || 'section'
      const count = used.get(base) || 0
      used.set(base, count + 1)
      return { level: match[1].length, text, id: count ? `${base}-${count + 1}` : base }
    })
}

const BLOCKED_HTML_TAGS = new Set([
  'script',
  'iframe',
  'object',
  'embed',
  'link',
  'meta',
  'base',
  'form',
  'input',
  'button',
  'style'
])

const ALLOWED_HTML_TAGS = new Set([
  'a',
  'blockquote',
  'br',
  'code',
  'del',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'img',
  'li',
  'ol',
  'p',
  'pre',
  's',
  'strong',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul'
])

const GLOBAL_SAFE_ATTRS = new Set(['id', 'class', 'title'])
const SAFE_ATTRS_BY_TAG: Record<string, Set<string>> = {
  a: new Set(['href', 'title']),
  img: new Set(['src', 'alt', 'title']),
  td: new Set(['align', 'colspan', 'rowspan']),
  th: new Set(['align', 'colspan', 'rowspan'])
}

function isDangerousUrl(value: string): boolean {
  const normalized = decodeHtmlEntities(value).replace(/[\u0000-\u001f\u007f\s]+/g, '').toLowerCase()
  return /^(javascript|data|vbscript):/.test(normalized)
}

function isRemoteUrl(value: string): boolean {
  const normalized = decodeHtmlEntities(value).trim().toLowerCase()
  return /^(https?:)?\/\//.test(normalized)
}

function sanitizeAttributes(tag: string, rawAttrs = ''): string | null {
  const attrs: string[] = []
  const attrPattern = /([^\s=\/>"'`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
  let match: RegExpExecArray | null
  while ((match = attrPattern.exec(rawAttrs))) {
    const name = match[1].toLowerCase()
    const value = match[2] ?? match[3] ?? match[4] ?? ''
    const tagSafeAttrs = SAFE_ATTRS_BY_TAG[tag]
    if (name.startsWith('on') || name === 'style') continue
    if (!GLOBAL_SAFE_ATTRS.has(name) && !tagSafeAttrs?.has(name)) continue
    if ((name === 'href' || name === 'src') && isDangerousUrl(value)) continue
    if (tag === 'img' && name === 'src' && isRemoteUrl(value)) return null
    if ((name === 'colspan' || name === 'rowspan') && !/^\d{1,2}$/.test(value)) continue
    if (name === 'align' && !/^(left|center|right)$/i.test(value)) continue
    attrs.push(`${name}="${escapeHtml(value)}"`)
  }
  return attrs.length ? ` ${attrs.join(' ')}` : ''
}

export function sanitizeHtmlFragment(html: string): string {
  const blocked = Array.from(BLOCKED_HTML_TAGS).join('|')
  const withoutBlockedBlocks = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(new RegExp(`<\\s*(${blocked})\\b[^>]*>[\\s\\S]*?<\\s*\\/\\s*\\1\\s*>`, 'gi'), '')
    .replace(new RegExp(`<\\s*(${blocked})\\b[^>]*\\/?>`, 'gi'), '')
    .replace(new RegExp(`<\\s*\\/\\s*(${blocked})\\s*>`, 'gi'), '')
  return withoutBlockedBlocks
    .replace(/<\s*([a-zA-Z][\w:-]*)(\s[^<>]*)?>/g, (_full, rawTag: string, rawAttrs = '') => {
      const tag = rawTag.toLowerCase()
      if (!ALLOWED_HTML_TAGS.has(tag)) return ''
      const attrs = sanitizeAttributes(tag, rawAttrs)
      if (attrs === null) return ''
      return `<${tag}${attrs}>`
    })
    .replace(/<\s*\/\s*([a-zA-Z][\w:-]*)\s*>/g, (_full, rawTag: string) => {
      const tag = rawTag.toLowerCase()
      return ALLOWED_HTML_TAGS.has(tag) ? `</${tag}>` : ''
    })
}

function plannedTable(
  section: HtmlReportSection,
  plan: HtmlReportSectionPresentation
): HtmlReportTable | undefined {
  const tableIndex = plan.visualSourceTableIndexes[0]
  return tableIndex === undefined ? undefined : section.tables[tableIndex]
}

function renderFigure(title: string, content: string, className = ''): string {
  const signature = `${title}|${className}`
  let hash = 0
  for (let index = 0; index < signature.length; index++) {
    hash = (hash * 31 + signature.charCodeAt(index)) >>> 0
  }
  const id = `visual-${hash.toString(36)}`
  return `<figure class="visual-block ${className}" aria-labelledby="${id}">
    <figcaption id="${id}">${escapeHtml(title)}</figcaption>
    ${content}
  </figure>`
}

function renderPriorityVisual(
  section: HtmlReportSection,
  plan: HtmlReportSectionPresentation
): string {
  const table = plannedTable(section, plan)
  if (!table || table.rows.length === 0) return ''
  const rows = table.rows.slice(0, 4)
  return renderFigure(
    '经营优先级',
    `<div class="priority-grid">${rows
      .map(
        (row, index) => `<div class="priority-item">
          <span class="priority-rank">${String(index + 1).padStart(2, '0')}</span>
          <div><strong>${escapeHtml(shorten(row[1] || row[0], 48))}</strong>
          <p>${escapeHtml(shorten(row[2] || '', 90))}</p></div>
        </div>`
      )
      .join('')}</div>`,
    'priority-visual'
  )
}

function renderSourceVisual(
  section: HtmlReportSection,
  plan: HtmlReportSectionPresentation
): string {
  const table = plannedTable(section, plan)
  if (!table || table.rows.length === 0) return ''
  return renderFigure(
    '证据来源地图',
    `<div class="source-map">${table.rows
      .slice(0, 8)
      .map(
        (row) => `<div class="source-item">
          <strong>${escapeHtml(shorten(row[0] || '数据来源', 36))}</strong>
          <span>${escapeHtml(shorten(row[1] || '来源待补充', 44))}</span>
          <p>${escapeHtml(shorten(row[2] || '', 76))}</p>
        </div>`
      )
      .join('')}</div>`,
    'source-visual'
  )
}

function renderFactsVisual(
  section: HtmlReportSection,
  plan: HtmlReportSectionPresentation
): string {
  const table = plannedTable(section, plan)
  if (!table || table.rows.length === 0) return ''
  return renderFigure(
    '产品决策信息',
    `<div class="fact-grid">${table.rows
      .slice(0, 8)
      .map(
        (row) => `<div class="fact-item">
          <span>${escapeHtml(shorten(row[0] || '', 30))}</span>
          <strong>${escapeHtml(shorten(row[1] || '需补充', 74))}</strong>
        </div>`
      )
      .join('')}</div>`,
    'facts-visual'
  )
}

function renderPercentBars(
  plan: HtmlReportSectionPresentation,
  title = '一方数据分口径对比'
): string {
  const groups = plan.percentFacets
  if (groups.length === 0) return ''
  return renderFigure(
    title,
    `<div class="facet-grid">${groups
      .slice(0, 4)
      .map(
        (group) => `<section class="bar-facet">
          <h3>${escapeHtml(shorten(group.context || '同口径数据', 48))}</h3>
          ${group.items
            .map(
              (item) => `<div class="bar-row" role="img" aria-label="${escapeHtml(`${item.label} ${item.display}`)}">
                <div class="bar-label"><span>${escapeHtml(item.label)}</span><strong>${escapeHtml(item.display)}</strong></div>
                <div class="bar-track" aria-hidden="true"><span style="--bar-size:${item.value}%"></span></div>
              </div>`
            )
            .join('')}
        </section>`
      )
      .join('')}</div>
      <p class="visual-note">每个小图只比较同一数据表中的百分比，不合并不同平台口径。</p>`,
    'bars-visual'
  )
}

function renderMaterialVisual(
  section: HtmlReportSection,
  plan: HtmlReportSectionPresentation
): string {
  const percentVisual = renderPercentBars(plan, '素材结构比例')
  if (percentVisual) return percentVisual
  const table = plannedTable(section, plan)
  if (!table) return ''
  return renderFigure(
    '素材打法提炼',
    `<div class="method-grid">${table.rows
      .slice(0, 6)
      .map(
        (row, index) => `<div class="method-item">
          <span>${String(index + 1).padStart(2, '0')}</span>
          <strong>${escapeHtml(shorten(row[0] || '素材方向', 42))}</strong>
          <p>${escapeHtml(shorten(row.slice(1).filter(Boolean).join('：'), 100))}</p>
        </div>`
      )
      .join('')}</div>`,
    'methods-visual'
  )
}

function renderSellingPointMatrix(
  section: HtmlReportSection,
  plan: HtmlReportSectionPresentation
): string {
  const table = plannedTable(section, plan)
  if (!table || table.rows.length === 0) return ''
  return renderFigure(
    '卖点证据覆盖',
    `<div class="selling-grid">${table.rows
      .slice(0, 12)
      .map((row) => {
        const missing = row.some((cell) => /需补充|待补证|未知/.test(cell))
        return `<div class="selling-item${missing ? ' is-missing' : ''}">
          <span>${escapeHtml(shorten(row[0] || '卖点', 24))}</span>
          <strong>${escapeHtml(shorten(row[1] || '需补充', 54))}</strong>
          <p>${escapeHtml(shorten(row[2] || '', 64))}</p>
        </div>`
      })
      .join('')}</div>`,
    'selling-visual'
  )
}

function renderOrdinalVisual(
  section: HtmlReportSection,
  plan: HtmlReportSectionPresentation
): string {
  const table = plannedTable(section, plan)
  if (!table || table.rows.length === 0) return ''
  return renderFigure(
    '用户决策顺序',
    `<div class="ordinal-list">${table.rows
      .slice(0, 8)
      .map(
        (row, index) => `<div class="ordinal-item">
          <span>${escapeHtml(shorten(row[0] || String(index + 1), 12))}</span>
          <div><strong>${escapeHtml(shorten(row[1] || '', 52))}</strong>
          <p>${escapeHtml(shorten(row[4] || row[3] || '', 80))}</p></div>
        </div>`
      )
      .join('')}</div>
      <p class="visual-note">这里只表达先后顺序，不用长度或面积暗示未经数据证明的差距。</p>`,
    'ordinal-visual'
  )
}

function renderAudienceVisual(
  section: HtmlReportSection,
  plan: HtmlReportSectionPresentation
): string {
  const table = plannedTable(section, plan)
  if (!table || table.rows.length === 0) return ''
  const audienceIndex = Math.max(0, table.headers.findIndex((header) => header.includes('成交人群')))
  const sellingIndex = Math.max(0, table.headers.findIndex((header) => header.includes('核心卖点')))
  const sceneIndex = Math.max(0, table.headers.findIndex((header) => header.includes('核心场景')))
  return renderFigure(
    '人群、场景与卖点匹配',
    `<div class="audience-grid">${table.rows
      .slice(0, 5)
      .map(
        (row, index) => `<div class="audience-item">
          <span class="audience-order">${String(index + 1).padStart(2, '0')}</span>
          <strong>${escapeHtml(shorten(row[audienceIndex] || '', 58))}</strong>
          <dl>
            <div><dt>场景</dt><dd>${escapeHtml(shorten(row[sceneIndex] || '需补充', 60))}</dd></div>
            <div><dt>卖点</dt><dd>${escapeHtml(shorten(row[sellingIndex] || '需补充', 60))}</dd></div>
          </dl>
        </div>`
      )
      .join('')}</div>`,
    'audience-visual'
  )
}

function renderContentMixVisual(plan: HtmlReportSectionPresentation): string {
  const contentMix = plan.contentMix
  if (!contentMix) return ''
  if (contentMix.mode === 'stacked') {
    const items = contentMix.items.filter(
      (item): item is typeof item & { value: number } => item.value !== null
    )
    return renderFigure(
      '建议内容结构',
      `<div class="stacked-bar" role="img" aria-label="${escapeHtml(
        items.map((item) => `${item.label} ${item.value}%`).join('，')
      )}">
        ${items
          .map(
            (item, index) =>
              `<span class="series-${(index % 4) + 1}" style="--share:${item.value}%"><b>${escapeHtml(
                `${item.value}%`
              )}</b></span>`
          )
          .join('')}
      </div>
      <div class="stacked-legend">${items
        .map(
          (item, index) =>
            `<div><i class="series-${(index % 4) + 1}" aria-hidden="true"></i><span>${escapeHtml(
              item.label
            )}</span><strong>${item.value}%</strong></div>`
        )
        .join('')}</div>`,
      'mix-visual'
    )
  }
  return renderFigure(
    '内容主线',
    `<div class="mainline-grid">${contentMix.items
      .map(
        (item, index) => `<div class="mainline-item">
          <span>${String(index + 1).padStart(2, '0')}</span>
          <strong>${escapeHtml(item.label)}</strong>
          <p>${escapeHtml(item.detail)}</p>
        </div>`
      )
      .join('')}</div>`,
    'mainline-visual'
  )
}

function renderCountBars(items: Array<{ label: string; value: number }>, title: string): string {
  if (items.length === 0) return ''
  const max = Math.max(...items.map((item) => item.value), 1)
  return `<section class="count-group"><h3>${escapeHtml(title)}</h3>${items
    .map(
      (item) => `<div class="bar-row" role="img" aria-label="${escapeHtml(`${item.label} ${item.value} 条`)}">
        <div class="bar-label"><span>${escapeHtml(item.label)}</span><strong>${item.value} 条</strong></div>
        <div class="bar-track" aria-hidden="true"><span style="--bar-size:${(item.value / max) * 100}%"></span></div>
      </div>`
    )
    .join('')}</section>`
}

function renderExecutionVisual(
  section: HtmlReportSection,
  plan: HtmlReportSectionPresentation
): string {
  const table = plannedTable(section, plan)
  if (!table || table.rows.length === 0) return ''
  const idIndex = table.headers.findIndex((header) => header.includes('脚本编号'))
  const classIndex = table.headers.findIndex((header) => header.includes('视频分类'))
  const perspectiveIndex = table.headers.findIndex((header) => header.includes('视角'))
  const uniqueRows = Array.from(
    new Map(
      table.rows
        .filter((row) => Boolean(plainText(row[idIndex] || '')))
        .map((row) => [plainText(row[idIndex]), row] as const)
    ).values()
  )
  const readClass = (value: string): string =>
    plainText(value).match(/^(3\.(?:1|2|99))(?:\s|$)/)?.[1] || ''
  const classes = ['3.1', '3.2', '3.99'].map((label) => ({
    label,
    value: uniqueRows.filter((row) => readClass(row[classIndex] || '') === label).length
  }))
  const perspectives = ['商家', '用户', '专业'].map((label) => ({
    label: `${label}视角`,
    value: uniqueRows.filter((row) => {
      const value = plainText(row[perspectiveIndex] || '').replace(/\s+/g, '')
      return value === label || value === `${label}视角`
    }).length
  }))
  return renderFigure(
    '第一轮脚本组合',
    `<div class="count-grid">${renderCountBars(classes, '视频分类')}${renderCountBars(
      perspectives,
      '内容视角'
    )}</div>
    <p class="visual-note">数量来自第一轮建议选题表，共 ${uniqueRows.length} 条有效且编号唯一的脚本。</p>`,
    'execution-visual'
  )
}

function renderActionVisual(section: HtmlReportSection): string {
  if (section.listItems.length === 0) return ''
  const classifyAction = (item: string): 'near' | 'ongoing' | 'verify' => {
    if (
      /需(?:品牌)?补(?:充|证)|待补|待确认|未补证|验证后|检测报告|合作证明|资质截图|不要表达|避免功效|补充.*(?:报告|证明|截图)/.test(
        item
      )
    ) {
      return 'verify'
    }
    if (/短期|立即|优先|先做|先讲|先用/.test(item)) return 'near'
    return 'ongoing'
  }
  const groups = [
    {
      title: '近期先做',
      status: '先执行',
      items: section.listItems.filter((item) => classifyAction(item) === 'near')
    },
    {
      title: '持续优化',
      status: '持续观察',
      items: section.listItems.filter((item) => classifyAction(item) === 'ongoing')
    },
    {
      title: '验证后再放大',
      status: '待验证',
      items: section.listItems.filter((item) => classifyAction(item) === 'verify')
    }
  ].filter((group) => group.items.length > 0)
  const orderOf = (item: string): string =>
    String(section.listItems.findIndex((candidate) => candidate === item) + 1).padStart(2, '0')
  const actionSummary = (item: string): string => {
    const normalized = plainText(item).replace(/^\s*\d+[.)、]\s*/, '')
    const firstClause = normalized.split(/[。；;]/)[0] || normalized
    return shorten(firstClause, 58)
  }
  return renderFigure(
    '优先行动路线',
    `<div class="action-roadmap">${groups
      .map(
        (group) => `<section>
          <h3>${escapeHtml(group.title)}</h3>
          ${group.items
            .slice(0, 3)
            .map(
              (item) => `<div class="action-item">
                <span>${orderOf(item)}</span>
                <div><p>${escapeHtml(actionSummary(item))}</p><small>${escapeHtml(group.status)}</small></div>
              </div>`
            )
            .join('')}
        </section>`
      )
      .join('')}</div>`,
    'actions-visual'
  )
}

function renderLimitationsVisual(section: HtmlReportSection): string {
  if (section.listItems.length === 0) return ''
  return renderFigure(
    '使用前请核对',
    `<ul class="limitation-list">${section.listItems
      .slice(0, 8)
      .map((item) => `<li>${escapeHtml(shorten(item, 130))}</li>`)
      .join('')}</ul>`,
    'limitations-visual'
  )
}

function renderSectionVisual(
  section: HtmlReportSection,
  plan: HtmlReportSectionPresentation | undefined
): string {
  if (!plan || plan.visualKind === 'summary-only') return ''
  let visual = ''
  switch (plan.visualKind) {
    case 'priority-lanes':
      visual = renderPriorityVisual(section, plan)
      break
    case 'source-ledger':
      visual = renderSourceVisual(section, plan)
      break
    case 'product-facts':
      visual = renderFactsVisual(section, plan)
      break
    case 'percent-facets':
      visual = renderPercentBars(plan)
      break
    case 'material-methods':
      visual = renderMaterialVisual(section, plan)
      break
    case 'selling-point-matrix':
      visual = renderSellingPointMatrix(section, plan)
      break
    case 'ordinal-path':
      visual = renderOrdinalVisual(section, plan)
      break
    case 'audience-map':
      visual = renderAudienceVisual(section, plan)
      break
    case 'content-mix':
      visual = renderContentMixVisual(plan)
      break
    case 'execution-matrix':
      visual = renderExecutionVisual(section, plan)
      break
    case 'action-roadmap':
      visual = renderActionVisual(section)
      break
    case 'limitations':
      visual = renderLimitationsVisual(section)
      break
    default:
      visual = ''
  }
  if (!visual) return ''
  const tables = plan.visualSourceTableIndexes.join(',')
  return visual.replace(
    '<figure ',
    `<figure data-source-section="${escapeHtml(section.number)}" data-source-tables="${escapeHtml(tables)}" data-source-cell-count="${plan.visualSources.length}" `
  )
}

function renderHero(model: HtmlReportModel, presentation: HtmlReportPresentation): string {
  const mainMetric = presentation.mainMetric
  const displayTitle = model.title.replace(/\s*产品经营报告\s*$/u, '').trim() || model.title
  const sourceAttrs = mainMetric
    ? ` data-source-section="${escapeHtml(mainMetric.source.sectionNumber)}" data-source-table="${mainMetric.source.tableIndex ?? ''}" data-source-row="${mainMetric.source.rowIndex ?? ''}" data-source-column="${mainMetric.source.columnIndex ?? ''}" data-source-value="${escapeHtml(mainMetric.source.rawValue)}"`
    : ''
  return `<header class="story-stat-hero">
    <div class="story-stat-hero__meta">
      <span>产品经营决策报告</span>
      ${model.dateLine ? `<span>${escapeHtml(model.dateLine)}</span>` : ''}
    </div>
    <div class="story-stat-hero__grid">
      ${
        mainMetric
          ? `<div class="hero-figure"${sourceAttrs}>
              <strong>${escapeHtml(mainMetric.value)}</strong>
              <span>${escapeHtml(mainMetric.label)}</span>
              <small>${escapeHtml(mainMetric.sourceLabel)}</small>
            </div>`
          : `<div class="hero-figure hero-figure--text">
              <strong>核心结论</strong>
              <span>本报告未找到可安全提取的主指标，首屏只呈现原报告结论。</span>
            </div>`
      }
      <div class="hero-copy">
        <h1>${escapeHtml(displayTitle)}</h1>
        <p class="hero-thesis">${escapeHtml(shorten(presentation.thesis, 190))}</p>
      </div>
    </div>
    ${
      presentation.supportingSignals.length
        ? `<div class="signal-strip" aria-label="关键经营信号">${presentation.supportingSignals
            .map(
              (metric) => `<div data-source-section="${escapeHtml(metric.source.sectionNumber)}" data-source-table="${metric.source.tableIndex ?? ''}" data-source-row="${metric.source.rowIndex ?? ''}" data-source-column="${metric.source.columnIndex ?? ''}" data-source-value="${escapeHtml(metric.source.rawValue)}">
                <strong>${escapeHtml(metric.value)}</strong>
                <span>${escapeHtml(metric.label)}</span>
                <small>${escapeHtml(metric.sourceLabel)}</small>
              </div>`
            )
            .join('')}</div>`
        : ''
    }
  </header>`
}

function renderDecisionDashboard(presentation: HtmlReportPresentation): string {
  if (presentation.priorities.length === 0) return ''
  return `<section class="decision-dashboard" aria-labelledby="decision-dashboard-title">
    <div class="decision-dashboard__head">
      <h2 id="decision-dashboard-title">先做什么，再验证什么</h2>
      <p>以下顺序直接来自第 0 章的人群优先级表，只表达经营先后，不代表人群占比。</p>
    </div>
    <div class="priority-lanes">${presentation.priorities
      .map(
        (item) => `<article class="priority-lane" data-source-section="${escapeHtml(item.source.sectionNumber)}" data-source-table="${item.source.tableIndex ?? ''}" data-source-row="${item.source.rowIndex ?? ''}">
          <span class="priority-lane__rank">${escapeHtml(item.rank)}</span>
          <h3>${escapeHtml(item.audience)}</h3>
          <p>${escapeHtml(item.judgment)}</p>
        </article>`
      )
      .join('')}</div>
  </section>`
}

function renderChapterIndex(headings: HeadingInfo[]): string {
  const chapters = headings.filter((heading) => heading.level === 2)
  if (chapters.length === 0) return ''
  return `<section class="chapter-index" aria-labelledby="chapter-index-title">
    <div class="chapter-index__head">
      <h2 id="chapter-index-title">按经营问题进入报告</h2>
      <p>先看结论，再查看数据、人群、内容和执行建议。</p>
    </div>
    <nav class="chapter-index__grid" aria-label="报告章节">${chapters
      .map((heading) => {
        const match = heading.text.match(/^(\d+)\.\s*(.*)$/)
        return `<a href="#${escapeHtml(heading.id)}">
          <span class="chapter-index__no">${escapeHtml(match?.[1] || '')}</span>
          <span>${escapeHtml(match?.[2] || heading.text)}</span>
          <b aria-hidden="true">→</b>
        </a>`
      })
      .join('')}</nav>
  </section>`
}

function decorateTables(
  html: string,
  plan: HtmlReportSectionPresentation | undefined
): string {
  let tableIndex = 0
  return html.replace(/<table>([\s\S]*?)<\/table>/gi, (_full, inner: string) => {
    const currentIndex = tableIndex++
    const tablePlan = plan?.tables.find((candidate) => candidate.tableIndex === currentIndex)
    const headerBlock = inner.match(/<thead>([\s\S]*?)<\/thead>/i)?.[1] || ''
    const headers = Array.from(headerBlock.matchAll(/<th(?:\s[^>]*)?>([\s\S]*?)<\/th>/gi)).map((match) =>
      shorten(match[1], 38)
    )
    const rowCount = tablePlan?.rowCount ?? (inner.match(/<tr(?:\s[^>]*)?>/gi) || []).length - 1
    const mode = tablePlan?.mode || 'visible'
    const wrapTable = (body: string, density = ''): string => {
      const table = `<div class="table-wrap${density}" data-table-index="${currentIndex}"><table class="evidence-table cols-${Math.min(
        Math.max(headers.length, 1),
        12
      )}">${body}</table></div>`
      if (mode === 'visible') return table
      return `<details class="evidence-disclosure" data-table-index="${currentIndex}">
        <summary><span>查看完整数据</span><small>${Math.max(rowCount, 0)} 行 · ${Math.max(headers.length, 1)} 列</small></summary>
        ${table}
      </details>
      <div class="print-table-copy" aria-hidden="true">${table}</div>`
    }
    if (headers.length === 0) return wrapTable(inner)
    let index = 0
    const bodyWithLabels = inner.replace(/<td(\s[^>]*)?>([\s\S]*?)<\/td>/gi, (_cell, attrs = '', content: string) => {
      const label = headers[index % headers.length] || '字段'
      index++
      return `<td${attrs || ''} data-label="${escapeHtml(label)}">${content}</td>`
    })
    const body = bodyWithLabels.replace(
      /<th(\s[^>]*)?>/gi,
      (_cell, attrs = '') => `<th${attrs || ''} scope="col">`
    )
    const density = headers.length >= 6 ? ' wide-table' : headers.length <= 3 ? ' compact-table' : ''
    return wrapTable(body, density)
  })
}

function removeHeroSource(html: string, model: HtmlReportModel): string {
  let result = html.replace(/<h1(?:\s[^>]*)?>[\s\S]*?<\/h1>/i, '')
  if (model.dateLine) {
    const escapedDate = escapeHtml(model.dateLine).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    result = result.replace(new RegExp(`<p>\\s*${escapedDate}\\s*<\\/p>`, 'i'), '')
  }
  return result
}

function wrapSections(
  html: string,
  model: HtmlReportModel,
  headings: HeadingInfo[],
  presentation: HtmlReportPresentation
): string {
  const sectionEntries = model.sections
    .map((section) => {
      const text = `${section.number}. ${section.title}`
      const heading = headings.find((candidate) => candidate.level === 2 && candidate.text === text)
      return heading ? { section, id: heading.id } : null
    })
    .filter((entry): entry is { section: HtmlReportSection; id: string } => Boolean(entry))
  if (sectionEntries.length === 0) return html
  const starts = sectionEntries
    .map((entry) => ({ ...entry, index: html.indexOf(`<h2 id="${escapeHtml(entry.id)}">`) }))
    .filter((entry) => entry.index >= 0)
    .sort((a, b) => a.index - b.index)
  if (starts.length === 0) return html
  let output = html.slice(0, starts[0].index)
  for (let index = 0; index < starts.length; index++) {
    const current = starts[index]
    const end = starts[index + 1]?.index ?? html.length
    let segment = html.slice(current.index, end)
    const sectionPlan = presentation.sections.find(
      (candidate) => candidate.sectionNumber === current.section.number
    )
    segment = decorateTables(segment, sectionPlan)
    const visual =
      current.section.number === '0' && presentation.priorities.length > 0
        ? ''
        : renderSectionVisual(current.section, sectionPlan)
    if (visual) segment = segment.replace(/<\/h2>/, `</h2>${visual}`)
    output += `<section class="report-section" data-section="${escapeHtml(current.section.number)}">${segment}</section>`
  }
  return output
}

function renderToc(headings: HeadingInfo[]): string {
  if (headings.length === 0) return ''
  return `<nav class="toc" aria-label="报告目录">
    <div class="toc-title">报告目录</div>
    ${headings
      .map(
        (heading) =>
          `<a class="level-${heading.level}" href="#${escapeHtml(heading.id)}">${escapeHtml(heading.text)}</a>`
      )
      .join('')}
  </nav>`
}

export async function markdownToHtmlDocument(markdown: string): Promise<string> {
  const clean = stripProductVisualBrief(markdown)
  const model = parseHtmlReportModel(markdown)
  const presentation = buildHtmlReportPresentation(model)
  const headings = extractHeadings(clean)
  const rendered = String(
    await marked.parse(clean, {
      gfm: true,
      breaks: false
    })
  )
  let headingIndex = 0
  const withIds = rendered.replace(/<h([23])>(.*?)<\/h\1>/g, (full, level: string, inner: string) => {
    const heading = headings[headingIndex]
    if (heading && heading.level === Number(level)) {
      headingIndex++
      return `<h${level} id="${escapeHtml(heading.id)}">${inner}</h${level}>`
    }
    return full
  })
  const safeBody = sanitizeHtmlFragment(withIds)
  const bodyWithoutHero = removeHeroSource(safeBody, model)
  const sectionBody = wrapSections(bodyWithoutHero, model, headings, presentation)
  const tokens = THEME_TOKENS[model.brief.designDirection]
  const toc = renderToc(headings)
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; font-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';">
  <title>${escapeHtml(model.title)}</title>
  <style>
    /* Report design read: source-bound decision report for novice business users; variance 5, motion 1, density 6. */
    ${renderReportStyles(tokens)}
  </style>
</head>
<body data-report-direction="${escapeHtml(model.brief.designDirection)}">
  <a class="skip-link" href="#report-main">跳到报告正文</a>
  <main class="shell">
    ${toc}
    <article class="report" id="report-main" tabindex="-1">
      ${renderHero(model, presentation)}
      ${renderDecisionDashboard(presentation)}
      ${renderChapterIndex(headings)}
      <div class="report-body">
        ${sectionBody}
      </div>
    </article>
  </main>
</body>
</html>
`
}
