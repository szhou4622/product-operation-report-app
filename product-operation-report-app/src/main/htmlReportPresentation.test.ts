import { describe, expect, it } from 'vitest'
import { parseHtmlReportModel } from './htmlReportModel'
import { buildHtmlReportPresentation } from './htmlReportPresentation'
import { markdownToHtmlDocument } from './htmlReport'

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

  it('keeps every M2 platform, names the actual category and rejects audience tags as regions', () => {
    const markdown = [
      '# 产品经营报告',
      '## M2 平台人群数据',
      '平台：视频号',
      '1. 性别',
      '信息：女性64.64%，男性35.36%',
      '来源：视频号截图｜性别分布',
      '2. 地域',
      '信息：都市银发48.90%，小镇中老年28.57%',
      '来源：错误地域字段',
      '3. 人群属性',
      '信息：都市银发48.90%，小镇中老年28.57%',
      '来源：视频号截图｜人群属性',
      '平台：抖店罗盘',
      '1. 性别',
      '信息：女性78.14%，男性21.86%',
      '来源：抖店画像表｜性别分布',
      '2. 地域',
      '信息：江苏省19.09%，山东省10.95%',
      '来源：抖店画像表｜省份分布'
    ].join('\n')
    const model = parseHtmlReportModel(markdown)
    const table = model.sections[0]?.tables[0]
    expect(new Set(table?.rows.map((row) => row[0]))).toEqual(new Set(['视频号', '抖店罗盘']))
    expect(table?.rows.filter((row) => row[1] === '地域').map((row) => row[2])).toEqual(['江苏省', '山东省'])
    expect(table?.rows.filter((row) => row[1] === '人群属性' && row[2] === '都市银发')).toHaveLength(1)
    const presentation = buildHtmlReportPresentation(model)
    const m2 = presentation.sections.find((section) => section.sectionNumber === 'M2')
    expect(new Set(m2?.percentFacets.map((facet) => facet.group))).toEqual(new Set(['视频号', '抖店罗盘']))
    expect(presentation.mainMetric?.label).toBe('女性占比')
    expect(presentation.mainMetric?.sourceLabel).toBe('视频号 / 性别')
  })
})

