import type {
  ChatMessage,
  ModelTaskType,
  ModuleKey,
  ModulePrompt,
  ReportEngineVersion,
  ReportModule,
  SearchEvidence,
  SearchVerificationStatus,
  SourceKindV1,
  ModuleRunState
} from '../../shared/types'
import { REPORT_MODULES_V2, SOURCE_KIND_LABELS } from '../../shared/types'

export interface ModuleSourceBlock {
  name: string
  kindV1: SourceKindV1
  attribution?: string
  platform?: string
  text: string
}

export interface ModuleContext {
  prompt: ModulePrompt
  sources: ModuleSourceBlock[]
  upstream: Array<{ key: ModuleKey; title: string; output: string }>
  missingDependencies: string[]
  requirements?: string
}

export interface SourceSufficiency {
  available: Set<SourceKindV1>
  skipped: Map<ModuleKey, string>
  partial: Map<ModuleKey, string>
  blocked: string | null
}

export interface BenchmarkVerification {
  status: SearchVerificationStatus
  evidence: SearchEvidence[]
}

export function evaluateSourceSufficiency(
  modules: ReportModule[],
  kinds: Array<SourceKindV1 | undefined>
): SourceSufficiency {
  const available = new Set(kinds.filter((kind): kind is SourceKindV1 => Boolean(kind)))
  const skipped = new Map<ModuleKey, string>()
  const partial = new Map<ModuleKey, string>()
  for (const module of modules) {
    if (!module.requiredSources.length) continue
    const missing = module.requiredSources.filter((kind) => !available.has(kind))
    if (!missing.length) continue
    const labels = missing.map((kind) => SOURCE_KIND_LABELS[kind]).join('、')
    const hasAnyUsableSource = module.requiredSources.some((kind) => available.has(kind))
    if (hasAnyUsableSource) partial.set(module.key, `未上传${labels}，本模块仅根据现有资料分析。`)
    else skipped.set(module.key, `暂无分析：未上传${labels}。`)
  }
  return { available, skipped, partial, blocked: null }
}

export const MODULE_TASK_TYPES: Record<ModuleKey, ModelTaskType> = {
  'product-info': 'module_product_info',
  'platform-audience': 'module_platform_audience',
  'material-review': 'module_material_review',
  'benchmark-brands': 'module_benchmark',
  'selling-points': 'module_selling_points',
  voc: 'module_voc',
  'selling-point-ranking': 'module_ranking',
  'audience-sp-scene': 'module_audience_sp_scene'
}

export function isNoAnalysisOutput(text: string): boolean {
  const value = text.trim()
  if (/^暂无分析/u.test(value)) return true
  if (value.length > 1_500) return false
  return /暂无可分析|暂无可确认的真实(?:产品)?卖点|无有效(?:组合|结果|数据)可输出|无[（(][^）)]*缺失|资料不足[^。\n]*(?:无法|不能)|缺少[^。\n]*(?:无法|不能)/u.test(value)
}

export function normalizeNoAnalysisOutput(text: string): string {
  const value = text.trim()
  return value.startsWith('暂无分析') ? value : `暂无分析：${value}`
}

