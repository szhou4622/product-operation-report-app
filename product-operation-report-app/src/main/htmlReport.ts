import { marked } from 'marked'

export type HtmlReportDirection =
  | 'household-field-guide'
  | 'restrained-catalogue'
  | 'technical-workbench'
  | 'calm-evidence'
  | 'energetic-social'
  | 'utilitarian-decision-brief'
  | 'material-editorial'
  | 'neutral-evidence'

export interface HtmlReportVisualBrief {
  role: string
  audience: string
  scene: string
  valueSignal: string
  trustModel: string
  designDirection: HtmlReportDirection
  evidenceConfidence: 'confirmed' | 'partial' | 'insufficient'
}

export interface HtmlReportTable {
  context: string
  headers: string[]
  rows: string[][]
}

export interface HtmlReportSection {
  number: string
  title: string
  markdown: string
  paragraphs: string[]
  listItems: string[]
  tables: HtmlReportTable[]
}

export interface HtmlReportModel {
  title: string
  dateLine: string
  brief: HtmlReportVisualBrief
  sections: HtmlReportSection[]
}

interface ThemeTokens {
  paper: string
  paperAlt: string
  surface: string
  ink: string
  inkSoft: string
  muted: string
  line: string
  lineStrong: string
  accent: string
  accentStrong: string
  accentSoft: string
  series1: string
  series2: string
  series3: string
  series4: string
  warning: string
  warningSoft: string
  radius: string
  shadow: string
  fontDisplay: string
  fontBody: string
  fontData: string
}

interface HeadingInfo {
  level: number
  text: string
  id: string
}

interface MetricItem {
  label: string
  value: string
}

const VISUAL_BRIEF_PATTERN = /<!--\s*Product visual brief\s*([\s\S]*?)-->/gi
const DIRECTIONS = new Set<HtmlReportDirection>([
  'household-field-guide',
  'restrained-catalogue',
  'technical-workbench',
  'calm-evidence',
  'energetic-social',
  'utilitarian-decision-brief',
  'material-editorial',
  'neutral-evidence'
])
const VALUE_SIGNALS = new Set([
  'practicality',
  'price',
  'premium',
  'expertise',
  'efficiency',
  'identity',
  'gifting'
])
const TRUST_MODELS = new Set([
  'visible-use',
  'ingredients',
  'tests',
  'authority',
  'reviews',
  'craft',
  'service',
  'roi'
])