describe('v2 M1-M6 visual planning', () => {
  it('renders exactly one independent portrait panel per uploaded platform and three material pools', async () => {
    const platformBlock = (platform: string, female: string, male: string): string => [
      `## 平台：${platform}`,
      '### 1. 性别',
      `信息：女性${female}%，男性${male}%（平台预测口径）。`,
      `来源：${platform}画像`,
      '### 2. 年龄',
      '信息：31-40岁40%，41-50岁30%',
      `来源：${platform}画像`
    ].join('\n')
    const markdown = [
      '# 产品经营报告',
      '## M2 成交人群分析',
      platformBlock('视频号', '64.64', '35.36'),
      platformBlock('抖店罗盘', '78.14', '21.86'),
      platformBlock('巨量云图', '71.43', '28.57'),
      '# 多平台核心人群TOP5',
      '| 优先级 | 人群标签 | 占比/特征 | 决策动机 | 内容语言 |',
      '| --- | --- | --- | --- | --- |',
      '| 第一主力 | 31-50岁女性｜家庭食品购买者 | 三个平台女性占比均较高 | 家庭采购更看重省心与适配 | 家庭使用＋食品场景＋稳定 |',
      '### 第一主力来源',
      '来源：视频号画像｜抖店罗盘画像｜巨量云图画像',
      '## M3 内容素材判断',
      '### 自有素材TOP1｜厨房制作型',
      '框架类型：厨房制作型',
      '数据依据：20条｜占40%',
      '可复用方向：痛点切入→制作→成品',
      '### 竞品素材TOP1｜素人种草型',
      '框架类型：素人种草型',
      '数据依据：10条｜占30%',
      '可复用方向：生活场景→体验→推荐',
      '### 补充机会TOP1｜专家讲解型',
      '机会框架：专家讲解型',
      '竞品依据：5条',
      '可补充方向：顾虑提问→证据解释→建议'
    ].join('\n')
    const html = await markdownToHtmlDocument(markdown)
    expect((html.match(/class="profile-panel"/gu) || [])).toHaveLength(3)
    expect(html).toContain('视频号')
    expect(html).toContain('抖店罗盘')
    expect(html).toContain('巨量云图')
    expect((html.match(/class="method-playbook"/gu) || [])).toHaveLength(3)
    expect((html.match(/class="material-card"/gu) || [])).toHaveLength(3)
    expect(html).toContain('查看完整平台画像明细')
    expect(html).toContain('查看完整素材判断明细')
    const coreAudienceIndex = html.search(/<h1[^>]*>多平台核心人群TOP5<\/h1>/u)
    const profileDetailsIndex = html.indexOf('<details class="evidence-disclosure module-details profile-details">')
    expect(coreAudienceIndex).toBeGreaterThan(0)
    expect(profileDetailsIndex).toBeGreaterThan(coreAudienceIndex)
    expect(html.slice(profileDetailsIndex, html.indexOf('</details>', profileDetailsIndex))).not.toContain(
      '多平台核心人群TOP5'
    )
  })

  it('uses the cross-platform TOP1 as hero and balances one signal per platform', () => {
    const markdown = [
      '# 产品经营报告',
      '## M2 成交人群分析',
      '## 平台：视频号',
      '### 1. 性别',
      '信息：女性64.64%，男性35.36%',
      '来源：视频号画像',
      '## 平台：抖店罗盘',
      '### 1. 性别',
      '信息：女性78.14%，男性21.86%',
      '来源：抖店画像',
      '# 多平台核心人群TOP5',
      '| 优先级 | 人群标签 | 占比/特征 | 决策动机 | 内容语言 |',
      '| --- | --- | --- | --- | --- |',
      '| 第一主力 | 31-40岁女性｜家庭决策者 | 双平台女性占比均较高 | 家庭采购 | 放心、省事 |'
    ].join('\n')
    const presentation = buildHtmlReportPresentation(parseHtmlReportModel(markdown))
    expect(presentation.primaryAudience?.audience).toContain('家庭决策者')
    expect(presentation.mainMetric).toBeNull()
    expect(presentation.supportingSignals.map((metric) => metric.label)).toEqual(['女性占比', '女性占比'])
    expect(new Set(presentation.supportingSignals.map((metric) => metric.sourceLabel.split('/')[0]?.trim()))).toEqual(
      new Set(['视频号', '抖店罗盘'])
    )
  })

  it('renders platform facets, the fused selling-point matrix and ranking, VOC, and the audience route', () => {
    const markdown = [
      '# 产品经营报告',
      '## M1 产品信息',
      '1. 产品基础\n信息：益生菌发酵酸菜\n来源：产品手卡',
      '## M2 成交人群分析',
      '## 平台：视频号',
      '成交画像周期：2026/06/01-2026/06/30',
      '商品销售周期：2026/06/01-2026/06/30',
      '### 1. 性别\n信息：女性64.64%，男性35.36%\n来源：视频号画像｜性别',
      '### 2. 年龄\n信息：60岁以上44.57%，50-59岁24.90%\n来源：视频号画像｜年龄',
      '### 3. 地域\n信息：浙江省13.33%，广东省12.22%\n来源：视频号画像｜地域',
      '### 4. 人群属性\n信息：都市银发48.90%，新锐妈妈10.33%\n来源：视频号画像｜属性',
      '### 5. 消费力\n信息：100-200元43.2%，200-300元26.1%\n来源：销售数据｜价格带',
      '### 6. 购买偏好\n信息：家庭装41.2%，便携装28.6%\n来源：销售数据｜SKU',
      '# 多平台核心人群TOP5',
      '| 优先级 | 人群标签 | 占比/特征 | 决策动机 | 内容语言 |',
      '| --- | --- | --- | --- | --- |',
      '| 第一主力 | 50+女性｜都市银发 | 视频号女性64.64% | 家庭采购 | 安心、稳定 |',
      '### 第一主力来源\n来源：视频号成交画像',
      '## M3 内容素材判断',
      '### 自有素材TOP1｜3.1｜厨房制作型｜痛点开头｜制作展示｜推荐',
      '框架类型：厨房制作型',
      '数据依据：20条｜占自有素材40%',
      '可复用方向：痛点切入→制作→成品→邀请尝试',
      '## M4 卖点提炼与排序',
      '# 一、四大需求卖点买点摘要',
      '### 1. 品质需求\nTOP1\n卖点：九天益生菌发酵\n买点：酸香更稳定',
      '### 2. 价格需求\n无',
      '### 3. 健康需求\nTOP1\n卖点：配料清晰\n买点：家庭吃得更放心',
      '### 4. 情感需求\n无',
      '# 二、核心卖点总排序',
      '## 核心主卖点 TOP1-3',
      '### TOP1｜九天益生菌发酵',
      '需求类型：品质需求\n买点：酸香更稳定\n自营依据：成交素材\n竞品依据：无\n卖点状态：核心验证卖点\n排序判断：产品事实与成交共同支持\n自营来源：产品手卡\n竞品来源：无',
      '## M5 用户真实需求VOC',
      '1. 隐形需求 TOP10',
      'TOP1\n需求：开袋方便\n频次：12次｜占比35%\n来源分布：自营\n代表原话：打开就能做菜\n来源：用户评价｜001',
      '2. 购买顾虑 TOP10',
      'TOP1\n顾虑：价格偏高\n频次：8次｜占比20%\n来源分布：自营\n代表原话：感觉有点贵\n来源：用户评价｜002',
      '## M6 人群×卖点×场景匹配',
      'TOP1\n核心人群：50+家庭女性\n核心卖点：九天益生菌发酵\n真实场景：晚餐给家人做酸菜鱼\n人群依据：视频号画像\n卖点依据：卖点排序TOP1\n场景依据：自有素材'
    ].join('\n')
    const model = parseHtmlReportModel(markdown)
    expect(model.sections.map((section) => section.number)).toEqual(['M1', 'M2', 'M3', 'M4', 'M5', 'M6'])
    const m4Tables = model.sections.find((section) => section.number === 'M4')?.tables || []
    expect(m4Tables.some((table) => table.context === '四类消费者买点')).toBe(true)
    expect(m4Tables.some((table) => table.context === '真实卖点统一排序')).toBe(true)
    const presentation = buildHtmlReportPresentation(model)
    expect(presentation.sections.find((section) => section.sectionNumber === 'M2')?.visualKind).toBe('percent-facets')
    expect(presentation.sections.find((section) => section.sectionNumber === 'M3')?.visualKind).toBe('material-methods')
    expect(presentation.sections.find((section) => section.sectionNumber === 'M4')?.visualKind).toBe('selling-strategy')
    const m5 = model.sections.find((section) => section.number === 'M5')
    expect(m5?.tables[0]?.rows[0]?.[0]).toBe('TOP1')
    expect(m5?.tables[0]?.rows[0]?.[1]).toBe('开袋方便')
    expect(m5?.tables[0]?.rows[0]?.[1]).not.toContain('TOP')
    expect(presentation.sections.find((section) => section.sectionNumber === 'M5')?.visualKind).toBe('voc-insights')
    expect(presentation.sections.find((section) => section.sectionNumber === 'M6')?.visualKind).toBe('audience-map')
  })
})
