import { describe, expect, it } from 'vitest'
import { REPORT_MODULES_V1, REPORT_MODULES_V2 } from '../../shared/types'
import {
  assembleModuleReport,
  buildModuleMessages,
  evaluateSourceSufficiency,
  findStaleModuleKeys,
  fingerprintModuleMessages,
  isNoAnalysisOutput,
  moduleValidationRetryInstruction,
  normalizeBenchmarkDimension,
  normalizeMaterialReviewOutput,
  normalizeNoAnalysisOutput,
  projectLegacyV1ToV2,
  retryScopeForModules,
  validateModuleOutput
} from './modules'
import { inferSourcePlatform } from './sourceMetadata'

describe('v2 six-module report engine', () => {
  it('uses the fixed three-wave DAG and continuous M1-M6 order', () => {
    expect(REPORT_MODULES_V2.filter((module) => module.wave === 1).map((module) => module.id)).toEqual([1, 2, 3, 5])
    expect(REPORT_MODULES_V2.find((module) => module.id === 4)?.dependsOn).toEqual(['product-info', 'material-review'])
    expect(REPORT_MODULES_V2.find((module) => module.id === 6)?.dependsOn).toEqual([
      'platform-audience', 'selling-points', 'voc'
    ])
    expect([...REPORT_MODULES_V2].sort((left, right) => left.id - right.id).map((module) => module.id)).toEqual([1, 2, 3, 4, 5, 6])
    expect(REPORT_MODULES_V2.some((module) => module.key === 'benchmark-brands')).toBe(false)
    expect(REPORT_MODULES_V2.some((module) => module.key === 'selling-point-ranking')).toBe(false)
  })

  it('never blocks the report and analyzes every module that has usable source data', () => {
    const partial = evaluateSourceSufficiency(REPORT_MODULES_V2, ['audience-data', 'material-data'])
    expect(partial.blocked).toBeNull()
    expect(partial.skipped.get('product-info')).toContain('暂无分析')
    expect(partial.skipped.has('platform-audience')).toBe(false)
    expect(partial.partial.get('platform-audience')).toContain('经营与交易数据')
    expect(partial.partial.get('selling-points')).toContain('产品与供给资料')
    expect(partial.skipped.get('voc')).toContain('用户声音')
    expect(partial.skipped.has('audience-sp-scene')).toBe(false)
  })

  it('keeps bundled system prompts exact and scopes user context to the current module', () => {
    const module = REPORT_MODULES_V2.find((item) => item.key === 'selling-points')!
    const messages = buildModuleMessages(module, {
      prompt: {
        key: module.key,
        systemPrompt: 'EXACT SYSTEM PROMPT',
        outputTemplate: '固定模板',
        validation: '验证',
        inputDescription: '输入',
        purpose: '目的'
      },
      sources: [{ name: '素材.csv', kindV1: 'material-data', text: '清洗结果' }],
      upstream: [
        { key: 'product-info', title: 'M1 产品信息', output: '产品事实' },
        { key: 'material-review', title: 'M3 内容素材判断', output: '素材证据' }
      ],
      missingDependencies: [],
      requirements: '不要编造'
    })
    expect(messages[0].content).toBe('EXACT SYSTEM PROMPT')
    expect(messages[1].content).toContain('素材.csv')
    expect(messages[1].content).toContain('产品事实')
    expect(messages[1].content).toContain('素材证据')
    expect(messages[1].content).toContain('不要编造')
  })

  it('allows evidence-bound framework inference but rejects generic framework placeholders', () => {
    const module = REPORT_MODULES_V2.find((item) => item.key === 'material-review')!
    const messages = buildModuleMessages(module, {
      prompt: { key: module.key, systemPrompt: 'M3 SYSTEM', outputTemplate: 'M3 TEMPLATE', validation: '', inputDescription: '', purpose: '' },
      sources: [{ name: '素材表.csv', kindV1: 'material-data', text: '完整文案：没胃口就做酸菜鱼' }],
      upstream: [],
      missingDependencies: []
    })
    expect(messages[1].content).toContain('系统归纳')
    expect(messages[1].content).toContain('证据不足可以少于5条')
    expect(validateModuleOutput('material-review', '自有框架1\n框架类型：厨房制作型\n可复用方向：继续制作', 'v2')).toContain(
      '素材模块包含“框架1”等无含义占位名称'
    )
    const normalized = normalizeMaterialReviewOutput('### 自有框架1\n框架类型：\n3.1｜厨房制作型｜痛点开头｜烹饪展示｜推荐\n可复用方向：继续更换菜品')
    expect(normalized).toContain('### 自有素材TOP1｜3.1｜厨房制作型｜痛点开头｜烹饪展示｜推荐')
    expect(validateModuleOutput('material-review', normalized, 'v2')).toEqual([])
    const plain = normalizeMaterialReviewOutput([
      '自有框架1',
      '框架类型：厨房教程型',
      '数据依据：20条',
      '可复用方向：继续更换菜品',
      '竞品框架1',
      '框架类型：素人种草型',
      '数据依据：7条',
      '可复用方向：借鉴结构',
      '机会1',
      '机会框架：工厂透明型',
      '竞品依据：2条',
      '可补充方向：展示真实流程'
    ].join('\n'))
    expect(plain).toContain('### 自有素材TOP1｜厨房教程型')
    expect(plain).toContain('### 竞品素材TOP1｜素人种草型')
    expect(plain).toContain('### 补充机会TOP1｜工厂透明型')
    expect(validateModuleOutput('material-review', plain, 'v2')).toEqual([])
  })

  it('validates platform isolation, explicit dimensions and human tags outside the region field', () => {
    const platform = [
      '## 平台：视频号',
      '成交画像周期：2026/06/01-2026/06/30',
      '商品销售周期：2026/06/01-2026/06/30',
      ...['1. 性别', '2. 年龄', '3. 地域', '4. 人群属性', '5. 消费力', '6. 购买偏好'].flatMap((dimension) => [
        `### ${dimension}`,
        `信息：${dimension.includes('地域') ? '浙江省13.33%' : dimension.includes('人群属性') ? '都市银发48.9%' : '女性64.64%'}`,
        '来源：成交画像｜对应维度'
      ]),
      '# 多平台核心人群TOP5',
      '| 优先级 | 人群标签 | 占比/特征 | 决策动机 | 内容语言 |',
      '| --- | --- | --- | --- | --- |',
      '| 第一主力 | 50+女性｜都市银发 | 视频号女性64.64% | 家庭采购 | 安心、稳定 |',
      '### 第一主力来源',
      '来源：视频号成交画像'
    ].join('\n')
    expect(validateModuleOutput('platform-audience', platform, 'v2')).toEqual([])
    expect(validateModuleOutput('platform-audience', platform.replace('浙江省13.33%', '都市银发48.9%'), 'v2')).toContain(
      '成交人群模块把人群属性误写成了地域'
    )
    expect(validateModuleOutput('platform-audience', platform.replace('女性64.64%', '跨平台综合占比64.64%'), 'v2')).toContain(
      '成交人群模块不得生成跨平台综合或平均占比'
    )
  })

  it('validates the fused four-demand selling-point result and unique named ranking', () => {
    const result = [
      '# 一、四大需求卖点买点摘要',
      '## 1. 品质需求\nTOP1\n卖点：九天益生菌发酵\n买点：酸香更稳定',
      '## 2. 价格需求\n无',
      '## 3. 健康需求\nTOP1\n卖点：配料表清晰\n买点：家庭吃得更放心',
      '## 4. 情感需求\n无',
      '# 二、核心卖点总排序',
      '## 核心主卖点 TOP1-3',
      '### TOP1｜九天益生菌发酵',
      '需求类型：品质需求',
      '买点：酸香更稳定',
      '自营依据：成交素材反复出现',
      '竞品依据：无',
      '卖点状态：核心验证卖点',
      '排序判断：产品事实和自营成交共同支持',
      '自营来源：产品手卡｜发酵工艺',
      '竞品来源：无'
    ].join('\n')
    expect(validateModuleOutput('selling-points', result, 'v2')).toEqual([])
    expect(validateModuleOutput('selling-points', result.replace('TOP1｜九天益生菌发酵', 'TOP1｜{卖点名称}'), 'v2')).toContain(
      '卖点模块仍包含TOP卖点占位名称'
    )
    expect(validateModuleOutput('selling-points', `${result}\n综合评分：92`, 'v2')).toContain(
      '卖点模块包含无来源的综合评分或指数'
    )
  })

  it('requires all four VOC groups and keeps TOP labels separate from user terms', () => {
    const groups = [
      { heading: '1. 隐形需求 TOP10', field: '需求', positive: false },
      { heading: '2. 购买顾虑 TOP10', field: '顾虑', positive: false },
      { heading: '3. 高频问题 TOP10', field: '问题', positive: false },
      { heading: '4. 正向反馈 TOP10', field: '反馈', positive: true }
    ]
    const valid = groups.map((group) => [
      group.heading,
      ...Array.from({ length: 10 }, (_, index) => [
        `TOP${index + 1}`,
        `${group.field}：真实词${index + 1}`,
        ...(group.positive ? ['认可类型：产品体验', '认可价值：使用更方便'] : []),
        `频次：${20 - index}次`,
        `占比：${10 - index / 2}%`,
        '来源分布：自营',
        `代表原话：用户原话${index + 1}`,
        `来源：评价表｜${index + 1}`
      ].join('\n'))
    ].join('\n')).join('\n\n')
    expect(validateModuleOutput('voc', valid, 'v2')).toEqual([])
    expect(validateModuleOutput('voc', valid.replace('频次：20次\n占比：10%', '频次：无精确频次｜占比无法计算'), 'v2')).toEqual([])
    expect(validateModuleOutput('voc', valid.split('2. 购买顾虑 TOP10')[0], 'v2')).toContain(
      'VOC必须按顺序完整包含隐形需求、购买顾虑、高频问题、正向反馈四组TOP10'
    )
    const module = REPORT_MODULES_V2.find((item) => item.key === 'voc')!
    expect(moduleValidationRetryInstruction(module, ['缺少三组'], 1)).toContain('不能只输出第一组')
  })

  it('assembles M1-M6 in order and keeps the old benchmark only as an appendix', () => {
    const outputs = Object.fromEntries(REPORT_MODULES_V2.map((module) => [module.key, `结果${module.id}`]))
    const report = assembleModuleReport(REPORT_MODULES_V2, outputs, {}, '旧版对标内容')
    expect(report.indexOf('## M1')).toBeLessThan(report.indexOf('## M6'))
    expect(report).not.toContain('## M7')
    expect(report).toContain('## A1 旧版对标附录（不参与六模块分析）')
    expect(report).toContain('旧版对标内容')
  })

  it('projects an eight-module v1 report without model work or data loss', () => {
    const legacyArtifacts = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [index + 1, `旧M${index + 1}`]))
    const projection = projectLegacyV1ToV2(legacyArtifacts, {})
    expect(projection.artifacts[1]).toBe('旧M1')
    expect(projection.artifacts[4]).toContain('旧M5')
    expect(projection.artifacts[4]).toContain('旧M7')
    expect(projection.artifacts[5]).toBe('旧M6')
    expect(projection.artifacts[6]).toBe('旧M8')
    expect(projection.benchmarkAppendix).toBe('旧M4')
    expect(projection.reportMarkdown).toContain('旧版自动转换')
    expect(projection.reportMarkdown).toContain('旧版对标附录')
    expect(projection.moduleStates['selling-points']?.message).toContain('按新版重新生成')
  })

  it('treats evidence-bound no-result output as 暂无分析 instead of a module failure', () => {
    const output = '核心人群 × 卖点 × 场景 TOP5\n\n无有效组合可输出。\n\n限制说明：缺少真实场景，无法确认匹配依据。'
    expect(isNoAnalysisOutput(output)).toBe(true)
    expect(validateModuleOutput('audience-sp-scene', output, 'v2')).toEqual([])
    expect(normalizeNoAnalysisOutput(output)).toMatch(/^暂无分析：/u)
  })

  it('fingerprints v1 and v2 task contexts independently', () => {
    const messages = [{ role: 'user' as const, content: 'A' }]
    expect(fingerprintModuleMessages(messages, 'v2')).toBe(fingerprintModuleMessages(messages, 'v2'))
    expect(fingerprintModuleMessages(messages, 'v2')).not.toBe(fingerprintModuleMessages(messages, 'v1'))
  })

  it('forces validation retries to start with the final template instead of process narration', () => {
    const audience = REPORT_MODULES_V2.find((module) => module.key === 'platform-audience')!
    const instruction = moduleValidationRetryInstruction(audience, ['缺少平台画像'], 2)
    expect(instruction).toContain('第一行必须直接是：## 平台：实际平台名称')
    expect(instruction).toContain('禁止输出“我在整理、我会分析、正在对齐、接下来”')
    expect(instruction).toContain('第2次结构纠正')
  })

  it('invalidates only the v2 downstream modules when an upstream result is newer', () => {
    const states = {
      'product-info': { status: 'done' as const, updatedAt: '2026-08-25T02:00:00Z' },
      'material-review': { status: 'done' as const, updatedAt: '2026-08-25T01:00:00Z' },
      'selling-points': { status: 'done' as const, updatedAt: '2026-08-25T01:10:00Z' },
      'platform-audience': { status: 'done' as const, updatedAt: '2026-08-25T01:00:00Z' },
      voc: { status: 'done' as const, updatedAt: '2026-08-25T01:00:00Z' },
      'audience-sp-scene': { status: 'done' as const, updatedAt: '2026-08-25T01:30:00Z' }
    }
    const stale = findStaleModuleKeys(REPORT_MODULES_V2, states)
    expect(stale.has('selling-points')).toBe(true)
    expect(stale.has('audience-sp-scene')).toBe(true)
    expect(stale.has('selling-point-ranking')).toBe(false)
  })

  it('retries every failed branch and its downstream from one user click', () => {
    const scope = retryScopeForModules(REPORT_MODULES_V2, {
      'product-info': { status: 'done', updatedAt: '2026-08-25T01:00:00Z' },
      'platform-audience': { status: 'failed', updatedAt: '2026-08-25T01:00:00Z' },
      'material-review': { status: 'done', updatedAt: '2026-08-25T01:00:00Z' },
      'selling-points': { status: 'failed', updatedAt: '2026-08-25T01:00:00Z' },
      voc: { status: 'done', updatedAt: '2026-08-25T01:00:00Z' },
      'audience-sp-scene': { status: 'failed', updatedAt: '2026-08-25T01:00:00Z' }
    }, 'platform-audience')
    expect([...scope].sort()).toEqual(['audience-sp-scene', 'platform-audience', 'selling-points'])
  })
})

