import { describe, expect, it } from 'vitest'
import { parseHtmlReportModel } from './htmlReportModel'
import { buildHtmlReportPresentation } from './htmlReportPresentation'

describe('selling-point keyword cloud', () => {
  it('uses only the selling-point column and rejects file/source metadata noise', () => {
    const markdown = [
      '# 测试报告',
      '## 5. 产品全量卖点拆解',
      '| 卖点维度 | 我方产品卖点 | 用户能感知的好处 |',
      '| --- | --- | --- |',
      '| 功能 | 免清洗、免切、鲜脆、不咸纯酸；来源：大川知道视频项目.csv | 用户购买更方便，服务更好 |',
      '| 口感 | 免清洗、免切、鲜脆、不咸纯酸；来源：大川知道视频项目.csv | 用户购买更方便，服务更好 |',
      '| 工艺 | 植物基益生菌直投式发酵、小叶芥菜、酸香；来源：产品手卡.pptx | 项目资料记载 |',
      '| 原料 | 植物基益生菌直投式发酵、小叶芥菜、酸香；来源：产品手卡.pptx | 项目资料记载 |'
    ].join('\n')
    const presentation = buildHtmlReportPresentation(parseHtmlReportModel(markdown))
    const cloud = presentation.sections.find((section) => section.sectionNumber === '5')?.keywordCloud
    expect(cloud).not.toBeNull()
    const labels = cloud?.items.map((item) => item.label) || []
    expect(labels).not.toEqual(expect.arrayContaining(['大川', '知道', '视频', '项目', 'csv', 'pptx', '来源', '服务', '购买']))
    expect(labels.some((label) => /免清洗|免切|鲜脆|发酵|芥菜|酸香/u.test(label))).toBe(true)
  })

  it('omits the cloud when fewer than six reliable selling-point terms remain', () => {
    const markdown = [
      '# 测试报告',
      '## 5. 产品全量卖点拆解',
      '| 卖点维度 | 我方产品卖点 | 用户能感知的好处 |',
      '| --- | --- | --- |',
      '| 工艺 | 来源：项目资料.pptx | 服务、项目、视频、购买 |'
    ].join('\n')
    const presentation = buildHtmlReportPresentation(parseHtmlReportModel(markdown))
    expect(presentation.sections.find((section) => section.sectionNumber === '5')?.keywordCloud).toBeNull()
  })
})