export function fingerprintModuleMessages(messages: ChatMessage[], engineVersion: ReportEngineVersion = 'v2'): string {
  const value = JSON.stringify(messages)
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${engineVersion}-${(hash >>> 0).toString(16).padStart(8, '0')}-${value.length}`
}

const BENCHMARK_PLATFORMS = ['天猫', '抖音', '视频号', '小红书'] as const
const BENCHMARK_PLACEHOLDER = /品牌\s*[A-Z甲乙丙丁]|某品牌|示例品牌|TOP\s*\d+|自有框架\d+|竞品框架\d+/iu

function benchmarkCoverage(evidence: SearchEvidence[]): string {
  const found = new Set(evidence.map((item) => item.platform))
  return `平台覆盖：${[
    ...BENCHMARK_PLATFORMS.map((platform) => `${platform}${found.has(platform) ? '找到可靠来源' : '未找到可靠来源'}`),
    `其他公开来源${found.has('其他') ? '找到可靠来源' : '未找到可靠来源'}`
  ].join('｜')}`
}

function benchmarkEvidenceList(evidence: SearchEvidence[]): string {
  return evidence.slice(0, 12).map((item, index) =>
    `${index + 1}. ${item.platform}｜${item.title || '公开页面'}｜${item.url}`
  ).join('\n')
}

function verifiedRecommendationBlocks(body: string, evidence: SearchEvidence[]): string[] {
  const evidenceUrls = new Set(evidence.map((item) => item.url))
  return body.split(/(?=推荐\s*\d+)/u).flatMap((block) => {
    if (!/^推荐\s*\d+/u.test(block.trim())) return []
    const brand = block.match(/品牌\s*[：:]\s*([^\r\n]+)/u)?.[1]?.trim() || ''
    if (!brand || BENCHMARK_PLACEHOLDER.test(brand)) return []
    if (!/对标产品\/系列\s*[：:]\s*\S/u.test(block)) return []
    if (!/匹配点\s*[：:]\s*\S/u.test(block) || !/推荐理由\s*[：:]\s*\S/u.test(block)) return []
    const urls = block.match(/https?:\/\/[^\s)>\]｜]+/gu) || []
    if (!urls.some((url) => evidenceUrls.has(url.replace(/[，。；,.;]+$/u, '')))) return []
    return [block.trim()]
  }).slice(0, 3)
}

export function normalizeBenchmarkDimension(
  dimension: string,
  raw: string,
  verification?: BenchmarkVerification
): string {
  const value = raw.trim()
  const unavailable = (reason: string): string => [
    `### ${dimension}`,
    verification?.status === 'attempted' ? '检索状态：已尝试联网检索，但未取得可核验来源' : '检索状态：仅基于已上传资料',
    benchmarkCoverage([]),
    '',
    '暂无可靠对标',
    '',
    `说明：${reason}`
  ].join('\n')
  if (!value || /暂无可靠对标/u.test(value) && value.length < 120) {
    return unavailable('本轮没有取得可追溯的公开页面、官方账号或用户资料证据。')
  }
  const heading = new RegExp(`#{1,6}\\s*${dimension.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'u')
  const match = heading.exec(value)
  const body = (match ? value.slice((match.index || 0) + match[0].length) : value)
    .split(/\r?\n/u)
    .filter((line) => !/^\s*(?:我会|我正在|接下来|下面将|本次将)/u.test(line))
    .join('\n')
    .trim()
  if (verification) {
    const evidence = verification.evidence.filter((item, index, all) =>
      all.findIndex((candidate) => candidate.url === item.url) === index
    )
    if (verification.status === 'verified' && evidence.length) {
      const recommendations = verifiedRecommendationBlocks(body, evidence)
      if (!recommendations.length) {
        return [
          `### ${dimension}`,
          `检索状态：已核验公开来源 ${evidence.length} 条`,
          benchmarkCoverage(evidence),
          '',
          '暂无可靠对标',
          '',
          '说明：公开来源已返回，但模型没有给出字段完整、来源可反查的品牌推荐。',
          '',
          '已核验来源：',
          benchmarkEvidenceList(evidence)
        ].join('\n')
      }
      const latest = evidence.map((item) => Date.parse(item.retrievedAt)).filter(Number.isFinite).sort((a, b) => b - a)[0]
      return [
        `### ${dimension}`,
        `检索状态：已核验公开来源 ${evidence.length} 条`,
        latest ? `检索时间：${new Date(latest).toISOString()}` : '',
        benchmarkCoverage(evidence),
        '',
        recommendations.join('\n\n'),
        '',
        '已核验来源：',
        benchmarkEvidenceList(evidence)
      ].filter(Boolean).join('\n')
    }
    if (/来源\s*[：:]\s*用户资料/u.test(body) && /品牌\s*[：:]\s*\S/u.test(body) && !BENCHMARK_PLACEHOLDER.test(body)) {
      return `### ${dimension}\n检索状态：仅基于已上传资料\n${benchmarkCoverage([])}\n\n${body}`
    }
    return unavailable('CCG没有返回同时包含结构化搜索调用和公网来源链接的结果，软件未将模型记忆当作搜索证据。')
  }
  if (
    !/品牌\s*[：:]/u.test(body) &&
    /联网检索工具|无法联网检索|未完成联网检索|未完成检索|未执行.*联网检索/u.test(body)
  ) {
    return unavailable('本轮没有取得可追溯的公开页面或官方账号结果。')
  }
  if (!/品牌\s*[：:]/u.test(body) && !/来源\s*[：:]/u.test(body)) {
    return unavailable('本轮没有取得可追溯的公开页面或官方账号结果。')
  }
  return `### ${dimension}\n${body || '暂无可靠对标'}`
}

