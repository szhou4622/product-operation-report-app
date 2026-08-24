import { describe, expect, it } from 'vitest'
import { REPORT_MODULES } from '../../shared/types'
import {
  assembleModuleReport,
  buildModuleMessages,
  evaluateSourceSufficiency,
  validateModuleOutput
} from './modules'

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
})
