import { describe, expect, it } from 'vitest'
import { REPORT_MODULES } from '../../shared/types'
import {
  assembleModuleReport,
  buildModuleMessages,
  evaluateSourceSufficiency,
  findStaleModuleKeys,
  fingerprintModuleMessages,
  isNoAnalysisOutput,
  normalizeBenchmarkDimension,
  normalizeNoAnalysisOutput,
  validateModuleOutput
} from './modules'
import { inferSourcePlatform } from './sourceMetadata'

describe('v1 report modules', () => {
  it('uses the fixed four-wave DAG and report order', () => {
    expect(REPORT_MODULES.filter((module) => module.wave === 1).map((module) => module.id)).toEqual([1, 2, 3, 6])
    expect(REPORT_MODULES.find((module) => module.id === 5)?.dependsOn).toEqual(['product-info'])
    expect(REPORT_MODULES.find((module) => module.id === 8)?.dependsOn).toEqual([
      'platform-audience', 'selling-points', 'voc', 'selling-point-ranking'
    ])
    expect([...REPORT_MODULES].sort((left, right) => left.id - right.id).map((module) => module.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('never blocks the report and analyzes every module that has usable source data', () => {
    const missingProduct = evaluateSourceSufficiency(REPORT_MODULES, ['audience-data', 'material-data'])
    expect(missingProduct.blocked).toBeNull()
    expect(missingProduct.skipped.get('product-info')).toContain('暂无分析')
    expect(missingProduct.skipped.has('platform-audience')).toBe(false)
    expect(missingProduct.partial.get('platform-audience')).toContain('经营与交易数据')
    const allowed = evaluateSourceSufficiency(REPORT_MODULES, [
      'product-supply', 'audience-data', 'business-data', 'material-data'
    ])
    expect(allowed.blocked).toBeNull()
    expect(allowed.skipped.get('voc')).toContain('用户声音')
    expect(allowed.skipped.has('audience-sp-scene')).toBe(false)
  })

  it('keeps the imported system prompt unchanged and scopes user context', () => {
    const module = REPORT_MODULES.find((item) => item.key === 'selling-points')!
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
      upstream: [{ key: 'product-info', title: 'M1 产品信息', output: '产品事实' }],
      missingDependencies: [],
      requirements: '不要编造'
    })
    expect(messages[0].content).toBe('EXACT SYSTEM PROMPT')
    expect(messages[1].content).toContain('素材.csv')
    expect(messages[1].content).toContain('产品事实')
    expect(messages[1].content).toContain('不要编造')
  })

  it('assembles M1-M8 and validates the strict module anchors', () => {
    const outputs = Object.fromEntries(REPORT_MODULES.map((module) => [module.key, `结果${module.id}`]))
    const report = assembleModuleReport(REPORT_MODULES, outputs, {})
    expect(report.indexOf('## M1')).toBeLessThan(report.indexOf('## M8'))
    expect(report).toContain('本报告内容由 AI 生成，请谨慎参考')
    expect(validateModuleOutput('product-info', '1. 产品基础\n信息：A\n来源：A\n2. SKU规格\n信息：A\n来源：A\n3. 价格\n信息：A\n来源：A\n4. 优惠赠品\n信息：A\n来源：A\n5. 原料/成分/材质\n信息：A\n来源：A\n6. 工艺技术\n信息：A\n来源：A\n7. 产品属性与功能\n信息：A\n来源：A\n8. 品牌背书\n信息：A\n来源：A\n9. 产品背书\n信息：A\n来源：A')).toEqual([])
  })

  it('treats evidence-bound no-result output as 暂无分析 instead of a module failure', () => {
    const output = '核心人群 × 卖点 × 场景 TOP5\n\n无有效组合可输出。\n\n限制说明：缺少真实场景，无法确认匹配依据。'
    expect(isNoAnalysisOutput(output)).toBe(true)
    expect(validateModuleOutput('audience-sp-scene', output)).toEqual([])
    expect(normalizeNoAnalysisOutput(output)).toMatch(/^暂无分析：/u)
  })

  it('accepts 来源 and 依据 as equivalent evidence labels in M8', () => {
    const blocks = Array.from({ length: 5 }, (_, index) => [
      `TOP${index + 1}`,
      '核心人群：家庭用户',
      '核心卖点：免洗即食',
      '真实场景：家庭下饭',
      '人群依据：成交画像',
      '卖点依据：产品手卡',
      '场景依据：自有素材'
    ].join('\n')).join('\n\n')
    expect(validateModuleOutput('audience-sp-scene', blocks)).toEqual([])
  })

  it('fingerprints exact module inputs and normalizes every benchmark dimension', () => {
    const base = [{ role: 'user' as const, content: 'A' }]
    expect(fingerprintModuleMessages(base)).toBe(fingerprintModuleMessages(base))
    expect(fingerprintModuleMessages(base)).not.toBe(fingerprintModuleMessages([{ role: 'user', content: 'B' }]))
    expect(normalizeBenchmarkDimension('同人群', '我会先核验。### 同人群\n推荐1\n品牌：A')).toBe('### 同人群\n推荐1\n品牌：A')
    expect(normalizeBenchmarkDimension('同情绪', '暂无可靠对标')).toBe('### 同情绪\n暂无可靠对标')
  })

  it('infers a platform from filenames and parsed evidence without guessing ambiguous files', () => {
    expect(inferSourcePlatform('成交画像.xlsx', '来源：抖音电商罗盘')).toBe('抖音电商罗盘')
    expect(inferSourcePlatform('小店罗盘导出.csv')).toBe('微信小店')
    expect(inferSourcePlatform('混合资料.zip', '抖音数据\n视频号数据')).toBe('多平台（抖音、视频号）')
    expect(inferSourcePlatform('购买画像.csv', '性别,年龄,占比')).toBe('')
  })

  it('invalidates downstream modules when an upstream result is newer', () => {
    const states = {
      'product-info': { status: 'done' as const, updatedAt: '2026-08-25T02:00:00Z' },
      'material-review': { status: 'done' as const, updatedAt: '2026-08-25T01:00:00Z' },
      'selling-points': { status: 'done' as const, updatedAt: '2026-08-25T01:10:00Z' },
      'selling-point-ranking': { status: 'done' as const, updatedAt: '2026-08-25T01:20:00Z' },
      'audience-sp-scene': { status: 'done' as const, updatedAt: '2026-08-25T01:30:00Z' }
    }
    const stale = findStaleModuleKeys(REPORT_MODULES, states)
    expect(stale.has('selling-points')).toBe(true)
    expect(stale.has('selling-point-ranking')).toBe(true)
    expect(stale.has('audience-sp-scene')).toBe(true)
  })
})