export function normalizeBenchmarkOutput(raw: string): string {
  const dimensions = ['同产品', '同类目', '同人群', '同卖点', '同痛点', '同情绪', '同解决方案']
  return dimensions.map((dimension, index) => {
    const start = raw.search(new RegExp(`#{1,6}\\s*${dimension}`, 'u'))
    if (start < 0) return normalizeBenchmarkDimension(dimension, '暂无可靠对标')
    const nextDimension = dimensions[index + 1]
    const tail = raw.slice(start)
    const next = nextDimension ? tail.search(new RegExp(`\\n#{1,6}\\s*${nextDimension}`, 'u')) : -1
    return normalizeBenchmarkDimension(dimension, next >= 0 ? tail.slice(0, next) : tail)
  }).join('\n\n')
}

export function normalizeMaterialReviewOutput(raw: string): string {
  const replaceGroup = (value: string, pattern: RegExp, label: string, field: string): string =>
    value.replace(pattern, (full, hashes: string, rank: string, body: string) => {
      const match = body.match(new RegExp(`${field}\\s*[：:]\\s*(?:\\r?\\n\\s*)?([^\\r\\n]+)`, 'u'))
      const framework = match?.[1]?.trim()
      const heading = hashes || '### '
      return framework ? `${heading}${label}TOP${rank}｜${framework}${body}` : full
    })
  const boundary = '(?=^(?:#{1,6}\\s*)?(?:自有框架|竞品框架|机会)[1-5]\\s*$|(?![\\s\\S]))'
  let value = replaceGroup(raw, new RegExp(`^((?:#{1,6}\\s*)?)自有框架([1-5])([\\s\\S]*?)${boundary}`, 'gmu'), '自有素材', '框架类型')
  value = replaceGroup(value, new RegExp(`^((?:#{1,6}\\s*)?)竞品框架([1-5])([\\s\\S]*?)${boundary}`, 'gmu'), '竞品素材', '框架类型')
  return replaceGroup(value, new RegExp(`^((?:#{1,6}\\s*)?)机会([1-5])([\\s\\S]*?)${boundary}`, 'gmu'), '补充机会', '机会框架')
}

export function findStaleModuleKeys(
  modules: ReportModule[],
  states: Partial<Record<ModuleKey, ModuleRunState>>
): Set<ModuleKey> {
  const stale = new Set<ModuleKey>()
  let changed = true
  while (changed) {
    changed = false
    for (const module of modules) {
      if (stale.has(module.key) || module.dependsOn.length === 0) continue
      const state = states[module.key]
      if (!state || (state.status !== 'done' && state.status !== 'skipped')) continue
      const currentTime = Date.parse(state.updatedAt)
      const hasNewerOrStaleDependency = module.dependsOn.some((dependency) => {
        if (stale.has(dependency)) return true
        const dependencyState = states[dependency]
        return Boolean(dependencyState && Date.parse(dependencyState.updatedAt) > currentTime)
      })
      if (hasNewerOrStaleDependency) {
        stale.add(module.key)
        changed = true
      }
    }
  }
  return stale
}

export function retryScopeForModules(
  modules: ReportModule[],
  states: Partial<Record<ModuleKey, ModuleRunState>>,
  requestedKey: ModuleKey
): Set<ModuleKey> {
  const affected = new Set<ModuleKey>([requestedKey])
  for (const module of modules) {
    if (states[module.key]?.status === 'failed') affected.add(module.key)
  }
  let changed = true
  while (changed) {
    changed = false
    for (const module of modules) {
      if (!affected.has(module.key) && module.dependsOn.some((dependency) => affected.has(dependency))) {
        affected.add(module.key)
        changed = true
      }
    }
  }
  return affected
}

