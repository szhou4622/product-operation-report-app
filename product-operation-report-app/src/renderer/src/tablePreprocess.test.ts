import { describe, expect, it } from 'vitest'
import Papa from 'papaparse'
import { buildLocalTableCleanDetail, preprocessTableForModel } from './tablePreprocess'

describe('local structured table preparation', () => {
  it('removes only safe redundant columns while retaining every material row and evidence field', () => {
    const headers = [
      '文本', '原视频', '豆包', '豆包.思考过程', '豆包.输出结果', '前三秒文案',
      '完整文案', '素材类型', '视角分析', '内容形式', '场景标签', '卖点排序'
    ]
    const rows = Array.from({ length: 59 }, (_, index) => {
      const wrapper = `旧AI完整包装-${index}-${'冗余'.repeat(20)}`
      return [
        '', `video-${index + 1}.mp4`, wrapper, `推理过程-${index}`, wrapper,
        `开头-${index + 1}`, `第${index + 1}条完整文案-${'内容'.repeat(20)}`,
        index % 2 ? '3.2' : '3.99', '用户视角', '产品展示型', '家庭', `卖点-${index + 1}`
      ]
    })
    const source = {
      name: '竞品素材.xlsx',
      kind: 'table' as const,
      text: Papa.unparse([headers, ...rows]),
      attribution: '竞品数据'
    }
    const result = preprocessTableForModel(source.text)
    expect(result.canSkipModel).toBe(true)
    expect(result.retainedRows).toBe(59)
    expect(result.removedColumns).toEqual(expect.arrayContaining(['文本', '豆包', '豆包.思考过程', '豆包.输出结果']))
    expect(result.text).toContain('视角分析')
    expect(result.text).toContain('video-1.mp4')
    expect(result.text).toContain('video-59.mp4')
    expect(result.text).not.toContain('旧AI完整包装')
    expect(result.text).not.toContain('推理过程')
    const detail = buildLocalTableCleanDetail(source, result)
    expect(detail).toContain('未调用模型，本文件未扣清洗积分')
    expect(detail).toContain('59 个唯一证据ID')
    expect((detail?.match(/POR-R-/gu) || [])).toHaveLength(59)
  })

  it('preserves duplicate data rows and every worksheet', () => {
    const text = [
      '### 工作表：商品',
      '商品名称,成交金额\n产品A,100\n产品A,100',
      '',
      '### 工作表：人群',
      '标签类型,标签,占比\n年龄,30-39,60%\n地区,广东,40%'
    ].join('\n')
    const result = preprocessTableForModel(text)
    expect(result.canSkipModel).toBe(true)
    expect(result.sheetCount).toBe(2)
    expect(result.originalRows).toBe(4)
    expect(result.retainedRows).toBe(4)
    const detail = buildLocalTableCleanDetail({ name: '多表.xlsx', kind: 'table', text }, result)
    expect(detail).toContain('工作表：商品')
    expect(detail).toContain('工作表：人群')
    expect((detail?.match(/产品A,100/gu) || [])).toHaveLength(2)
    expect((detail?.match(/POR-R-/gu) || [])).toHaveLength(4)
  })

  it('falls back for malformed or unknown table structures', () => {
    expect(preprocessTableForModel('名称,内容\n测试,"引号未闭合').canSkipModel).toBe(false)
    expect(preprocessTableForModel('甲列,乙列\n值1,值2').canSkipModel).toBe(false)
  })

  it('keeps an occasional extra CSV field in a generated column instead of sending thousands of rows to the model', () => {
    const text = [
      '标签类型,标签,占比',
      ...Array.from({ length: 3_049 }, (_, index) => index === 677
        ? `电商品类成交偏好,标签${index + 1},0%,14.53%`
        : `电商品类成交偏好,标签${index + 1},${index % 100}%`)
    ].join('\n')
    const result = preprocessTableForModel(text)
    expect(result.canSkipModel).toBe(true)
    expect(result.retainedRows).toBe(3_049)
    expect(result.text).toContain('未命名附加列1')
    expect(result.text).toContain('0%,14.53%')
    const detail = buildLocalTableCleanDetail({ name: '画像.csv', kind: 'table', text }, result)
    expect(detail).toContain('本机完整读取 1 个工作表、3049 条有效记录')
    expect((detail?.match(/POR-R-/gu) || [])).toHaveLength(3_049)
  })

  it('handles the maximum 50-file structured workload without model cleaning', () => {
    const text = Papa.unparse([
      ['商品名称', '成交金额', '成交订单数'],
      ...Array.from({ length: 100 }, (_, index) => [`产品-${index}`, index * 10, index])
    ])
    const results = Array.from({ length: 50 }, (_, index) => {
      const source = { name: `商品-${index + 1}.csv`, kind: 'table' as const, text }
      const result = preprocessTableForModel(text)
      return { result, detail: buildLocalTableCleanDetail(source, result) }
    })
    expect(results.every(({ result }) => result.canSkipModel && result.retainedRows === 100)).toBe(true)
    expect(results.every(({ detail }) => (detail?.match(/POR-R-/gu) || []).length === 100)).toBe(true)
  })

  it('classifies product transaction tables as product even when they contain percentage columns', () => {
    const text = '商品名称,成交金额,退款率,评价好评率\n产品A,1000,2%,98%'
    const result = preprocessTableForModel(text)
    expect(result.canSkipModel).toBe(true)
    expect(result.mode).toBe('product')
  })

  it('uses the user-selected business type instead of the legacy purpose field', () => {
    const text = '标签类型,标签,占比\n年龄,31-40岁,60%'
    const result = preprocessTableForModel(text)
    const detail = buildLocalTableCleanDetail({
      name: '成交画像.csv',
      kind: 'table',
      text,
      kindV1: 'audience-data',
      purpose: '旧版商品经营数据'
    }, result)
    expect(detail).toContain('信息类型：人群与行为画像')
    expect(detail).not.toContain('旧版商品经营数据')
  })
})
