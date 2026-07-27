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

export function decodeHtmlEntities(value: string): string {
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

export function plainText(value: string): string {
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

export function shorten(value: string, max = 86): string {
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
  const content = stripProductVisualBrief(markdown).toLowerCase()
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
      score: keywords.reduce((count, keyword) => count + (content.includes(keyword) ? 1 : 0), 0)
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
  const hasRequiredEvidence =
    requiredFields.every(
      (field) =>
        Boolean(field?.trim()) &&
        !/需补充|待补|待确认|未知|unknown|not available|n\/a/i.test(field || '')
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

function parseSectionDetails(
  markdown: string
): Pick<HtmlReportSection, 'paragraphs' | 'listItems' | 'tables'> {
  const paragraphs: string[] = []
  const listItems: string[] = []
  const tables: HtmlReportTable[] = []
  let context = ''
  const tokens = marked.lexer(markdown) as Array<Record<string, unknown>>
  for (const token of tokens) {
    if (token.type === 'heading' && token.depth === 3) {
      context = plainText(String(token.text || ''))
    } else if (token.type === 'paragraph') {
      const content = plainText(String(token.text || ''))
      if (content) paragraphs.push(content)
    } else if (token.type === 'list' && Array.isArray(token.items)) {
      for (const item of token.items as Array<{ text?: string }>) {
        const content = plainText(item.text || '')
        if (content) listItems.push(content)
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