export function buildModuleMessages(module: ReportModule, context: ModuleContext): ChatMessage[] {
  const sourceText = context.sources.length
    ? context.sources.map((source, index) => [
        `### 来源 ${index + 1}：${source.name}`,
        `业务类型：${SOURCE_KIND_LABELS[source.kindV1]}`,
        source.attribution ? `归属：${source.attribution}` : '',
        source.platform ? `平台：${source.platform}` : '',
        source.text
      ].filter(Boolean).join('\n')).join('\n\n')
    : '没有直接上传资料；只能使用下方已有模块产出，不得补充外部事实。'
  const upstream = context.upstream.length
    ? context.upstream.map((item) => `### ${item.title}\n${item.output}`).join('\n\n')
    : '无'
  const missing = context.missingDependencies.length
    ? `\n\n## 缺失依赖\n${context.missingDependencies.map((item) => `- ${item}`).join('\n')}\n必须在结果中明确注明这些限制。`
    : ''
  const runtimeOverride = module.key === 'material-review'
    ? [
        '## 当前软件的素材框架归纳规则',
        '若上传表已经有脚本框架类型、开头21式、中段种草维度和结尾6式，直接按原字段汇总。',
        '若这些预标字段缺失，但存在完整文案、前三秒文案、3.x分类、内容形式、视角或标签，不得整章拒绝；必须逐条读取已有内容并进行有证据的“系统归纳”。',
        '系统归纳时按证据强度输出最多5条自有框架、最多5条竞品框架和最多5条补充机会；证据不足可以少于5条，禁止用占位项补齐。框架名称必须直接写出“3.x分类｜具体框架类型｜开头结构｜中段表达｜结尾结构”，不得只写“自有框架1/竞品框架1”。',
        '每个框架必须写数据依据、主要人群和完整可复用方向；机会必须写竞品依据、自有现状和可补充方向。无法确认的单个字段写“未单独标注”，但不能因为缺少预标字段而停止归纳。',
        '所有归纳只能来自本次素材的实际文案和标签，禁止补充素材中不存在的产品事实、功效、价格或案例。',
        '如果资料中完全没有足以识别任何具体框架的文案、标签或结构，只输出：暂无分析：素材缺少可识别的文案或结构。'
      ].join('\n')
    : module.key === 'selling-points'
      ? [
          '## 当前软件的卖点真实性兜底规则',
          '若缺少能够证明当前产品真实能力的产品事实，不得仅凭自营或竞品素材创造卖点。',
          '完全无法确认真实卖点时，只输出：暂无分析：缺少产品事实，无法确认当前产品的真实卖点。',
          '若只有部分证据，继续输出能够确认的真实卖点，并在自营依据、竞品依据或来源字段中明确写“无”；不得因为证据不齐而停止其他模块。'
        ].join('\n')
      : ''
  return [
    { role: 'system', content: context.prompt.systemPrompt },
    {
      role: 'user',
      content: [
        `# 当前任务：M${module.id} ${module.title}`,
        '## 本模块可用的清洗后资料',
        sourceText,
        '## 上游模块产出',
        upstream,
        missing,
        context.requirements ? `## 用户补充要求\n${context.requirements}` : '',
        runtimeOverride,
        '## 固定输出模板',
        context.prompt.outputTemplate,
        '只输出最终结果，不输出思考过程。所有事实、数字、频次、比例和品牌必须带真实来源。'
      ].filter(Boolean).join('\n\n')
    }
  ]
}

function ordered(text: string, labels: string[]): boolean {
  let cursor = -1
  for (const label of labels) {
    const next = text.indexOf(label, cursor + 1)
    if (next < 0) return false
    cursor = next
  }
  return true
}

