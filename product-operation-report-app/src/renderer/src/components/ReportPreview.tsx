import { useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useStore } from '../store'
import { validateReport } from '../validate'

export default function ReportPreview(): JSX.Element {
  const reportMarkdown = useStore((s) => s.reportMarkdown)
  const phase = useStore((s) => s.phase)
  const exportStatus = useStore((s) => s.exportStatus)
  const exportReport = useStore((s) => s.exportReport)

  const warnings = useMemo(() => validateReport(reportMarkdown), [reportMarkdown])
  const headings = useMemo(
    () =>
      reportMarkdown
        .split('\n')
        .map((line) => line.match(/^(#{1,3})\s+(.+)$/))
        .filter((m): m is RegExpMatchArray => Boolean(m))
        .slice(0, 18)
        .map((m) => ({ level: m[1].length, text: m[2].replace(/\*\*/g, '') })),
    [reportMarkdown]
  )

  return (
    <div className={`pane report-pane ${phase === 'checkpoint2' || phase === 'done' ? 'report-ready' : ''}`} style={{ borderRight: 'none' }}>
      <div className="pane-title report-title-bar">
        <span>{reportMarkdown ? '报告智能画布' : '报告生成队列'}</span>
        {reportMarkdown && (
          <span className="export-bar">
            <button className="btn xs primary" onClick={() => void exportReport('html')}>
              导出 HTML
            </button>
            <button className="btn xs" onClick={() => void exportReport('md')}>
              导出 MD
            </button>
            <button className="btn xs" onClick={() => void exportReport('docx')}>
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
              {warnings.length > 0 ? (
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
              {exportStatus && <div className="export-status">{exportStatus}</div>}
              <div className="markdown-body">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{reportMarkdown}</ReactMarkdown>
              </div>
            </main>
          </div>
        ) : (
          <div className="report-body">
            <div className="report-placeholder-title">AI 报告代理正在等待可分析资料</div>
            <div className="report-placeholder-copy">
              资料确认后，系统会把清洗结果、卖点判断、人群画像和内容策略整合成一份可导出的经营报告。
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
