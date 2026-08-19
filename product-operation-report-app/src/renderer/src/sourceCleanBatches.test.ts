import { describe, expect, it } from 'vitest'
import Papa from 'papaparse'
import { buildSourceCleanBatchPlan, combineSourceCleanBatchOutputs } from './sourceCleanBatches'

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

  it('reports why an ultra-wide table cannot use row verification', () => {
    const text = Papa.unparse([
      Array.from({ length: 201 }, (_, index) => `列${index}`),
      Array.from({ length: 201 }, (_, index) => `值${index}`)
    ])
    const plan = buildSourceCleanBatchPlan({ name: '超宽.csv', kind: 'table', text })
    expect(plan.degradedReason).toBe('too_wide')
    expect(plan.mode).toBe('single')
  })
})
