import { describe, expect, it } from 'vitest'
import { buildEvidenceSourceNameMap, reportMarkdownForDisplay } from './reportDisplay'

describe('reportMarkdownForDisplay', () => {
  it('hides internal evidence IDs without discarding provenance wording', () => {
    const source = [
      '核心成交规模：211985.04元；来源：`POR-R-32F24FA0-000001`、`POR-R-32F24FA0-000036`。',
      '| 场景 | 酸菜炒肉。来源： POR-T-554F9487-000001、POR-R-F6769716-000047 |'
    ].join('\n')
    const visible = reportMarkdownForDisplay(source)
    expect(visible).not.toMatch(/POR-[RTI]-/u)
    expect(visible).toContain('来源：已核验资料')
    expect(visible).toContain('211985.04元')
    expect(visible).toContain('酸菜炒肉')
  })

  it('also hides internal batch receipts if they leak into a report', () => {
    expect(reportMarkdownForDisplay('依据 POR-B-ABCDEF12-0001|ROWS:1-50|COUNT:50'))
      .toBe('依据 已核验资料')
  })

  it('shows the uploaded file name when the cleaning ledger can resolve the ID', () => {
    const map = buildEvidenceSourceNameMap([{
      name: '经营数据表.xlsx',
      text: '__证据ID,成交金额\nPOR-R-32F24FA0-000001,211985.04'
    }])
    expect(reportMarkdownForDisplay('来源：POR-R-32F24FA0-000001', map))
      .toBe('来源：经营数据表.xlsx')
  })
})
