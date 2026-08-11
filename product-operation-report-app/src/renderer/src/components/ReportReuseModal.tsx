import { useState } from 'react'
import { useStore } from '../store'

function formatCreatedAt(value: string | undefined): string {
  if (!value) return '最近30天内'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '最近30天内' : date.toLocaleString('zh-CN', { hour12: false })
}

export default function ReportReuseModal(): JSX.Element | null {
  const offer = useStore((state) => state.reportReuseOffer)
  const acceptReportReuse = useStore((state) => state.acceptReportReuse)
  const regenerateReport = useStore((state) => state.regenerateReport)
  const [busy, setBusy] = useState<'reuse' | 'regenerate' | ''>('')

  if (!offer) return null

  const run = async (choice: 'reuse' | 'regenerate'): Promise<void> => {
    if (busy) return
    setBusy(choice)
    try {
      if (choice === 'reuse') await acceptReportReuse()
      else await regenerateReport()
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="modal-mask report-reuse-mask">
      <section
        className="report-reuse-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="report-reuse-title"
      >
        <div className="report-reuse-icon" aria-hidden="true">↺</div>
        <span className="report-reuse-kicker">可直接恢复上次结果</span>
        <h2 id="report-reuse-title">发现相同资料的上次报告</h2>
        <p>文件内容、顺序、文件说明和本次要求都完全一致。你可以直接恢复上次结果，也可以重新生成一份。</p>
        <div className="report-reuse-meta">
          <span>上次生成时间</span>
          <b>{formatCreatedAt(offer.createdAt)}</b>
        </div>
        <button
          autoFocus
          className="btn primary report-reuse-primary"
          type="button"
          disabled={Boolean(busy)}
          onClick={() => void run('reuse')}
        >
          {busy === 'reuse' ? '正在恢复…' : '直接使用上次报告'}
        </button>
        <button
          className="btn report-reuse-secondary"
          type="button"
          disabled={Boolean(busy)}
          onClick={() => void run('regenerate')}
        >
          {busy === 'regenerate' ? '正在开始…' : '重新生成一份'}
        </button>
        <small>直接恢复不会修改原始文件；重新生成会重新执行完整分析。</small>
      </section>
    </div>
  )
}
