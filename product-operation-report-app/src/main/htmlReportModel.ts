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

function moduleLines(markdown: string): string[] {
  return markdown
    .split(/\r?\n/u)
    .map((line) => plainText(line).replace(/^#{1,6}\s+/u, '').trim())
    .filter(Boolean)
}

function valueAfter(line: string, label: string): string {
  return line.replace(new RegExp(`^${label}\\s*[：:]\\s*`, 'u'), '').trim()
}

function labeledValue(lines: string[], labels: string[]): string {
  for (let index = 0; index < lines.length; index++) {
    for (const label of labels) {
      if (!new RegExp(`^${label}\\s*[：:]`, 'u').test(lines[index])) continue
      const inline = valueAfter(lines[index], label)
      if (inline) return inline
      const next = lines[index + 1] || ''
      if (next && !/^[\p{Script=Han}A-Za-z0-9 /×*_-]{1,20}\s*[：:]/u.test(next)) return next
    }
  }
  return ''
}

function splitBlocks(lines: string[], pattern: RegExp): Array<{ title: string; lines: string[] }> {
  const blocks: Array<{ title: string; lines: string[] }> = []
  let current: { title: string; lines: string[] } | null = null
  for (const line of lines) {
    if (pattern.test(line)) {
      if (current) blocks.push(current)
      current = { title: line, lines: [] }
    } else if (current) current.lines.push(line)
  }
  if (current) blocks.push(current)
  return blocks
}

function synthesizeModuleTables(number: string, title: string, markdown: string): HtmlReportTable[] {
  const lines = moduleLines(markdown)
  if (number === 'M1') {
    const labels = ['产品基础', 'SKU规格', '价格', '优惠赠品', '原料/成分/材质', '工艺技术', '产品属性与功能', '品牌背书', '产品背书']
    const blocks = splitBlocks(lines, new RegExp(`^(?:\\d+[.、]\\s*)?(?:${labels.join('|')})$`, 'u'))
    const rows = blocks.map((block) => {
      const label = block.title.replace(/^\d+[.、]\s*/u, '')
      const info = block.lines.find((line) => /^信息\s*[：:]/u.test(line)) || ''
      const source = block.lines.find((line) => /^来源\s*[：:]/u.test(line)) || ''
      return [label, valueAfter(info, '信息') || '暂无分析', valueAfter(source, '来源') || '来源未标注']
    })
    return rows.length ? [{ context: '产品九维事实', headers: ['模块', '当前判断', '来源'], rows }] : []
  }
  if (number === 'M2') {
    const dimensions = /^(?:\d+[.、]\s*)?(?:性别|年龄|地域|地区|人群属性|消费力|购买偏好|婚育|城市线级)$/u
    const regionCategory = /(?:省|市|自治区|特别行政区|地区|区域|一线|二线|三线|四线|五线|华东|华南|华北|华中|东北|西北|西南|全国)$/u
    let platform = '平台待确认'
    const rows: string[][] = []
    const seenRows = new Set<string>()
    for (let index = 0; index < lines.length; index++) {
      if (/^平台\s*[：:]/u.test(lines[index])) {
        platform = valueAfter(lines[index], '平台') || platform
        continue
      }
      if (!dimensions.test(lines[index])) continue
      const dimension = lines[index].replace(/^\d+[.、]\s*/u, '')
      const info = lines.slice(index + 1, index + 5).find((line) => /^信息(?:冲突)?\s*[：:]/u.test(line)) || ''
      const source = lines.slice(index + 1, index + 6).find((line) => /^来源\s*[：:]/u.test(line)) || ''
      const value = info.replace(/^信息(?:冲突)?\s*[：:]\s*/u, '').trim()
      const items = value.split(/[，,；;]/u).map((item) => item.trim()).filter(Boolean)
      for (const item of items.length ? items : [value || '暂无分析']) {
        const metric = item.match(/^(.*?)([+-]?\d+(?:\.\d+)?\s*%)(?:\s*(?:（[^）]*）|\([^)]*\)))?\s*[。；;，,]?\s*$/u)
        const category = metric?.[1]?.trim() || dimension
        const effectiveDimension = /^(?:地域|地区)$/u.test(dimension) && !regionCategory.test(category) ? '' : dimension
        if (!effectiveDimension) continue
        const row = [platform, effectiveDimension, category, metric?.[2] || item, valueAfter(source, '来源') || '来源未标注']
        const key = row.slice(0, 4).join('\u0000')
        if (seenRows.has(key)) continue
        seenRows.add(key)
        rows.push(row)
      }
    }
    const tables: HtmlReportTable[] = rows.length
      ? [{ context: '分平台成交画像', headers: ['平台', '维度', '类别', '数据', '来源'], rows }]
      : []
    const audienceTable = parseSectionDetails(markdown).tables.find((table) =>
      table.headers.some((header) => /优先级/u.test(header)) && table.headers.some((header) => /人群标签/u.test(header))
    )
    if (audienceTable) tables.push({ ...audienceTable, context: '多平台核心人群TOP5' })
    return tables
  }
  if (number === 'M3') {
    const blocks = splitBlocks(lines, /^(?:自有框架|竞品框架|机会)\d+|^(?:自有素材TOP|竞品素材TOP|补充机会TOP)\d+/u)
    const buckets = [
      { context: '自有素材', pattern: /^(?:自有框架|自有素材TOP)/u },
      { context: '竞品素材', pattern: /^(?:竞品框架|竞品素材TOP)/u },
      { context: '补充机会', pattern: /^(?:机会|补充机会TOP)/u }
    ]
    return buckets.flatMap((bucket) => {
      const rows = blocks.filter((block) => bucket.pattern.test(block.title)).map((block) => {
        const framework = labeledValue(block.lines, ['框架类型', '机会框架'])
        const basis = labeledValue(block.lines, ['数据依据', '竞品依据'])
        const reuse = labeledValue(block.lines, ['可复用方向', '可补充方向'])
        return [framework || block.title, basis || '数量依据见模块原文', reuse || '暂无分析']
      })
      return rows.length ? [{ context: bucket.context, headers: ['类型', '数据依据', '可复用方向'], rows }] : []
    })
  }
  if (number === 'M4' && /对标/u.test(title)) {
    const blocks = splitBlocks(lines, /^(?:同产品|同类目|同人群|同卖点|同痛点|同情绪|同解决方案)$/u)
    const rows = blocks.map((block) => {
      const brands = block.lines.filter((line) => /^品牌\s*[：:]/u.test(line)).map((line) => valueAfter(line, '品牌')).join('、')
      const sources = block.lines.filter((line) => /^来源\s*[：:]/u.test(line)).map((line) => valueAfter(line, '来源')).join('；')
      const reasons = block.lines.filter((line) => /^(?:推荐理由|理由)\s*[：:]/u.test(line)).map((line) => line.replace(/^(?:推荐理由|理由)\s*[：:]\s*/u, '')).join('；')
      return [block.title, [brands || '暂无可靠对标', sources].filter(Boolean).join('｜'), reasons || block.lines.find((line) => /暂无可靠对标/u.test(line)) || '来源约束下暂无可靠结论']
    })
    return rows.length ? [{ context: '七维对标证据', headers: ['数据类型', '来源', '本次用途'], rows }] : []
  }
  if ((number === 'M4' && /卖点/u.test(title)) || (number === 'M5' && !/VOC|用户真实需求/iu.test(title))) {
    const blocks = splitBlocks(lines, /^(?:\d+[.、]\s*)?(?:品质需求|价格需求|健康需求|情感需求)$/u)
    const rows = blocks.flatMap((block) => {
      const category = block.title.replace(/^\d+[.、]\s*/u, '')
      const topBlocks = splitBlocks(block.lines, /^TOP\s*\d+/iu)
      if (!topBlocks.length) return [[category, block.lines[0] || '暂无分析', block.lines.slice(1).join('；') || '依据见模块原文']]
      return topBlocks.map((item) => {
        const selling = item.lines.find((line) => /^卖点\s*[：:]/u.test(line)) || ''
        const benefit = item.lines.find((line) => /^买点\s*[：:]/u.test(line)) || ''
        return [category, [valueAfter(selling, '卖点'), valueAfter(benefit, '买点')].filter(Boolean).join('｜'), '来源：M1产品事实与M3素材证据']
      })
    })
    const tables: HtmlReportTable[] = rows.length
      ? [{ context: '四类消费者买点', headers: ['卖点维度', '我方产品卖点', '证据'], rows }]
      : []
    const rankBlocks = splitBlocks(lines, /^TOP\s*\d{1,2}\s*[｜|]\s*\S/iu)
    const rankedRows = rankBlocks.map((block) => {
      const titleMatch = block.title.match(/^TOP\s*(\d{1,2})\s*[｜|]\s*(.+)$/iu)
      const read = (label: string): string => labeledValue(block.lines, [label])
      return [
        titleMatch ? `TOP${titleMatch[1]}` : block.title,
        titleMatch?.[2]?.trim() || '暂无分析',
        read('需求类型'),
        read('买点'),
        read('卖点状态'),
        read('排序判断'),
        [read('自营来源'), read('竞品来源')].filter(Boolean).join('；') || '来源未标注'
      ]
    })
    if (rankedRows.length) {
      tables.push({
        context: '真实卖点统一排序',
        headers: ['排序', '真实卖点', '需求类型', '消费者买点', '状态', '排序判断', '来源'],
        rows: rankedRows
      })
    }
    return tables
  }
  if ((number === 'M5' && /VOC|用户真实需求/iu.test(title)) || (number === 'M6' && !/人群.*卖点.*场景/u.test(title))) {
    const groups = splitBlocks(lines, /^\d+[.、]\s*(?:隐形需求|购买顾虑|高频问题|正向反馈)\s*TOP10$/iu)
    return groups.flatMap((group) => {
      const groupName = group.title.replace(/^\d+[.、]\s*/u, '').replace(/\s*TOP10$/iu, '')
      const termLabel = groupName === '购买顾虑' ? '顾虑' : groupName === '高频问题' ? '问题' : groupName === '正向反馈' ? '反馈' : '需求'
      const items = splitBlocks(group.lines, /^TOP\s*\d+$/iu)
      const rows = items.map((item) => {
        const frequencyLine = labeledValue(item.lines, ['频次'])
        const frequency = frequencyLine.match(/\d+(?:\.\d+)?\s*次/u)?.[0] || frequencyLine.split(/[｜|]/u)[0] || ''
        const share = frequencyLine.match(/占比\s*([\d.]+%)/u)?.[1] || ''
        return [
          item.title.replace(/\s+/gu, ''),
          labeledValue(item.lines, [termLabel]) || '未命名需求',
          frequency,
          share,
          labeledValue(item.lines, ['来源分布']),
          labeledValue(item.lines, ['代表原话']),
          labeledValue(item.lines, ['来源']),
          labeledValue(item.lines, ['认可类型']),
          labeledValue(item.lines, ['认可价值'])
        ]
      })
      return rows.length
        ? [{
            context: groupName,
            headers: ['排名', '需求词', '频次', '占比', '来源分布', '代表原话', '来源', '认可类型', '认可价值'],
            rows
          }]
        : []
    })
  }
  if (number === 'M7') {
    const rows: string[][] = []
    let tier = ''
    for (const line of lines) {
      if (/核心主卖点|重要辅助卖点|补充测试卖点/u.test(line)) tier = line
      const match = line.match(/^(TOP\s*\d+|\d+[.、])\s*(.*)$/iu)
      if (match) rows.push([match[1].replace(/\s+/g, ''), match[2] || '暂无分析', tier, '', '依据见模块原文'])
    }
    return rows.length ? [{ context: '真实卖点排序', headers: ['排序', '用户视角卖点', '层级', '来源', '依据'], rows }] : []
  }
  if (number === 'M8' || (number === 'M6' && /人群.*卖点.*场景/u.test(title))) {
    const blocks = splitBlocks(lines, /^TOP\s*[1-5]\b/iu)
    const read = (block: { lines: string[] }, labels: string[]): string => {
      for (const label of labels) {
        const line = block.lines.find((item) => new RegExp(`^${label}\\s*[：:]`, 'u').test(item)) || ''
        if (line) return valueAfter(line, label)
      }
      return ''
    }
    const rows = blocks.map((block) => [
      block.title.replace(/\s+/g, ''),
      read(block, ['核心人群']),
      read(block, ['核心卖点']),
      read(block, ['真实场景']),
      [read(block, ['人群来源', '人群依据']), read(block, ['卖点来源', '卖点依据']), read(block, ['场景来源', '场景依据'])].filter(Boolean).join('；')
    ])
    return rows.length ? [{ context: '人群卖点场景匹配', headers: ['排序', '成交人群', '核心卖点', '核心场景', '数据依据'], rows }] : []
  }
  return []
}

export function parseHtmlReportModel(markdown: string): HtmlReportModel {
  const clean = stripProductVisualBrief(markdown)
  const lines = clean.split(/\r?\n/)
  const sections: HtmlReportSection[] = []
  let current: { number: string; title: string; lines: string[] } | null = null
  const flush = (): void => {
    if (!current) return
    const sectionMarkdown = current.lines.join('\n').trim()
    const details = parseSectionDetails(sectionMarkdown)
    sections.push({
      number: current.number,
      title: current.title,
      markdown: sectionMarkdown,
      ...details,
      tables: (() => {
        const synthesized = synthesizeModuleTables(current.number, current.title, sectionMarkdown)
        if (!details.tables.length) return synthesized
        if (current.number === 'M2' || (current.number === 'M4' && /卖点/u.test(current.title))) {
          const keys = new Set(synthesized.map((table) => `${table.context}\u0000${table.headers.join('\u0000')}`))
          return [...synthesized, ...details.tables.filter((table) => !keys.has(`${table.context}\u0000${table.headers.join('\u0000')}`))]
        }
        return details.tables
      })()
    })
  }
  for (const line of lines) {
    const hit = line.match(/^##\s+(?:(\d+)\.\s+|((?:M[1-8]|A\d+))\s+)(.+?)\s*$/u)
    if (hit) {
      flush()
      current = { number: hit[1] || hit[2], title: plainText(hit[3]), lines: [] }
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
