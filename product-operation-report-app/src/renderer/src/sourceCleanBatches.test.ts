import { describe, expect, it } from 'vitest'
import Papa from 'papaparse'
import {
  buildSourceCleanBatchPlan,
  combineSourceCleanBatchOutputs,
  sourceCleanBatchInternals
} from './sourceCleanBatches'

describe('row-anchored source cleaning coverage', () => {
  const source = {
    name: '素材.csv',
    kind: 'table' as const,
    text: '原视频,3秒开头\na.mp4,开头A\nb.mp4,开头B'
  }

  it('accepts a CSV result with exactly one populated row per evidence ID', () => {
    const plan = buildSourceCleanBatchPlan(source)
    expect(plan.mode).toBe('table_rows')
    const outputs = plan.batches.map((batch) => `分类：竞品数据\n${batch.source.text || ''}`)
    expect(combineSourceCleanBatchOutputs(plan, outputs)).toContain('全部有效记录均已送入清洗')
  })

  it('rejects an answer-sheet dump at the end of the response', () => {
    const plan = buildSourceCleanBatchPlan(source)
    const outputs = plan.batches.map((batch) =>
      `分类：竞品数据\n${'摘要'.repeat(1200)}\n${batch.context.evidenceIds.join('\n')}`
    )
    expect(() => combineSourceCleanBatchOutputs(plan, outputs)).toThrow(/未覆盖/u)
  })

  it('rejects fewer populated rows than evidence IDs', () => {
    const plan = buildSourceCleanBatchPlan(source)
    const outputs = plan.batches.map((batch) => {
      const rows = Papa.parse<string[]>(batch.source.text || '', { skipEmptyLines: 'greedy' }).data
      return `分类：竞品数据\n${Papa.unparse(rows.slice(0, -1))}`
    })
    expect(() => combineSourceCleanBatchOutputs(plan, outputs)).toThrow(/未覆盖/u)
  })

  it('accepts compact semantic coverage receipts without requiring the model to copy every row', () => {
    const text = [
      '评价内容,评分',
      ...Array.from({ length: 400 }, (_, index) => [`第${index + 1}条-${'使用体验'.repeat(16)}`, String(index % 5 + 1)])
    ].map((row) => Array.isArray(row) ? row.join(',') : row).join('\n')
    const plan = buildSourceCleanBatchPlan({ name: '评价.csv', kind: 'table', text }, { semanticSummary: true })
    const outputs = plan.batches.map((batch) => [
      '分类：自有数据 | 平台 | 用户评价 | 时间待补充 | 表格 | 评价主题',
      `- 本批主要反馈见 ${batch.context.evidenceIds[0]}`,
      `COVERAGE:${batch.context.coverageReceipt}`
    ].join('\n'))
    const combined = combineSourceCleanBatchOutputs(plan, outputs)
    expect(combined).toContain('全部有效记录均已送入模型读取')
    expect(combined).not.toContain(plan.batches[0].context.evidenceIds[1])
  })

  it('reports why an ultra-wide table cannot use row verification', () => {
    const text = Papa.unparse([
      Array.from({ length: 201 }, (_, index) => `列${index}`),
      Array.from({ length: 201 }, (_, index) => `值${index}`)
    ])
    const plan = buildSourceCleanBatchPlan({ name: '超宽.csv', kind: 'table', text })
    expect(plan.degradedReason).toBe('too_wide')
    expect(plan.mode).toBe('single')
  })

  it('keeps every latency-safe table batch below the production limit', () => {
    const rows = [
      ['原视频', '完整文案'],
      ...Array.from({ length: 240 }, (_, index) => [`素材-${index}.mp4`, `第${index}条-${'内容'.repeat(120)}`])
    ]
    const plan = buildSourceCleanBatchPlan({ name: '大素材表.csv', kind: 'table', text: Papa.unparse(rows) })
    expect(plan.mode).toBe('table_rows')
    expect(plan.batches.length).toBeGreaterThan(1)
    expect(plan.batches.every((batch) => (batch.source.text || '').length <= sourceCleanBatchInternals.CLEAN_BATCH_CHAR_LIMIT)).toBe(true)
    expect(sourceCleanBatchInternals.CLEAN_BATCH_CHAR_LIMIT).toBeLessThanOrEqual(28_000)
  })

  it('plans 50 large files without creating an oversized cleaning batch', () => {
    const text = Papa.unparse([
      ['原视频', '完整文案'],
      ...Array.from({ length: 120 }, (_, index) => [`素材-${index}.mp4`, `第${index}条-${'内容'.repeat(120)}`])
    ])
    const plans = Array.from({ length: 50 }, (_, index) =>
      buildSourceCleanBatchPlan({ name: `压力资料-${index + 1}.csv`, kind: 'table', text })
    )
    expect(plans).toHaveLength(50)
    expect(plans.every((plan) => plan.mode === 'table_rows')).toBe(true)
    expect(plans.flatMap((plan) => plan.batches).every((batch) =>
      (batch.source.text || '').length <= sourceCleanBatchInternals.CLEAN_BATCH_CHAR_LIMIT
    )).toBe(true)
  })

  it('keeps PPT text and embedded images under one source cleaning plan', () => {
    const plan = buildSourceCleanBatchPlan({
      name: '产品手卡.pptx',
      kind: 'doc',
      text: '--- 第 1 页 ---\n产品卖点',
      attachments: Array.from({ length: 5 }, (_, index) => ({
        name: `第1页/内嵌图片/image${index + 1}.png`,
        dataUrl: `data:image/png;base64,IMAGE${index + 1}`
      }))
    })
    expect(plan.mode).toBe('mixed_evidence')
    expect(plan.batches).toHaveLength(3)
    expect(plan.batches[0].source.attachments).toBeUndefined()
    expect(plan.batches[1].source.attachments).toHaveLength(4)
    expect(plan.batches[2].source.attachments).toHaveLength(1)
    const outputs = plan.batches.map((batch) =>
      `分类：自有数据\n${batch.context.evidenceIds.join('\n')}\n已读取本批内容`
    )
    expect(combineSourceCleanBatchOutputs(plan, outputs)).toContain('动态清洗批次：3 批')
  })
})
