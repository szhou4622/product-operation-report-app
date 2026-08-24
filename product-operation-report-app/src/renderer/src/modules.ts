import type {
  ChatMessage,
  ModelTaskType,
  ModuleKey,
  ModulePrompt,
  ReportModule,
  SourceKindV1
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
  const errors: string[] = []
  if (key === 'product-info') {
    const labels = ['1. 产品基础', '2. SKU规格', '3. 价格', '4. 优惠赠品', '5. 原料/成分/材质', '6. 工艺技术', '7. 产品属性与功能', '8. 品牌背书', '9. 产品背书']
    if (!ordered(value, labels)) errors.push('产品信息9个维度缺失或顺序错误')
    if ((value.match(/信息：/gu) || []).length < 9 || (value.match(/来源：/gu) || []).length < 9) errors.push('产品信息必须逐维提供信息和来源')
  }
  if (key === 'platform-audience' && !/平台|成交人群/u.test(value)) errors.push('平台人群模块缺少平台或成交人群结果')
  if (key === 'material-review' && !/TOP\s*5|Top\s*5|自有|竞品/iu.test(value)) errors.push('素材模块缺少自有/竞品Top5结果')
  if (key === 'benchmark-brands' && !/同产品|同类目|同人群|暂无可靠对标/u.test(value)) errors.push('对标模块缺少固定维度')
  if (key === 'selling-points' && !/品质|价格|健康|情感/u.test(value)) errors.push('产品卖点缺少四大需求分类')
  if (key === 'voc' && (!/频次/u.test(value) || !/占比/u.test(value))) errors.push('VOC结果必须包含频次和占比')
  if (key === 'selling-point-ranking' && !/TOP\s*10|TOP1|核心主卖点/iu.test(value)) errors.push('卖点排序缺少TOP10或分档')
  if (key === 'audience-sp-scene') {
    if (!ordered(value, ['TOP1', 'TOP2', 'TOP3', 'TOP4', 'TOP5'])) errors.push('人群卖点场景模块缺少TOP1-TOP5')
    for (const label of ['核心人群', '核心卖点', '真实场景', '人群来源', '卖点来源', '场景来源']) {
      if (!value.includes(label)) errors.push(`人群卖点场景模块缺少${label}`)
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