const THEME_TOKENS: Record<HtmlReportDirection, ThemeTokens> = {
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

function decodeHtmlEntities(value: string): string {
  const decodeCodePoint = (raw: string, radix: number): string => {
    const point = Number.parseInt(raw, radix)
    if (
      !Number.isInteger(point) ||
      point < 0 ||
      point > 0x10ffff ||
      (point >= 0xd800 && point <= 0xdfff)
    ) {
      return '\ufffd'
    }
    return String.fromCodePoint(point)
  }
  return value
    .replace(/&#(\d+);?/g, (_, n: string) => decodeCodePoint(n, 10))
    .replace(/&#x([\da-f]+);?/gi, (_, n: string) => decodeCodePoint(n, 16))
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&colon;/gi, ':')
    .replace(/&tab;/gi, '\t')
    .replace(/&newline;/gi, '\n')
}

function plainText(value: string): string {
  return decodeHtmlEntities(
    value
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<[^>]*>/g, '')
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/~~/g, '')
      .replace(/[*_`]/g, '')
  )
    .replace(/\s+/g, ' ')
    .trim()
}

function shorten(value: string, max = 86): string {
  const normalized = plainText(value)
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized
}

export function stripProductVisualBrief(markdown: string): string {
  return markdown.replace(VISUAL_BRIEF_PATTERN, '').replace(/\n{3,}/g, '\n\n').trim()
}

function normalizeBriefKey(key: string): string {
  return key.trim().toLowerCase().replace(/[_\s]+/g, '-')
}

function parseVisualBrief(markdown: string): Partial<HtmlReportVisualBrief> | null {
  VISUAL_BRIEF_PATTERN.lastIndex = 0
  const match = VISUAL_BRIEF_PATTERN.exec(markdown)
  VISUAL_BRIEF_PATTERN.lastIndex = 0
  if (!match) return null
  const fields = new Map<string, string>()
  for (const line of match[1].split(/\r?\n/)) {
    const hit = line.match(/^\s*([a-zA-Z-]+)\s*:\s*(.*?)\s*$/)
    if (hit) fields.set(normalizeBriefKey(hit[1]), hit[2])
  }
  const direction = fields.get('design-direction') as HtmlReportDirection | undefined
  const confidence = fields.get('evidence-confidence')
  return {
    role: fields.get('role') || '',
    audience: fields.get('audience') || '',
    scene: fields.get('scene') || '',
    valueSignal: fields.get('value-signal') || '',
    trustModel: fields.get('trust-model') || '',
    designDirection: direction && DIRECTIONS.has(direction) ? direction : undefined,
    evidenceConfidence:
      confidence === 'confirmed' || confidence === 'partial' || confidence === 'insufficient'
        ? confidence
        : undefined
  }
}

function inferDirection(markdown: string): HtmlReportDirection {
  const text = stripProductVisualBrief(markdown).toLowerCase()
  const routes: Array<[HtmlReportDirection, string[]]> = [
    ['household-field-guide', ['家庭', '家常', '日常', '囤货', '复购', '下饭', '早餐', '方便', '实用']],
    ['restrained-catalogue', ['礼赠', '高端', '精品', '尊享', '礼盒', '稀缺', '质感', '体验']],
    ['technical-workbench', ['技术', '参数', '性能', '精度', '机制', '标准', '效率', '专业']],
    ['calm-evidence', ['成分', '配料', '安全', '检测', '温和', '安心', '营养', '健康']],
    ['energetic-social', ['年轻', '潮流', '社交', '新奇', '分享', '学生', '小红书', '年轻人']],
    ['utilitarian-decision-brief', ['企业', '采购', 'b2b', 'roi', '实施', '供应链', '工业', '交付']],
    ['material-editorial', ['非遗', '产地', '匠人', '手工', '传统', '地方', '文化', '传承']]
  ]
  const scored = routes
    .map(([direction, keywords]) => ({
      direction,
      score: keywords.reduce((count, keyword) => count + (text.includes(keyword) ? 1 : 0), 0)
    }))
    .sort((a, b) => b.score - a.score)
  if (!scored[0] || scored[0].score < 3) return 'neutral-evidence'
  if (scored[1] && scored[0].score - scored[1].score < 1) return 'neutral-evidence'
  return scored[0].direction
}

function completeBrief(markdown: string): HtmlReportVisualBrief {
  const parsed = parseVisualBrief(markdown)
  const declaredConfidence = parsed?.evidenceConfidence || 'insufficient'
  const requiredFields = [
    parsed?.role,
    parsed?.audience,
    parsed?.scene,
    parsed?.valueSignal,
    parsed?.trustModel
  ]
  const hasRequiredEvidence = requiredFields.every(
    (field) => Boolean(field?.trim()) && !/需补充|待补|待确认|未知|unknown|not available|n\/a/i.test(field || '')
  ) &&
    VALUE_SIGNALS.has((parsed?.valueSignal || '').trim().toLowerCase()) &&
    TRUST_MODELS.has((parsed?.trustModel || '').trim().toLowerCase())
  const confidence = hasRequiredEvidence ? declaredConfidence : 'insufficient'
  const chosenDirection =
    confidence === 'insufficient'
      ? 'neutral-evidence'
      : parsed?.designDirection || inferDirection(markdown)
  return {
    role: parsed?.role || '需补充',
    audience: parsed?.audience || '需补充',
    scene: parsed?.scene || '需补充',
    valueSignal: parsed?.valueSignal || '需补充',
    trustModel: parsed?.trustModel || '需补充',
    designDirection: chosenDirection,
    evidenceConfidence: confidence
  }
}

function extractTitle(markdown: string): string {
  return plainText(markdown.match(/^#\s+(.+)$/m)?.[1] || '产品经营报告')
}

function extractDateLine(markdown: string): string {
  return plainText(markdown.match(/^生成日期\s*[：:]\s*(.+)$/m)?.[0] || '')
}

function readCellText(cell: unknown): string {
  if (typeof cell === 'string') return plainText(cell)
  if (!cell || typeof cell !== 'object') return ''
  const candidate = cell as { text?: unknown; raw?: unknown }
  if (typeof candidate.text === 'string') return plainText(candidate.text)
  if (typeof candidate.raw === 'string') return plainText(candidate.raw)
  return ''
}

function parseSectionDetails(markdown: string): Pick<HtmlReportSection, 'paragraphs' | 'listItems' | 'tables'> {
  const paragraphs: string[] = []
  const listItems: string[] = []
  const tables: HtmlReportTable[] = []
  let context = ''
  const tokens = marked.lexer(markdown) as Array<Record<string, unknown>>
  for (const token of tokens) {
    if (token.type === 'heading' && token.depth === 3) {
      context = plainText(String(token.text || ''))
    } else if (token.type === 'paragraph') {
      const text = plainText(String(token.text || ''))
      if (text) paragraphs.push(text)
    } else if (token.type === 'list' && Array.isArray(token.items)) {
      for (const item of token.items as Array<{ text?: string }>) {
        const text = plainText(item.text || '')
        if (text) listItems.push(text)
      }
    } else if (token.type === 'table') {
      const header = Array.isArray(token.header) ? token.header.map(readCellText) : []
      const rows = Array.isArray(token.rows)
        ? (token.rows as unknown[][]).map((row) => row.map(readCellText))
        : []
      tables.push({ context, headers: header, rows })
    }
  }
  return { paragraphs, listItems, tables }
}

export function parseHtmlReportModel(markdown: string): HtmlReportModel {
  const clean = stripProductVisualBrief(markdown)
  const lines = clean.split(/\r?\n/)
  const sections: HtmlReportSection[] = []
  let current: { number: string; title: string; lines: string[] } | null = null
  const flush = (): void => {
    if (!current) return
    const sectionMarkdown = current.lines.join('\n').trim()
    sections.push({
      number: current.number,
      title: current.title,
      markdown: sectionMarkdown,
      ...parseSectionDetails(sectionMarkdown)
    })
  }
  for (const line of lines) {
    const hit = line.match(/^##\s+(\d+)\.\s+(.+?)\s*$/)
    if (hit) {
      flush()
      current = { number: hit[1], title: plainText(hit[2]), lines: [] }
    } else if (current) {
      current.lines.push(line)
    }
  }
  flush()
  return {
    title: extractTitle(clean),
    dateLine: extractDateLine(clean),
    brief: completeBrief(markdown),
    sections
  }
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

function parsePercent(value: string): number | null {
  const match = plainText(value).match(/(-?\d+(?:\.\d+)?)\s*%/)
  if (!match) return null
  const number = Number(match[1])
  return Number.isFinite(number) && number >= 0 && number <= 100 ? number : null
}

function parseSinglePercent(value: string): number | null {
  const match = plainText(value).match(/^(\d+(?:\.\d+)?)\s*%$/)
  if (!match) return null
  const number = Number(match[1])
  return Number.isFinite(number) && number >= 0 && number <= 100 ? number : null
}

function findTable(section: HtmlReportSection, headers: string[]): HtmlReportTable | undefined {
  return section.tables.find((table) => headers.every((header) => table.headers.some((cell) => cell.includes(header))))
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

function renderPriorityVisual(section: HtmlReportSection): string {
  const table = findTable(section, ['优先级', '核心人群'])
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

function renderSourceVisual(section: HtmlReportSection): string {
  const table = findTable(section, ['数据类型', '来源', '本次用途'])
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

function renderFactsVisual(section: HtmlReportSection): string {
  const table = findTable(section, ['模块', '当前判断'])
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

function renderPercentBars(section: HtmlReportSection, title = '一方数据分口径对比'): string {
  const groups = section.tables.flatMap((table) => {
    const platformIndex = table.headers.findIndex((header) => /平台|渠道|数据来源/.test(header))
    const labelIndex = table.headers.findIndex(
      (header, index) => index !== platformIndex && /维度|人群|类别|指标|名称|内容主线/.test(header)
    )
    const percentIndexes = table.headers
      .map((_, index) => index)
      .filter(
        (index) =>
          index !== platformIndex &&
          /占比|比例|数据|率|份额|渗透/.test(table.headers[index] || '') &&
          table.rows.filter((row) => parsePercent(row[index] || '') !== null).length >= 2
      )
    if (percentIndexes.length === 0) return []
    return percentIndexes.flatMap((valueIndex) => {
      const rowsByPlatform = new Map<string, string[][]>()
      for (const row of table.rows.filter((candidate) => candidate.some((cell) => plainText(cell)))) {
        const platform = platformIndex >= 0 ? plainText(row[platformIndex] || '未标明平台') : ''
        const rows = rowsByPlatform.get(platform) || []
        rows.push(row)
        rowsByPlatform.set(platform, rows)
      }
      return Array.from(rowsByPlatform.entries())
        .map(([platform, rows]) => {
          const items = rows.map((row) => {
            const valueCell = row[valueIndex] || ''
            const percentMatches = plainText(valueCell).match(/-?\d+(?:\.\d+)?\s*%/g) || []
            const value = percentMatches.length === 1 ? parsePercent(valueCell) : null
            const fallbackLabelIndex = row.findIndex(
              (cell, index) => index !== platformIndex && index !== valueIndex && Boolean(plainText(cell))
            )
            const resolvedLabelIndex = labelIndex >= 0 && labelIndex !== valueIndex ? labelIndex : fallbackLabelIndex
            return value === null
              ? null
              : {
                  label: shorten(row[resolvedLabelIndex] || '数据', 34),
                  value,
                  display: shorten(valueCell, 20)
                }
          })
          if (items.some((item) => item === null)) return null
          const completeItems = items.filter(
            (item): item is { label: string; value: number; display: string } => Boolean(item)
          )
          if (completeItems.length < 2 || completeItems.length > 8) return null
          const context = [table.context, platform, table.headers[valueIndex]].filter(Boolean).join(' · ')
          return { context, items: completeItems }
        })
        .filter(
          (group): group is {
            context: string
            items: Array<{ label: string; value: number; display: string }>
          } => Boolean(group)
        )
    })
  })
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

function renderMaterialVisual(section: HtmlReportSection): string {
  const percentVisual = renderPercentBars(section, '素材结构比例')
  if (percentVisual) return percentVisual
  const table =
    findTable(section, ['竞品开头', '打法本质']) ||
    findTable(section, ['类型', '原始 3 秒开头', '可复用方向'])
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

function renderSellingPointMatrix(section: HtmlReportSection): string {
  const table = findTable(section, ['卖点维度', '我方产品卖点'])
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

function renderOrdinalVisual(section: HtmlReportSection): string {
  const table = findTable(section, ['排序', '用户视角卖点'])
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

function renderAudienceVisual(section: HtmlReportSection): string {
  const table = findTable(section, ['成交人群', '核心卖点', '核心场景'])
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

function renderContentMixVisual(section: HtmlReportSection): string {
  const ratioTable = section.tables.find((table) => table.headers.some((header) => header.includes('建议占比')))
  if (ratioTable) {
    const ratioIndex = ratioTable.headers.findIndex((header) => header.includes('建议占比'))
    const nonEmptyRows = ratioTable.rows.filter((row) => row.some((cell) => Boolean(plainText(cell))))
    const parsedItems = nonEmptyRows.map((row) => {
      const value = parseSinglePercent(row[ratioIndex] || '')
      return value === null ? null : { label: shorten(row[0] || '内容主线', 34), value }
    })
    const items = parsedItems.filter((item): item is { label: string; value: number } => Boolean(item))
    const total = items.reduce((sum, item) => sum + item.value, 0)
    const isComplete =
      nonEmptyRows.length >= 2 &&
      nonEmptyRows.length <= 6 &&
      parsedItems.every(Boolean) &&
      Math.abs(total - 100) < 0.01
    if (isComplete) {
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
  }
  const mainlineTable = findTable(section, ['内容主线', '对应人群'])
  if (!mainlineTable || mainlineTable.rows.length === 0) return ''
  return renderFigure(
    '内容主线',
    `<div class="mainline-grid">${mainlineTable.rows
      .slice(0, 5)
      .map(
        (row, index) => `<div class="mainline-item">
          <span>${String(index + 1).padStart(2, '0')}</span>
          <strong>${escapeHtml(shorten(row[0] || '', 42))}</strong>
          <p>${escapeHtml(shorten(row[2] || row[1] || '', 78))}</p>
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

function renderExecutionVisual(section: HtmlReportSection): string {
  const table = findTable(section, ['脚本编号', '视频分类', '视角'])
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
  return renderFigure(
    '优先行动路线',
    `<div class="action-list">${section.listItems
      .slice(0, 6)
      .map(
        (item, index) => `<div class="action-item">
          <span>${String(index + 1).padStart(2, '0')}</span>
          <p>${escapeHtml(shorten(item, 120))}</p>
        </div>`
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

function renderSectionVisual(section: HtmlReportSection): string {
  switch (section.number) {
    case '0':
      return renderPriorityVisual(section)
    case '1':
      return renderSourceVisual(section)
    case '2':
      return renderFactsVisual(section)
    case '3':
      return renderPercentBars(section)
    case '4':
      return renderMaterialVisual(section)
    case '5':
      return renderSellingPointMatrix(section)
    case '6':
      return renderOrdinalVisual(section)
    case '7':
      return renderAudienceVisual(section)
    case '8':
      return renderContentMixVisual(section)
    case '9':
      return renderExecutionVisual(section)
    case '10':
      return renderActionVisual(section)
    case '11':
      return renderLimitationsVisual(section)
    default:
      return ''
  }
}

function extractMetrics(model: HtmlReportModel): MetricItem[] {
  const sectionOrder = ['2', '3', '4', '0']
  const unitPattern =
    /(?:ROI\s*[：:]?\s*)?(?<![\d-])[+-]?\d+(?:\.\d+)?\s*(?:%|亿元|万元|万|元|人|条|件|单|次|倍|岁|个|款)/i
  const rangePattern =
    /[+-]?\d+(?:\.\d+)?\s*(?:-|–|—|~|～|至|到)\s*[+-]?\d+(?:\.\d+)?\s*(?:%|亿元|万元|万|元|人|条|件|单|次|倍|岁|个|款)?/gi
  const metrics: MetricItem[] = []
  const seen = new Set<string>()
  for (const number of sectionOrder) {
    const section = model.sections.find((candidate) => candidate.number === number)
    if (!section) continue
    for (const table of section.tables) {
      for (const row of table.rows) {
        if (row.some((cell) => /需补充|待补证|未知/.test(cell))) continue
        const valueCell = row
          .slice(1)
          .map((cell) => plainText(cell).replace(rangePattern, ' ').replace(/\s+/g, ' ').trim())
          .find((cell) => unitPattern.test(cell))
        if (!valueCell) continue
        const hit = valueCell.match(unitPattern)?.[0]
        if (!hit) continue
        const label = shorten(row[0] || table.context || '关键数据', 24)
        const key = `${label}|${hit}`
        if (seen.has(key)) continue
        seen.add(key)
        metrics.push({ label, value: hit.replace(/\s+/g, '') })
        if (metrics.length === 4) return metrics
      }
    }
  }
  return metrics
}

function renderHero(model: HtmlReportModel): string {
  const conclusion = model.sections.find((section) => section.number === '0')
  const thesis =
    conclusion?.paragraphs.find((paragraph) => !/^生成日期\s*[：:]/.test(paragraph)) ||
    '报告结论与关键证据见下方各章节。'
  const metrics = extractMetrics(model)
  return `<header class="decision-hero">
    <div class="hero-copy">
      <p class="report-kicker">产品经营决策报告</p>
      <h1>${escapeHtml(model.title)}</h1>
      <p class="hero-thesis">${escapeHtml(shorten(thesis, 180))}</p>
      ${model.dateLine ? `<p class="report-date">${escapeHtml(model.dateLine)}</p>` : ''}
    </div>
    ${
      metrics.length
        ? `<div class="metric-grid" aria-label="关键指标">${metrics
            .map(
              (metric) => `<div class="metric-item">
                <span>${escapeHtml(metric.label)}</span>
                <strong>${escapeHtml(metric.value)}</strong>
              </div>`
            )
            .join('')}</div>`
        : ''
    }
  </header>`
}

function decorateTables(html: string): string {
  return html.replace(/<table>([\s\S]*?)<\/table>/gi, (_full, inner: string) => {
    const headerBlock = inner.match(/<thead>([\s\S]*?)<\/thead>/i)?.[1] || ''
    const headers = Array.from(headerBlock.matchAll(/<th(?:\s[^>]*)?>([\s\S]*?)<\/th>/gi)).map((match) =>
      shorten(match[1], 38)
    )
    if (headers.length === 0) return `<div class="table-wrap"><table class="evidence-table">${inner}</table></div>`
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
    return `<div class="table-wrap${density}"><table class="evidence-table cols-${Math.min(
      headers.length,
      12
    )}">${body}</table></div>`
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

function wrapSections(html: string, model: HtmlReportModel, headings: HeadingInfo[]): string {
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
    const visual = renderSectionVisual(current.section)
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

function renderMobileToc(headings: HeadingInfo[]): string {
  if (headings.length === 0) return ''
  return `<details class="mobile-toc">
    <summary>查看报告目录</summary>
    <nav aria-label="移动端报告目录">
      ${headings
        .filter((heading) => heading.level === 2)
        .map((heading) => `<a href="#${escapeHtml(heading.id)}">${escapeHtml(heading.text)}</a>`)
        .join('')}
    </nav>
  </details>`
}

function renderTokenBlock(tokens: ThemeTokens): string {
  return `:root {
      color-scheme: light;
      --paper: ${tokens.paper};
      --paper-alt: ${tokens.paperAlt};
      --surface: ${tokens.surface};
      --ink: ${tokens.ink};
      --ink-soft: ${tokens.inkSoft};
      --muted: ${tokens.muted};
      --line: ${tokens.line};
      --line-strong: ${tokens.lineStrong};
      --accent: ${tokens.accent};
      --accent-strong: ${tokens.accentStrong};
      --accent-soft: ${tokens.accentSoft};
      --series-1: ${tokens.series1};
      --series-2: ${tokens.series2};
      --series-3: ${tokens.series3};
      --series-4: ${tokens.series4};
      --warning: ${tokens.warning};
      --warning-soft: ${tokens.warningSoft};
      --radius: ${tokens.radius};
      --page-shadow: ${tokens.shadow};
      --font-display: ${tokens.fontDisplay};
      --font-body: ${tokens.fontBody};
      --font-data: ${tokens.fontData};
      --print-paper: #ffffff;
    }`
}

function renderStyles(tokens: ThemeTokens): string {
  return `${renderTokenBlock(tokens)}
    * { box-sizing: border-box; }
    html, body { overflow-x: clip; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      color: var(--ink);
      background: var(--paper);
      font-family: var(--font-body);
      font-size: 16px;
      line-height: 1.72;
      text-rendering: optimizeLegibility;
    }
    a { color: var(--accent-strong); text-underline-offset: 3px; }
    .report p, .report a, .report li, .report td, .report dd, .toc a {
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    a:focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; }
    .skip-link {
      position: fixed;
      z-index: 20;
      top: 8px;
      left: 8px;
      padding: 10px 14px;
      transform: translateY(-160%);
      background: var(--surface);
      color: var(--ink);
      border: 2px solid var(--accent);
    }
    .skip-link:focus { transform: translateY(0); }
    .shell {
      display: grid;
      grid-template-columns: minmax(210px, 260px) minmax(0, 1fr);
      gap: 28px;
      width: min(1500px, calc(100vw - 48px));
      margin: 24px auto 48px;
      align-items: start;
    }
    .toc {
      position: sticky;
      top: 24px;
      max-height: calc(100vh - 48px);
      overflow: auto;
      padding: 18px 14px;
      border-top: 3px solid var(--accent);
      background: var(--surface);
      box-shadow: var(--page-shadow);
      border-radius: var(--radius);
    }
    .toc-title {
      margin: 0 8px 10px;
      color: var(--ink);
      font: 700 15px/1.4 var(--font-display);
    }
    .toc a {
      display: block;
      padding: 8px;
      color: var(--ink-soft);
      text-decoration: none;
      font-size: 13px;
      line-height: 1.45;
    }
    .toc a:hover { background: var(--accent-soft); color: var(--accent-strong); }
    .toc .level-3 { padding-left: 22px; color: var(--muted); }
    .report {
      min-width: 0;
      background: var(--surface);
      box-shadow: var(--page-shadow);
      border-radius: var(--radius);
      overflow: hidden;
    }
    .decision-hero {
      display: grid;
      grid-template-columns: minmax(0, 1.35fr) minmax(260px, .65fr);
      gap: 42px;
      min-height: 470px;
      padding: 58px 64px 54px;
      align-items: end;
      border-top: 8px solid var(--accent);
      background: linear-gradient(145deg, var(--surface), var(--paper-alt));
    }
    .hero-copy { min-width: 0; }
    .report-kicker {
      margin: 0 0 20px;
      color: var(--accent-strong);
      font-size: 14px;
      font-weight: 700;
      letter-spacing: .08em;
    }
    h1, h2, h3, h4 { font-family: var(--font-display); overflow-wrap: anywhere; min-width: 0; }
    h1 {
      max-width: 16ch;
      margin: 0;
      font-size: clamp(34px, 4.8vw, 66px);
      line-height: 1.08;
      letter-spacing: -.035em;
    }
    .hero-thesis {
      max-width: 62ch;
      margin: 24px 0 0;
      color: var(--ink-soft);
      font-size: 18px;
      line-height: 1.75;
    }
    .report-date { margin: 24px 0 0; color: var(--muted); font-size: 14px; }
    .metric-grid {
      display: grid;
      gap: 0;
      align-self: stretch;
      align-content: end;
      border-top: 1px solid var(--line-strong);
    }
    .metric-item {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 18px;
      padding: 18px 0;
      align-items: baseline;
      border-bottom: 1px solid var(--line);
    }
    .metric-item span { color: var(--muted); font-size: 13px; }
    .metric-item strong { color: var(--accent-strong); font: 700 25px/1 var(--font-data); white-space: nowrap; }
    .report-body { padding: 10px 64px 64px; }
    .report-section { padding: 48px 0 10px; border-top: 1px solid var(--line); }
    .report-section:first-child { border-top: 0; }
    h2 {
      margin: 0 0 24px;
      color: var(--ink);
      font-size: clamp(24px, 2.4vw, 34px);
      line-height: 1.25;
      letter-spacing: -.018em;
    }
    h3 { margin: 34px 0 14px; color: var(--ink-soft); font-size: 19px; line-height: 1.4; }
    h4 { margin: 26px 0 10px; font-size: 17px; }
    p { max-width: 78ch; margin: 11px 0; }
    strong { color: var(--ink); }
    .visual-block {
      margin: 0 0 30px;
      padding: 24px 0 28px;
      border-top: 3px solid var(--accent);
      border-bottom: 1px solid var(--line);
    }
    .visual-block > figcaption {
      margin-bottom: 20px;
      color: var(--ink);
      font: 700 17px/1.4 var(--font-display);
    }
    .visual-note { margin: 16px 0 0; color: var(--muted); font-size: 13px; }
    .priority-grid, .method-grid, .mainline-grid, .audience-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 0 28px;
    }
    .priority-item, .method-item, .mainline-item {
      display: grid;
      grid-template-columns: 38px minmax(0, 1fr);
      gap: 14px;
      padding: 18px 0;
      border-bottom: 1px solid var(--line);
    }
    .priority-rank, .method-item > span, .mainline-item > span, .audience-order {
      color: var(--accent);
      font: 700 14px/1.5 var(--font-data);
    }
    .priority-item strong, .method-item strong, .mainline-item strong { display: block; font-size: 16px; }
    .priority-item p, .method-item p, .mainline-item p { margin: 5px 0 0; color: var(--muted); font-size: 13px; }
    .source-map {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 20px;
    }
    .source-item { padding: 18px 0; border-top: 1px solid var(--line-strong); }
    .source-item strong, .source-item span { display: block; }
    .source-item span { margin-top: 5px; color: var(--accent-strong); font-size: 13px; }
    .source-item p { margin: 7px 0 0; color: var(--muted); font-size: 13px; }
    .fact-grid, .selling-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 14px;
    }
    .fact-item, .selling-item {
      min-width: 0;
      padding: 16px;
      background: var(--paper);
      border-bottom: 3px solid var(--line-strong);
    }
    .fact-item span, .selling-item span { display: block; color: var(--muted); font-size: 12px; }
    .fact-item strong, .selling-item strong { display: block; margin-top: 7px; font-size: 15px; }
    .selling-item p { margin: 7px 0 0; color: var(--muted); font-size: 12px; }
    .selling-item.is-missing { background: var(--warning-soft); border-bottom-color: var(--warning); }
    .facet-grid, .count-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 30px; }
    .bar-facet, .count-group { min-width: 0; }
    .bar-facet h3, .count-group h3 { margin: 0 0 16px; font-size: 15px; }
    .bar-row { margin: 13px 0; }
    .bar-label { display: flex; gap: 14px; justify-content: space-between; align-items: baseline; }
    .bar-label span { min-width: 0; color: var(--ink-soft); font-size: 13px; }
    .bar-label strong { font: 700 13px/1.3 var(--font-data); white-space: nowrap; }
    .bar-track { height: 8px; margin-top: 7px; background: var(--paper-alt); overflow: hidden; }
    .bar-track span { display: block; width: var(--bar-size); height: 100%; background: var(--series-1); }
    .ordinal-list { display: grid; gap: 0; }
    .ordinal-item {
      display: grid;
      grid-template-columns: 58px minmax(0, 1fr);
      gap: 18px;
      padding: 17px 0;
      border-bottom: 1px solid var(--line);
    }
    .ordinal-item > span { color: var(--accent); font: 700 19px/1.3 var(--font-data); }
    .ordinal-item strong { font-size: 16px; }
    .ordinal-item p { margin: 4px 0 0; color: var(--muted); font-size: 13px; }
    .audience-item { position: relative; padding: 18px 0 20px 40px; border-top: 1px solid var(--line-strong); }
    .audience-order { position: absolute; top: 19px; left: 0; }
    .audience-item > strong { display: block; min-height: 48px; }
    .audience-item dl { margin: 12px 0 0; }
    .audience-item dl > div { display: grid; grid-template-columns: 42px minmax(0, 1fr); gap: 8px; margin-top: 7px; }
    .audience-item dt { color: var(--muted); font-size: 12px; }
    .audience-item dd { margin: 0; font-size: 13px; }
    .stacked-bar { display: flex; min-height: 56px; overflow: hidden; background: var(--paper-alt); }
    .stacked-bar > span {
      display: flex;
      width: var(--share);
      min-width: 2px;
      align-items: center;
      justify-content: center;
      color: var(--surface);
    }
    .stacked-bar b {
      padding: 3px 5px;
      color: var(--ink);
      background: var(--surface);
      font: 700 13px/1 var(--font-data);
    }
    .series-1 { background: var(--series-1); }
    .series-2 { background: var(--series-2); }
    .series-3 { background: var(--series-3); }
    .series-4 { background: var(--series-4); }
    .stacked-legend { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 24px; margin-top: 16px; }
    .stacked-legend > div { display: grid; grid-template-columns: 12px minmax(0, 1fr) auto; gap: 8px; align-items: center; }
    .stacked-legend i { width: 10px; height: 10px; }
    .stacked-legend span { color: var(--ink-soft); font-size: 13px; }
    .stacked-legend strong { font: 700 13px/1 var(--font-data); }
    .action-list { counter-reset: action; }
    .action-item { display: grid; grid-template-columns: 52px minmax(0, 1fr); gap: 16px; padding: 18px 0; border-bottom: 1px solid var(--line); }
    .action-item span { color: var(--accent); font: 700 18px/1.4 var(--font-data); }
    .action-item p { margin: 0; }
    .limitation-list { margin: 0; padding: 0; list-style: none; }
    .limitation-list li { position: relative; padding: 12px 0 12px 28px; border-bottom: 1px solid var(--line); }
    .limitation-list li::before { content: "!"; position: absolute; left: 0; color: var(--warning); font: 700 14px/1.7 var(--font-data); }
    .table-wrap { max-width: 100%; margin: 18px 0 26px; overflow: visible; }
    .table-wrap.compact-table table { width: max-content; min-width: min(620px, 100%); max-width: 100%; }
    .table-wrap.wide-table table { table-layout: fixed; font-size: 12px; }
    .table-wrap.wide-table th, .table-wrap.wide-table td { padding: 8px; }
    table {
      width: 100%;
      border-collapse: collapse;
      table-layout: auto;
      overflow-wrap: anywhere;
      font-size: 14px;
    }
    th, td { padding: 11px 12px; border-bottom: 1px solid var(--line); vertical-align: top; text-align: left; }
    th { color: var(--ink); background: var(--paper-alt); font-weight: 700; }
    tbody tr:nth-child(even) td { background: var(--paper); }
    blockquote { margin: 18px 0; padding: 14px 18px; border-left: 4px solid var(--warning); background: var(--warning-soft); color: var(--ink-soft); }
    code { padding: 2px 5px; background: var(--paper-alt); font-family: var(--font-data); font-size: .92em; }
    pre { max-width: 100%; overflow: auto; padding: 16px; background: var(--ink); color: var(--surface); }
    hr { margin: 30px 0; border: 0; border-top: 1px solid var(--line); }
    ul, ol { padding-left: 24px; }
    img { display: block; max-width: 100%; height: auto; }
    .mobile-toc { display: none; }
    @media (max-width: 1080px) {
      .shell { grid-template-columns: 210px minmax(0, 1fr); width: min(100% - 28px, 1120px); gap: 16px; margin-top: 14px; }
      .decision-hero { padding: 44px 38px; gap: 28px; }
      .report-body { padding: 8px 38px 50px; }
      .fact-grid, .selling-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .source-map { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (min-width: 769px) and (max-width: 1080px) {
      .table-wrap.wide-table table { display: block; width: 100%; min-width: 0; max-width: none; }
      .table-wrap.wide-table thead {
        position: absolute;
        width: 1px;
        height: 1px;
        margin: -1px;
        padding: 0;
        overflow: hidden;
        clip: rect(0 0 0 0);
        white-space: nowrap;
        border: 0;
      }
      .table-wrap.wide-table tbody,
      .table-wrap.wide-table tr,
      .table-wrap.wide-table td { display: block; width: 100%; }
      .table-wrap.wide-table tr {
        margin: 0 0 14px;
        padding: 8px 14px;
        background: var(--paper);
        border-left: 3px solid var(--accent);
      }
      .table-wrap.wide-table td {
        display: grid;
        grid-template-columns: minmax(110px, .7fr) minmax(0, 1.5fr);
        gap: 12px;
        padding: 9px 0;
        background: transparent !important;
        border-bottom: 1px solid var(--line);
        overflow-wrap: anywhere;
      }
      .table-wrap.wide-table td:last-child { border-bottom: 0; }
      .table-wrap.wide-table td::before {
        content: attr(data-label);
        color: var(--muted);
        font-size: 12px;
        font-weight: 700;
      }
    }
    @media (max-width: 768px) {
      html { scroll-behavior: auto; }
      .shell { display: block; width: min(100% - 20px, 760px); margin: 10px auto 24px; }
      .toc { display: none; }
      .decision-hero { grid-template-columns: minmax(0, 1fr); min-height: 0; padding: 34px 22px 30px; align-items: start; }
      h1 { max-width: none; font-size: clamp(30px, 10vw, 46px); }
      .hero-thesis { font-size: 16px; }
      .metric-grid { align-self: auto; }
      .report-body { padding: 0 18px 36px; }
      .report-section { padding-top: 38px; }
      h2 { font-size: 25px; }
      .priority-grid, .method-grid, .mainline-grid, .audience-grid, .source-map, .facet-grid, .count-grid { grid-template-columns: minmax(0, 1fr); }
      .fact-grid, .selling-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .stacked-legend { grid-template-columns: minmax(0, 1fr); }
      .mobile-toc {
        display: block;
        margin: 16px 18px 0;
        padding: 12px 14px;
        border-top: 2px solid var(--accent);
        background: var(--paper);
      }
      .mobile-toc summary { cursor: pointer; color: var(--ink); font-weight: 700; }
      .mobile-toc nav { display: grid; margin-top: 10px; }
      .mobile-toc a { padding: 7px 0; border-top: 1px solid var(--line); font-size: 13px; }
      .table-wrap, .table-wrap.compact-table { margin: 18px 0 28px; }
      .table-wrap table, .table-wrap.compact-table table {
        display: block;
        width: 100%;
        min-width: 0;
        max-width: none;
      }
      .table-wrap thead {
        position: absolute;
        width: 1px;
        height: 1px;
        margin: -1px;
        padding: 0;
        overflow: hidden;
        clip: rect(0 0 0 0);
        white-space: nowrap;
        border: 0;
      }
      .table-wrap tbody, .table-wrap tr, .table-wrap td { display: block; width: 100%; }
      .table-wrap tr {
        margin: 0 0 14px;
        padding: 8px 14px;
        background: var(--paper);
        border-left: 3px solid var(--accent);
      }
      .table-wrap td {
        display: grid;
        grid-template-columns: minmax(84px, .7fr) minmax(0, 1.5fr);
        gap: 12px;
        padding: 9px 0;
        background: transparent !important;
        border-bottom: 1px solid var(--line);
        overflow-wrap: anywhere;
      }
      .table-wrap td:last-child { border-bottom: 0; }
      .table-wrap td::before { content: attr(data-label); color: var(--muted); font-size: 12px; font-weight: 700; }
    }
    @media (max-width: 414px) {
      body { font-size: 15px; }
      .shell { width: min(100% - 12px, 414px); margin-top: 6px; }
      .toc { padding: 14px 10px; }
      .decision-hero { padding: 30px 18px 28px; }
      .report-body { padding: 0 14px 30px; }
      .fact-grid, .selling-grid { grid-template-columns: minmax(0, 1fr); }
      .visual-block { padding-top: 20px; }
      .metric-item { grid-template-columns: minmax(0, 1fr); gap: 5px; }
      .metric-item strong { font-size: 23px; }
      .table-wrap td { grid-template-columns: minmax(72px, .62fr) minmax(0, 1.38fr); gap: 9px; }
    }
    @media (prefers-reduced-motion: reduce) {
      html { scroll-behavior: auto; }
    }
    @media print {
      @page { size: A4 portrait; margin: 12mm; }
      @page wide { size: A4 landscape; margin: 10mm; }
      body {
        background: var(--print-paper);
        font-size: 11pt;
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }
      .shell { display: block; width: auto; margin: 0; }
      .toc { display: none; }
      .mobile-toc, .skip-link { display: none !important; }
      .report { box-shadow: none; }
      .decision-hero { min-height: 0; padding: 28px 0 30px; border-top-width: 5px; background: var(--print-paper); break-after: page; }
      .report-body { padding: 0; }
      .report-section { break-before: page; padding-top: 22px; }
      .visual-block { break-inside: avoid; }
      .table-wrap { break-inside: auto; }
      .table-wrap.wide-table { page: wide; }
      .table-wrap.wide-table table { table-layout: fixed !important; font-size: 8.5pt !important; }
      .table-wrap.wide-table th, .table-wrap.wide-table td { padding: 4px 5px !important; }
      .stacked-bar b { color: #111; background: #fff; border: 1px solid #111; }
      table { display: table !important; width: 100% !important; }
      thead { display: table-header-group !important; position: static !important; width: auto !important; height: auto !important; clip: auto !important; }
      tbody { display: table-row-group !important; }
      tr { display: table-row !important; margin: 0 !important; padding: 0 !important; border: 0 !important; background: transparent !important; break-inside: avoid; }
      th, td { display: table-cell !important; width: auto !important; padding: 6px 7px !important; }
      td::before { display: none !important; }
      a { color: var(--ink); text-decoration: none; }
    }`
}

export async function markdownToHtmlDocument(markdown: string): Promise<string> {
  const clean = stripProductVisualBrief(markdown)
  const model = parseHtmlReportModel(markdown)
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
  const decoratedBody = decorateTables(bodyWithoutHero)
  const sectionBody = wrapSections(decoratedBody, model, headings)
  const tokens = THEME_TOKENS[model.brief.designDirection]
  const toc = renderToc(headings)
  const mobileToc = renderMobileToc(headings)
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; font-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';">
  <title>${escapeHtml(model.title)}</title>
  <style>
    /* Hallmark · pre-emit critique: P5 H4 E5 S5 R5 V4 */
    /* Report design read: source-bound decision report for novice business users; variance 5, motion 1, density 6. */
    ${renderStyles(tokens)}
  </style>
</head>
<body data-report-direction="${escapeHtml(model.brief.designDirection)}">
  <a class="skip-link" href="#report-main">跳到报告正文</a>
  <main class="shell">
    ${toc}
    <article class="report" id="report-main" tabindex="-1">
      ${renderHero(model)}
      ${mobileToc}
      <div class="report-body">
        ${sectionBody}
      </div>
    </article>
  </main>
</body>
</html>
`
}
