import { describe, expect, it } from 'vitest'
import { validateReportStructure } from './validate'

describe('six-module report structure', () => {
  it('accepts a continuous M1-M6 report and an optional legacy appendix', () => {
    const report = [
      '# 产品与内容经营报告',
      ...Array.from({ length: 6 }, (_, index) => `## M${index + 1} 模块${index + 1}\n内容${index + 1}`),
      '## A1 旧版对标附录（不参与六模块分析）',
      '旧版内容',
      '> 本报告内容由 AI 生成，请谨慎参考。'
    ].join('\n\n')
    expect(validateReportStructure(report)).toEqual([])
  })

  it('still rejects a missing six-module chapter', () => {
    const report = [
      '# 产品与内容经营报告',
      ...[1, 2, 3, 4, 6].map((id) => `## M${id} 模块${id}\n内容${id}`),
      '> 本报告内容由 AI 生成，请谨慎参考。'
    ].join('\n\n')
    expect(validateReportStructure(report)).toContain('报告缺少标准章节：## M5。')
  })
})