describe('legacy v1 compatibility', () => {
  it('keeps the eight-module definition only for migration and old rendering', () => {
    expect(REPORT_MODULES_V1).toHaveLength(8)
    expect(REPORT_MODULES_V1.some((module) => module.key === 'benchmark-brands')).toBe(true)
  })

  it('never presents model memory or placeholder brands as verified search', () => {
    const unverified = normalizeBenchmarkDimension('同卖点', '推荐1\n品牌：某品牌\n来源：模型记忆', {
      status: 'unavailable', evidence: []
    })
    expect(unverified).toContain('暂无可靠对标')
    expect(validateModuleOutput('benchmark-brands', '同产品\n同类目\n同人群\n同卖点\n同痛点\n同情绪\n同解决方案\n品牌A', 'v1')).toContain(
      '对标模块包含无明确对象的占位品牌或排名'
    )
  })

  it('infers platforms without guessing ambiguous files', () => {
    expect(inferSourcePlatform('成交画像.xlsx', '来源：抖音电商罗盘')).toBe('抖音电商罗盘')
    expect(inferSourcePlatform('小店罗盘导出.csv')).toBe('微信小店')
    expect(inferSourcePlatform('混合资料.zip', '抖音数据\n视频号数据')).toBe('多平台（抖音、视频号）')
    expect(inferSourcePlatform('购买画像.csv', '性别,年龄,占比')).toBe('')
  })
})
