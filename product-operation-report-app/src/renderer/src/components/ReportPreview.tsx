import { useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { buildEvidenceSourceNameMap, reportMarkdownForDisplay } from '../../../shared/reportDisplay'
import { useStore } from '../store'
import { validateReport, validateReportStructure } from '../validate'

export default function ReportPreview(): JSX.Element {
  const reportMarkdown = useStore((s) => s.reportMarkdown)
  const cleanDetails = useStore((s) => s.cleanDetails)
  const reportStale = useStore((s) => s.reportStale)
  const artifacts = useStore((s) => s.artifacts)
  const phase = useStore((s) => s.phase)
  const exportStatus = useStore((s) => s.exportStatus)
  const lastExportPath = useStore((s) => s.lastExportPath)
  const openingExport = useStore((s) => s.openingExport)
  const exportReport = useStore((s) => s.exportReport)
  const openLastExport = useStore((s) => s.openLastExport)
  const showLastExportInFolder = useStore((s) => s.showLastExportInFolder)

  const reportGenerating = phase === 'cleaning' || phase === 'analyzing'
  const evidenceSourceNames = useMemo(
    () => buildEvidenceSourceNameMap(cleanDetails),
    [cleanDetails]
  )
  const displayReportMarkdown = useMemo(
    () => reportMarkdownForDisplay(reportMarkdown, evidenceSourceNames),
    [reportMarkdown, evidenceSourceNames]
  )
  const exporting = exportStatus === '导出中…'
  const warnings = useMemo(
    () => (reportGenerating ? [] : validateReport(reportMarkdown)),
    [reportGenerating, reportMarkdown]
  )
  const canExport =
    Boolean(reportMarkdown) &&
    !reportGenerating &&
    !exporting &&
    artifacts[9] === reportMarkdown &&
    (phase === 'done' || reportStale) &&
    validateReportStructure(reportMarkdown).length === 0
  const headings = useMemo(
    () =>
      displayReportMarkdown
        .split('\n')
        .map((line) => line.match(/^(#{1,3})\s+(.+)$/))
        .filter((m): m is RegExpMatchArray => Boolean(m))
        .slice(0, 18)
        .map((m) => ({ level: m[1].length, text: m[2].replace(/\*\*/g, '') })),
    [displayReportMarkdown]
  )

  return (
    <div className={`pane report-pane ${phase === 'checkpoint2' || phase === 'done' ? 'report-ready' : ''}`} style={{ borderRight: 'none' }}>
      <div className="pane-title report-title-bar">
        <span>{reportGenerating && reportMarkdown ? '报告生成中…' : reportMarkdown ? '报告预览' : '报告大纲'}</span>
        {reportMarkdown && (
          <span className="export-bar">
            <button className="btn xs primary" disabled={!canExport} onClick={() => void exportReport('html')}>
              导出 HTML
            </button>
            <button className="btn xs" disabled={!canExport} onClick={() => void exportReport('md')}>
              导出 MD
            </button>
            <button className="btn xs" disabled={!canExport} onClick={() => void exportReport('docx')}>
              导出 Word
            </button>
          </span>
        )}
      </div>
      <div className="pane-body">
        {reportMarkdown ? (
          <div className="report-content">
            <aside className="report-outline-nav">
              <div className="outline-title">目录</div>
              {headings.map((h, i) => (
                <div key={`${h.text}-${i}`} className={`outline-link level-${h.level}`}>
                  {h.text}
                </div>
              ))}
            </aside>
            <main className="report-canvas">
              {reportStale && (
                <div className="warnings">
                  <div className="warnings-title">资料已变化</div>
                  <div>当前保留的是上一份完整报告，可先导出备份；重新生成成功后会自动替换。</div>
                </div>
              )}
              {phase === 'checkpoint2' ? (
                <div className="warnings">
                  <div className="warnings-title">这是待确认的初稿</div>
                  <div>请先检查内容，再点击左侧“确认定稿”；定稿后才能导出最终报告。</div>
                </div>
              ) : reportGenerating ? (
                <div className="structure-ok">报告正在生成，完成后才能导出。</div>
              ) : warnings.length > 0 ? (
                <div className="warnings">
                  <div className="warnings-title">成稿检查（{warnings.length}）</div>
                  <ul>
                    {warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </div>
              ) : (
                <div className="structure-ok">成稿结构符合目标报告模板</div>
              )}
              {exportStatus && (
                <div className="export-status">
                  <span>{exportStatus}</span>
                  {lastExportPath && (
                    <div className="export-result-actions">
                      <button
                        className="btn xs primary"
                        disabled={openingExport}
                        onClick={() => void openLastExport()}
                      >
                        {openingExport ? '正在打开…' : '打开刚导出的文件'}
                      </button>
                      <button
                        className="btn xs"
                        disabled={openingExport}
                        onClick={() => void showLastExportInFolder()}
                      >
                        打开所在文件夹
                      </button>
                    </div>
                  )}
                </div>
              )}
              <div className="markdown-body">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{displayReportMarkdown}</ReactMarkdown>
              </div>
            </main>
          </div>
        ) : (
          <div className="report-body">
            <div className="report-placeholder-title">报告生成后会进入文档画布</div>
            <div className="report-placeholder-copy">
              系统会把已确认的资料清洗、卖点、人群和内容策略整合成一份可导出的经营报告。
            </div>
            <div className="report-skeleton-list">
              {['结论摘要', '数据来源与使用范围', '产品基础信息', '一方数据判断', '竞品/素材分析', '人群画像与内容主线', '执行选题表'].map((item) => (
                <span key={item}>{item}</span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
