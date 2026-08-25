import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ModelTaskType, TokenUsageDashboard } from '../../../shared/types'

const STAGE_LABELS: Record<ModelTaskType, string> = {
  source_clean: '文件清洗',
  summary: '资料汇总',
  analysis_step: '分析步骤 1–8',
  final_part: '四段成稿',
  revision_part: '报告修订',
  module_product_info: 'M1 产品信息',
  module_platform_audience: 'M2 平台人群',
  module_material_review: 'M3 素材判断',
  module_benchmark: '旧版 M4 对标推荐',
  module_selling_points: 'M4 卖点提炼与排序',
  module_voc: 'M5 用户VOC',
  module_ranking: '旧版 M7 卖点排序',
  module_audience_sp_scene: 'M6 人群卖点场景'
}

function formatTokens(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toLocaleString('zh-CN') : '0'
}

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false })
}

interface Props {
  open: boolean
  onClose: () => void
}

export default function TokenUsageModal({ open, onClose }: Props): JSX.Element | null {
  const [dashboard, setDashboard] = useState<TokenUsageDashboard | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      setDashboard(await window.api.getTokenUsageSummary())
    } catch {
      setError('Token 统计暂时无法读取，请稍后重试。')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, open])

  const totals = useMemo(() => {
    const reports = dashboard?.reports || []
    return reports.reduce(
      (sum, report) => ({
        input: sum.input + report.inputTokens,
        output: sum.output + report.outputTokens,
        reasoning: sum.reasoning + report.reasoningTokens,
        total: sum.total + report.totalTokens,
        cached: sum.cached + report.cachedInputTokens,
        successfulTokens: sum.successfulTokens + report.successfulTokens,
        failedTokens: sum.failedTokens + report.failedTokens,
        retryTokens: sum.retryTokens + report.retryTokens,
        abortedTokens: sum.abortedTokens + report.abortedTokens,
        failed: sum.failed + report.failedAttempts,
        retried: sum.retried + report.retryAttempts,
        aborted: sum.aborted + report.abortedAttempts
      }),
      {
        input: 0,
        output: 0,
        reasoning: 0,
        total: 0,
        cached: 0,
        successfulTokens: 0,
        failedTokens: 0,
        retryTokens: 0,
        abortedTokens: 0,
        failed: 0,
        retried: 0,
        aborted: 0
      }
    )
  }, [dashboard])

  const stages = useMemo(() => {
    const values = new Map<ModelTaskType, { attempts: number; total: number }>()
    for (const report of dashboard?.reports || []) {
      for (const stage of report.stages) {
        const current = values.get(stage.taskType) || { attempts: 0, total: 0 }
        current.attempts += stage.attempts
        current.total += stage.totalTokens
        values.set(stage.taskType, current)
      }
    }
    return Object.keys(STAGE_LABELS).map((key) => ({
      taskType: key as ModelTaskType,
      ...(values.get(key as ModelTaskType) || { attempts: 0, total: 0 })
    }))
  }, [dashboard])

  if (!open) return null

  return (
    <div className="modal-mask token-stats-mask" onMouseDown={onClose}>
      <section
        className="modal token-stats-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="token-stats-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-head token-stats-head">
          <div>
            <span className="token-stats-kicker">仅开发者可见 · 真实用量采样</span>
            <h3 id="token-stats-title">Token 统计</h3>
          </div>
          <button className="btn" type="button" onClick={onClose} aria-label="关闭 Token 统计">
            关闭
          </button>
        </div>
        <div className="modal-body token-stats-body">
          {loading && !dashboard ? <div className="token-stats-empty">正在读取本机计量记录…</div> : null}
          {error ? <div className="token-stats-error" role="alert">{error}</div> : null}
          {dashboard ? (
            <>
              <div className="token-stats-notice">
                这里只统计 CCG 返回的真实 Token。缺失 usage 的请求单独标记，估算值不会进入 P50 / P75 / P95。
              </div>
              <div className="token-stats-grid token-optimization-grid" aria-label="本机成本优化统计">
                <article><span>本机完成文件</span><strong>{dashboard.optimization.localCompletedFiles}</strong></article>
                <article><span>清洗缓存命中</span><strong>{dashboard.optimization.sourceCacheHits}</strong></article>
                <article><span>跳过模型请求</span><strong>{dashboard.optimization.skippedModelRequests}</strong></article>
                <article><span>整份报告复用</span><strong>{dashboard.optimization.reusedReports}</strong></article>
              </div>
              <div className="token-stats-grid">
                <article><span>有效完整报告</span><strong>{dashboard.completedExactReports}<small> / 30 份</small></strong></article>
                <article><span>真实总 Token</span><strong>{formatTokens(totals.total)}</strong></article>
                <article><span>输入 / 输出</span><strong>{formatTokens(totals.input)}<small> / {formatTokens(totals.output)}</small></strong></article>
                <article><span>usage 覆盖</span><strong>{dashboard.recordCount ? Math.round((dashboard.providerRecordCount / dashboard.recordCount) * 100) : 0}<small>%</small></strong></article>
                <article><span>缓存输入 Token</span><strong>{formatTokens(totals.cached)}</strong></article>
                <article><span>其中推理 Token</span><strong>{formatTokens(totals.reasoning)}</strong></article>
                <article><span>成功内容消耗</span><strong>{formatTokens(totals.successfulTokens)}</strong></article>
                <article><span>失败 / 重试消耗</span><strong>{formatTokens(totals.failedTokens)}<small> / {formatTokens(totals.retryTokens)}</small></strong></article>
                <article><span>主动停止消耗</span><strong>{formatTokens(totals.abortedTokens)}</strong></article>
              </div>
              <div className="token-stats-percentiles" aria-label="完整报告 Token 分位数">
                <div><span>P50</span><b>{formatTokens(dashboard.percentiles.p50)}</b></div>
                <div><span>P75</span><b>{formatTokens(dashboard.percentiles.p75)}</b></div>
                <div><span>P95</span><b>{formatTokens(dashboard.percentiles.p95)}</b></div>
                <p>样本 {dashboard.percentiles.sampleSize} 份；分位数用于后续设计充值套餐，不影响当前按真实 Token 实时结算。</p>
              </div>
              <div className="token-stats-columns">
                <section>
                  <h4>任务阶段</h4>
                  <div className="token-stats-table" role="table" aria-label="任务阶段 Token">
                    {stages.map((stage) => (
                      <div className="token-stats-row" role="row" key={stage.taskType}>
                        <span role="cell">{STAGE_LABELS[stage.taskType]}</span>
                        <span role="cell">{stage.attempts} 次 · {totals.total ? Math.round((stage.total / totals.total) * 100) : 0}%</span>
                        <b role="cell">{formatTokens(stage.total)}</b>
                      </div>
                    ))}
                  </div>
                </section>
                <section>
                  <h4>资料规模</h4>
                  <div className="token-stats-table" role="table" aria-label="资料规模 Token">
                    {dashboard.buckets.map((bucket) => (
                      <div className="token-stats-row" role="row" key={bucket.label}>
                        <span role="cell">{bucket.label}</span>
                        <span role="cell">{bucket.exactCompletedCount} 份有效</span>
                        <b role="cell">均 {formatTokens(bucket.averageTotalTokens)}</b>
                      </div>
                    ))}
                  </div>
                </section>
              </div>
              <section className="token-stats-reports">
                <h4>最近报告</h4>
                {dashboard.reports.length ? dashboard.reports.slice(0, 20).map((report) => (
                  <article key={report.reportSessionId}>
                    <div>
                      <b>{formatTime(report.endedAt)}</b>
                      <span>{report.sourceCount} 份资料 · {report.imageCount} 张图片</span>
                    </div>
                    <div>
                      <strong>{formatTokens(report.totalTokens)} Token</strong>
                      <span>
                        {report.completed ? '完整报告' : '未完成'} · {report.exact ? '真实 usage 完整' : `缺失 ${report.missingUsageAttempts} 次`}
                      </span>
                    </div>
                    <div>
                      <span>失败 {report.failedAttempts}</span>
                      <span>重试 {report.retryAttempts}</span>
                      <span>停止 {report.abortedAttempts}</span>
                      <span>平均每份 {formatTokens(report.sourceCount ? report.totalTokens / report.sourceCount : 0)}</span>
                    </div>
                  </article>
                )) : <div className="token-stats-empty">还没有模型请求记录。完成测试报告后会自动出现在这里。</div>}
              </section>
            </>
          ) : null}
        </div>
        <div className="modal-foot token-stats-foot">
          <span>日志只包含任务标识和用量，不保存资料、提示词、回答、激活码或 API Key。</span>
          <div>
            <button className="btn" type="button" disabled={loading} onClick={() => void refresh()}>{loading ? '刷新中…' : '刷新'}</button>
            <button className="btn primary" type="button" onClick={() => void window.api.openTokenUsageLocation()}>打开日志位置</button>
          </div>
        </div>
      </section>
    </div>
  )
}