const MATERIAL_PLACEHOLDER = /(?:自有框架|竞品框架|补充机会|机会)\s*\d+|框架\s*[A-Z甲乙丙丁]|TOP\s*\d+\s*[：:]?\s*(?:框架|待补充)/iu
const AUDIENCE_ATTRIBUTE_TAG = /(?:都市银发|小镇中老年|精致妈妈|新锐白领|资深中产|Z世代)/u
const FAKE_SCORE = /(?:综合|卖点|价值|机会|推荐|核心度|匹配度)(?:评分|得分|指数|权重)\s*[：:]?\s*\d/iu

function extractRankedSellingPointNames(value: string): string[] {
  return [...value.matchAll(/^#{0,6}\s*TOP\s*(\d{1,2})\s*[｜|]\s*([^\r\n{]+)$/gimu)]
    .sort((left, right) => Number(left[1]) - Number(right[1]))
    .map((match) => match[2].trim())
}

const VOC_GROUPS = [
  { heading: '1. 隐形需求 TOP10', term: '需求', positive: false },
  { heading: '2. 购买顾虑 TOP10', term: '顾虑', positive: false },
  { heading: '3. 高频问题 TOP10', term: '问题', positive: false },
  { heading: '4. 正向反馈 TOP10', term: '反馈', positive: true }
] as const

function validateVocGroups(value: string): string[] {
  const errors: string[] = []
  if (!ordered(value, VOC_GROUPS.map((group) => group.heading))) {
    errors.push('VOC必须按顺序完整包含隐形需求、购买顾虑、高频问题、正向反馈四组TOP10')
    return errors
  }
  for (let index = 0; index < VOC_GROUPS.length; index++) {
    const group = VOC_GROUPS[index]
    const start = value.indexOf(group.heading)
    const end = index + 1 < VOC_GROUPS.length ? value.indexOf(VOC_GROUPS[index + 1].heading, start + group.heading.length) : value.length
    const section = value.slice(start, end < 0 ? value.length : end)
    const itemMatches = [...section.matchAll(/^#{0,6}\s*TOP\s*(\d{1,2})\s*$/gimu)]
    const ranks = itemMatches.map((match) => Number(match[1]))
    if (ranks.length !== 10 || ranks.some((rank, rankIndex) => rank !== rankIndex + 1)) {
      errors.push(`${group.heading}必须完整包含TOP1-TOP10`)
    }
    const missingFields = new Set<string>()
    for (let itemIndex = 0; itemIndex < itemMatches.length; itemIndex++) {
      const itemStart = itemMatches[itemIndex].index || 0
      const itemEnd = itemIndex + 1 < itemMatches.length ? itemMatches[itemIndex + 1].index || section.length : section.length
      const item = section.slice(itemStart, itemEnd)
      for (const field of [group.term, '频次', '来源分布', '代表原话', '来源']) {
        if (!new RegExp(`^${field}\\s*[：:]\\s*\\S+`, 'mu').test(item)) missingFields.add(field)
      }
      if (!/(?:^|[｜|]\s*)占比(?:\s*[：:]\s*|\s*)\S+/mu.test(item)) missingFields.add('占比')
      if (group.positive) {
        for (const field of ['认可类型', '认可价值']) {
          if (!new RegExp(`^${field}\\s*[：:]\\s*\\S+`, 'mu').test(item)) missingFields.add(field)
        }
      }
    }
    for (const field of missingFields) errors.push(`${group.heading}每条都必须包含${field}`)
  }
  return errors
}

export function validateModuleOutput(
  key: ModuleKey,
  text: string,
  engineVersion: ReportEngineVersion = 'v2'
): string[] {
  const value = text.trim()
  if (!value) return ['模块没有返回内容']
  if (isNoAnalysisOutput(value)) return []
  const errors: string[] = []
  if (key === 'product-info') {
    const labels = ['1. 产品基础', '2. SKU规格', '3. 价格', '4. 优惠赠品', '5. 原料/成分/材质', '6. 工艺技术', '7. 产品属性与功能', '8. 品牌背书', '9. 产品背书']
    if (!ordered(value, labels)) errors.push('产品信息9个维度缺失或顺序错误')
    if ((value.match(/信息：/gu) || []).length < 9 || (value.match(/来源：/gu) || []).length < 9) errors.push('产品信息必须逐维提供信息和来源')
  }
  if (key === 'platform-audience') {
    if (engineVersion === 'v1') {
      if (!/平台|成交人群/u.test(value)) errors.push('平台人群模块缺少平台或成交人群结果')
    } else {
      const platformCount = (value.match(/^(?:#{1,4}\s*)?平台\s*[：:]/gmu) || []).length
      if (platformCount < 1) errors.push('成交人群模块没有按平台输出画像')
      for (const dimension of ['1. 性别', '2. 年龄', '3. 地域', '4. 人群属性', '5. 消费力', '6. 购买偏好']) {
        if ((value.match(new RegExp(`^(?:#{1,4}\\s*)?${dimension.replace('.', '\\.')}`, 'gmu')) || []).length < platformCount) {
          errors.push(`成交人群模块缺少${dimension}`)
        }
      }
      if ((value.match(/信息\s*[：:]/gu) || []).length < platformCount * 6) errors.push('成交人群模块必须逐平台逐维输出信息')
      if ((value.match(/来源\s*[：:]/gu) || []).length < platformCount * 6) errors.push('成交人群模块必须逐平台逐维标注来源')
      if (!/多平台核心人群\s*TOP5/iu.test(value)) errors.push('成交人群模块缺少多平台核心人群TOP5')
      if (/跨平台(?:综合)?占比|综合占比|平均占比/u.test(value)) errors.push('成交人群模块不得生成跨平台综合或平均占比')
      const audienceTagInRegion = value.split(/^(?:#{1,4}\s*)?平台\s*[：:]/gmu).slice(1).some((platformBlock) => {
        const regionAt = platformBlock.search(/^(?:#{1,4}\s*)?3\.\s*地域\s*$/mu)
        if (regionAt < 0) return false
        const tail = platformBlock.slice(regionAt)
        const attributeAt = tail.search(/^(?:#{1,4}\s*)?4\.\s*人群属性\s*$/mu)
        return AUDIENCE_ATTRIBUTE_TAG.test(attributeAt >= 0 ? tail.slice(0, attributeAt) : tail)
      })
      if (audienceTagInRegion) errors.push('成交人群模块把人群属性误写成了地域')
      if (/(?:视频号|抖音|天猫|淘宝|小红书|快手)\s*\/\s*(?:性别|年龄|地域|消费力|购买偏好)占比/iu.test(value)) {
        errors.push('成交人群模块存在含义不清的“平台/维度占比”标签')
      }
    }
  }
  if (key === 'material-review') {
    if (engineVersion === 'v1') {
      for (const [prefix, normalized] of [['自有框架', '自有素材TOP'], ['竞品框架', '竞品素材TOP'], ['机会', '补充机会TOP']]) {
        for (let index = 1; index <= 5; index++) {
          if (!value.includes(`${prefix}${index}`) && !value.includes(`${normalized}${index}`)) errors.push(`素材模块缺少${prefix}${index}`)
        }
      }
    }
    if (MATERIAL_PLACEHOLDER.test(value)) errors.push('素材模块包含“框架1”等无含义占位名称')
    if (!/框架类型\s*[：:]|具体框架|开头结构/u.test(value)) errors.push('素材模块缺少具体框架名称或结构')
    if (!/可复用方向\s*[：:]/u.test(value)) errors.push('素材模块缺少可复用方向')
  }
  if (key === 'benchmark-brands' && !ordered(value, ['同产品', '同类目', '同人群', '同卖点', '同痛点', '同情绪', '同解决方案'])) {
    errors.push('对标模块必须完整包含7个固定维度并保持顺序')
  }
  if (key === 'benchmark-brands' && BENCHMARK_PLACEHOLDER.test(value)) errors.push('对标模块包含无明确对象的占位品牌或排名')
  if (key === 'selling-points') {
    if (!ordered(value, ['品质需求', '价格需求', '健康需求', '情感需求'])) errors.push('卖点模块缺少四大需求分类或顺序错误')
    if (engineVersion === 'v2') {
      if (!/核心卖点总排序/u.test(value)) errors.push('卖点模块缺少统一核心卖点排序')
      const names = extractRankedSellingPointNames(value)
      if (names.length < 1) errors.push('卖点模块没有输出带真实名称的TOP卖点')
      if (new Set(names).size !== names.length) errors.push('卖点模块总排序存在重复卖点')
      if (/TOP\s*\d+\s*[｜|]\s*\{?\s*(?:卖点名称|真实卖点名称)\s*\}?/iu.test(value)) errors.push('卖点模块仍包含TOP卖点占位名称')
      if (FAKE_SCORE.test(value)) errors.push('卖点模块包含无来源的综合评分或指数')
      for (const field of ['需求类型', '买点', '自营依据', '竞品依据', '卖点状态', '排序判断', '自营来源', '竞品来源']) {
        if ((value.match(new RegExp(`${field}\\s*[：:]`, 'gu')) || []).length < names.length) errors.push(`卖点模块排序项缺少${field}`)
      }
    }
  }
  if (key === 'voc') errors.push(...validateVocGroups(value))
  if (key === 'selling-point-ranking' && engineVersion === 'v1' && !/TOP\s*10|TOP1|核心主卖点/iu.test(value)) errors.push('卖点排序缺少TOP10或分档')
  if (key === 'audience-sp-scene') {
    if (!ordered(value, ['TOP1', 'TOP2', 'TOP3', 'TOP4', 'TOP5'])) errors.push('人群卖点场景模块缺少TOP1-TOP5')
    for (const requirement of [
      { label: '核心人群', pattern: /核心人群/u },
      { label: '核心卖点', pattern: /核心卖点/u },
      { label: '真实场景', pattern: /真实场景/u },
      { label: '人群来源或依据', pattern: /人群(?:来源|依据)/u },
      { label: '卖点来源或依据', pattern: /卖点(?:来源|依据)/u },
      { label: '场景来源或依据', pattern: /场景(?:来源|依据)/u }
    ]) {
      if (!requirement.pattern.test(value)) errors.push(`人群卖点场景模块缺少${requirement.label}`)
    }
  }
  return errors
}

export function moduleValidationRetryInstruction(
  module: ReportModule,
  errors: string[],
  pass: number
): string {
  const requiredFirstLine: Partial<Record<ModuleKey, string>> = {
    'product-info': '1. 产品基础',
    'platform-audience': '## 平台：实际平台名称',
    'material-review': '1. 素材总览',
    'selling-points': '# 一、四大需求卖点买点摘要',
    voc: '1. 隐形需求 TOP10',
    'audience-sp-scene': '核心人群 × 卖点 × 场景 TOP5'
  }
  const vocRequirements = module.key === 'voc'
    ? [
        '必须一次性完整输出以下四组，顺序和名称不得改变：1. 隐形需求 TOP10；2. 购买顾虑 TOP10；3. 高频问题 TOP10；4. 正向反馈 TOP10。',
        '每组必须有TOP1到TOP10共10条，不能只输出第一组。',
        '隐形需求每条包含需求、频次、占比、来源分布、代表原话、来源；购买顾虑将需求改为顾虑；高频问题改为问题；正向反馈改为反馈，并额外包含认可类型、认可价值。',
        'TOP只表示排序，不得作为需求词、顾虑词、问题词或反馈词。',
        '没有可靠统计时必须写“频次：无精确频次｜占比无法计算”，不得虚构数字。'
      ]
    : []
  return [
    `这是第${pass}次结构纠正。上一轮输出未通过校验：${errors.slice(0, 8).join('；')}。`,
    `请完全替换上一轮输出，从头输出M${module.id} ${module.title}的最终结果。`,
    requiredFirstLine[module.key] ? `第一行必须直接是：${requiredFirstLine[module.key]}` : '',
    '禁止输出“我在整理、我会分析、正在对齐、接下来”等过程说明，禁止只返回计划或解释。',
    '严格遵守系统提示词和固定模板；资料缺失写“无”或“暂无分析”，不得省略固定字段。',
    ...vocRequirements,
    '只输出最终结果。'
  ].filter(Boolean).join('\n')
}

export function assembleModuleReport(
  modules: ReportModule[],
  outputs: Partial<Record<ModuleKey, string>>,
  messages: Partial<Record<ModuleKey, string>>,
  legacyBenchmarkAppendix = ''
): string {
  const sections = [...modules].sort((left, right) => left.id - right.id).map((module) => [
    `## M${module.id} ${module.title}`,
    (outputs[module.key]?.trim() || messages[module.key] || `本模块未输出。`).replace(/^#{1,2}\s+/gmu, '### ')
  ].join('\n\n'))
  return [
    '# 产品与内容经营报告',
    ...sections,
    legacyBenchmarkAppendix.trim()
      ? `## A1 旧版对标附录（不参与六模块分析）\n\n> 以下内容仅为旧版历史结果，不参与新版模块依赖、卖点排序或人群场景匹配。\n\n${legacyBenchmarkAppendix.trim().replace(/^#{1,2}\s+/gmu, '### ')}`
      : '',
    '> 本报告内容由 AI 生成，请谨慎参考。'
  ].filter(Boolean).join('\n\n')
}

export interface LegacyV1Projection {
  artifacts: Record<number, string>
  moduleStates: Partial<Record<ModuleKey, ModuleRunState>>
  reportMarkdown: string
  benchmarkAppendix: string
}

/**
 * Deterministically projects the old eight-module report into the six-module view.
 * This function never calls a model and deliberately labels the combined selling-point result as legacy.
 */
export function projectLegacyV1ToV2(
  artifacts: Record<number, string>,
  states: Partial<Record<ModuleKey, ModuleRunState>>
): LegacyV1Projection {
  const outputByKey: Partial<Record<ModuleKey, string>> = {
    'product-info': artifacts[1],
    'platform-audience': artifacts[2],
    'material-review': artifacts[3],
    voc: artifacts[6],
    'audience-sp-scene': artifacts[8]
  }
  const sellingParts = [
    artifacts[5]?.trim() ? `# 一、四大需求卖点买点摘要\n\n## 旧版产品卖点\n\n${artifacts[5].trim()}` : '',
    artifacts[7]?.trim() ? `# 二、核心卖点总排序\n\n## 旧版卖点排序\n\n${artifacts[7].trim()}` : ''
  ].filter(Boolean)
  if (sellingParts.length) {
    outputByKey['selling-points'] = [
      '> 旧版自动转换：以下内容由旧M5与旧M7机械合并，尚未执行新版融合提示词。',
      ...sellingParts
    ].join('\n\n')
  }
  const now = new Date().toISOString()
  const mappedState = (legacyKey: ModuleKey, output?: string): ModuleRunState => {
    const legacy = states[legacyKey]
    if (output?.trim()) {
      return {
        status: 'done',
        message: '旧版内容转换，可点击“按新版重新生成本模块”。',
        updatedAt: legacy?.updatedAt || now
      }
    }
    return {
      status: 'skipped',
      message: legacy?.message || '暂无分析：旧版项目没有此模块的有效结果。',
      updatedAt: legacy?.updatedAt || now
    }
  }
  const moduleStates: Partial<Record<ModuleKey, ModuleRunState>> = {
    'product-info': mappedState('product-info', outputByKey['product-info']),
    'platform-audience': mappedState('platform-audience', outputByKey['platform-audience']),
    'material-review': mappedState('material-review', outputByKey['material-review']),
    'selling-points': mappedState('selling-point-ranking', outputByKey['selling-points']),
    voc: mappedState('voc', outputByKey.voc),
    'audience-sp-scene': mappedState('audience-sp-scene', outputByKey['audience-sp-scene'])
  }
  const projectedArtifacts: Record<number, string> = {}
  for (const module of REPORT_MODULES_V2) {
    const output = outputByKey[module.key]
    if (output?.trim()) projectedArtifacts[module.id] = output
  }
  const benchmarkAppendix = artifacts[4]?.trim() || ''
  const messages = Object.fromEntries(REPORT_MODULES_V2.map((module) => [module.key, moduleStates[module.key]?.message]))
  const reportMarkdown = assembleModuleReport(REPORT_MODULES_V2, outputByKey, messages, benchmarkAppendix)
  return {
    artifacts: projectedArtifacts,
    moduleStates,
    reportMarkdown,
    benchmarkAppendix
  }
}
