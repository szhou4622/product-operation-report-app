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

describe('v1 M1-M8 visual planning', () => {
  it('parses module headings and synthesizes source-bound visual tables', () => {
    const markdown = [
      '# 产品经营报告',
      '## M1 产品信息',
      '1. 产品基础',
      '信息：益生菌发酵酸菜',
      '来源：产品手卡第1页',
      '2. SKU规格',
      '信息：150g×4袋',
      '来源：产品手卡第1页',
      '## M2 平台人群数据',
      '平台：抖音电商罗盘',
      '性别',
      '信息：女性64.64%，男性35.36%',
      '来源：成交画像截图',
      '年龄',
      '信息：60岁以上44.57%，50—59岁24.90%',
      '来源：成交画像截图',
      '## M3 内容素材判断',
      '自有框架1',
      '框架类型：',
      '3.1｜厨房制作型｜食欲切入｜制作展示｜推荐',
      '数据依据：',
      '20条｜占自有素材40.0%',
      '可复用方向：',
      '没胃口切入→厨房制作→成品展示→邀请尝试',
      '## M4 对标推荐',
      '### 同产品',
      '暂无可靠对标',
      '### 同类目',
      '推荐1',
      '品牌：示例品牌',
      '推荐理由：同属酸菜消费类目',
      '来源：品牌官方店',
      '## M5 产品卖点',
      '品质需求',
      '鲜脆免洗｜来源：产品手卡',
      '价格需求',
      '四袋装降低单次购买门槛｜来源：价格表',
      '## M8 核心人群×卖点×场景匹配',
      'TOP1',
      '核心人群：银发家庭用户',
      '核心卖点：免洗即食',
      '真实场景：家庭下饭',
      '人群来源：成交画像',
      '卖点来源：产品手卡',
      '场景来源：用户评论'
    ].join('\n')
    const model = parseHtmlReportModel(markdown)
    expect(model.sections.map((section) => section.number)).toEqual(['M1', 'M2', 'M3', 'M4', 'M5', 'M8'])
    expect(model.sections.find((section) => section.number === 'M1')?.tables[0]?.rows).toHaveLength(2)
    expect(model.sections.find((section) => section.number === 'M2')?.tables[0]?.rows).toHaveLength(4)
    expect(model.sections.find((section) => section.number === 'M3')?.tables[0]?.rows[0]).toEqual([
      '3.1｜厨房制作型｜食欲切入｜制作展示｜推荐',
      '20条｜占自有素材40.0%',
      '没胃口切入→厨房制作→成品展示→邀请尝试'
    ])
    expect(model.sections.find((section) => section.number === 'M5')?.tables[0]?.rows[0]?.[1]).not.toContain('TOP1')
    const presentation = buildHtmlReportPresentation(model)
    expect(presentation.sections.find((section) => section.sectionNumber === 'M1')?.visualKind).toBe('product-facts')
    expect(presentation.sections.find((section) => section.sectionNumber === 'M2')?.visualKind).toBe('percent-facets')
    expect(presentation.sections.find((section) => section.sectionNumber === 'M3')?.visualKind).toBe('material-methods')
    expect(presentation.sections.find((section) => section.sectionNumber === 'M4')?.visualKind).toBe('source-ledger')
    expect(presentation.sections.find((section) => section.sectionNumber === 'M5')?.visualKind).toBe('selling-point-matrix')
    expect(presentation.sections.find((section) => section.sectionNumber === 'M8')?.visualKind).toBe('audience-map')
  })
})
