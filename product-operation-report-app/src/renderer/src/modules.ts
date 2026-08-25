import type {
  ChatMessage,
  ModelTaskType,
  ModuleKey,
  ModulePrompt,
  ReportModule,
  SearchEvidence,
  SearchVerificationStatus,
  SourceKindV1,
  ModuleRunState
} from '../../shared/types'

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

export const SOURCE_KIND_LABELS: Record<SourceKindV1, string> = {
  'product-supply': '产品与供给资料',
  'business-data': '经营与交易数据',
  'material-data': '内容素材与表现数据',
  'audience-data': '人群与行为画像',
  'voice-data': '用户声音与反馈'
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

export function fingerprintModuleMessages(messages: ChatMessage[]): string {
  const value = JSON.stringify(messages)
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `v1-${(hash >>> 0).toString(16).padStart(8, '0')}-${value.length}`
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
      return framework ? `${hashes}${label}TOP${rank}｜${framework}${body}` : full
    })
  let value = replaceGroup(raw, /^(#{1,6}\s*)自有框架([1-5])([\s\S]*?)(?=^#{1,6}\s*|(?![\s\S]))/gmu, '自有素材', '框架类型')
  value = replaceGroup(value, /^(#{1,6}\s*)竞品框架([1-5])([\s\S]*?)(?=^#{1,6}\s*|(?![\s\S]))/gmu, '竞品素材', '框架类型')
  return replaceGroup(value, /^(#{1,6}\s*)机会([1-5])([\s\S]*?)(?=^#{1,6}\s*|(?![\s\S]))/gmu, '补充机会', '机会框架')
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

export function buildModuleMessages(module: ReportModule, context: ModuleContext): ChatMessage[] {
  const sourceText = context.sources.length
    ? context.sources.map((source, index) => [
        `### 来源 ${index + 1}：${source.name}`,
        `业务类型：${source.kindV1}`,
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
        '系统归纳时仍输出自有框架TOP5、竞品框架TOP5、补充机会TOP5；框架名称必须直接写出“3.x分类｜具体框架类型｜开头结构｜中段表达｜结尾结构”，不得只写“自有框架1/竞品框架1”。',
        '每个框架必须写数据依据、主要人群和完整可复用方向；机会必须写竞品依据、自有现状和可补充方向。无法确认的单个字段写“未单独标注”，但不能因为缺少预标字段而停止归纳。',
        '所有归纳只能来自本次素材的实际文案和标签，禁止补充素材中不存在的产品事实、功效、价格或案例。'
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

export function validateModuleOutput(key: ModuleKey, text: string): string[] {
  const value = text.trim()
  if (!value) return ['模块没有返回内容']
  if (isNoAnalysisOutput(value)) return []
  const errors: string[] = []
  if (key === 'product-info') {
    const labels = ['1. 产品基础', '2. SKU规格', '3. 价格', '4. 优惠赠品', '5. 原料/成分/材质', '6. 工艺技术', '7. 产品属性与功能', '8. 品牌背书', '9. 产品背书']
    if (!ordered(value, labels)) errors.push('产品信息9个维度缺失或顺序错误')
    if ((value.match(/信息：/gu) || []).length < 9 || (value.match(/来源：/gu) || []).length < 9) errors.push('产品信息必须逐维提供信息和来源')
  }
  if (key === 'platform-audience' && !/平台|成交人群/u.test(value)) errors.push('平台人群模块缺少平台或成交人群结果')
  if (key === 'material-review') {
    for (const [prefix, normalized] of [['自有框架', '自有素材TOP'], ['竞品框架', '竞品素材TOP'], ['机会', '补充机会TOP']]) {
      for (let index = 1; index <= 5; index++) {
        if (!value.includes(`${prefix}${index}`) && !value.includes(`${normalized}${index}`)) errors.push(`素材模块缺少${prefix}${index}`)
      }
    }
    if ((value.match(/可复用方向\s*[：:]/gu) || []).length < 10) errors.push('素材模块缺少自有或竞品可复用方向')
    if ((value.match(/可补充方向\s*[：:]/gu) || []).length < 5) errors.push('素材模块缺少5条补充方向')
  }
  if (key === 'benchmark-brands' && !ordered(value, ['同产品', '同类目', '同人群', '同卖点', '同痛点', '同情绪', '同解决方案'])) {
    errors.push('对标模块必须完整包含7个固定维度并保持顺序')
  }
  if (key === 'benchmark-brands' && BENCHMARK_PLACEHOLDER.test(value)) errors.push('对标模块包含无明确对象的占位品牌或排名')
  if (key === 'selling-points' && !/品质|价格|健康|情感/u.test(value)) errors.push('产品卖点缺少四大需求分类')
  if (key === 'voc' && (!/频次/u.test(value) || !/占比/u.test(value))) errors.push('VOC结果必须包含频次和占比')
  if (key === 'selling-point-ranking' && !/TOP\s*10|TOP1|核心主卖点/iu.test(value)) errors.push('卖点排序缺少TOP10或分档')
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

export function assembleModuleReport(
  modules: ReportModule[],
  outputs: Partial<Record<ModuleKey, string>>,
  messages: Partial<Record<ModuleKey, string>>
): string {
  const sections = [...modules].sort((left, right) => left.id - right.id).map((module) => [
    `## M${module.id} ${module.title}`,
    (outputs[module.key]?.trim() || messages[module.key] || `本模块未输出。`).replace(/^##\s+/gmu, '### ')
  ].join('\n\n'))
  return [
    '# 产品经营报告',
    ...sections,
    '> 本报告内容由 AI 生成，请谨慎参考。'
  ].join('\n\n')
}
