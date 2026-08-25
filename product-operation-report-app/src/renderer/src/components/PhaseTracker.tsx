import { REPORT_MODULES } from '../../../shared/types'
import { derivedSourceCount, topLevelSourceCount, useStore } from '../store'

const MACROS = [
  { title: '上传资料', desc: '产品手卡、自有数据、竞品数据' },
  { title: '资料校验', desc: '逐文件解析，清洗归类，确认缺口' },
  { title: '经营分析', desc: '产品、人群、素材、卖点与场景' },
  { title: '确认结论', desc: '核对卖点排序和报告初稿' },
  { title: '生成报告', desc: '定稿并导出 HTML / Word' }
]

const ANALYSIS_COPY: Record<number, { title: string; desc: string }> = {
  1: { title: '产品信息', desc: '9维客观产品事实' },
  2: { title: '成交人群分析', desc: '分平台画像与核心人群TOP5' },
  3: { title: '内容素材判断', desc: '自有与竞品框架汇总' },
  4: { title: '卖点提炼与排序', desc: '四大需求与真实卖点TOP10' },
  5: { title: '用户真实需求VOC', desc: '频次、占比与代表原话' },
  6: { title: '人群×卖点×场景', desc: 'TOP5真实匹配组合' }
}

type TaskStatus = 'done' | 'active' | 'paused' | 'idle'

function activeIndex(phase: string): number {
  if (phase === 'idle') return 0
  if (phase === 'cleaning' || phase === 'checkpoint1') return 1
  if (phase === 'analyzing') return 2
  if (phase === 'checkpoint2') return 3
  if (phase === 'done') return 4
  return 0
}

function taskLabel(status: TaskStatus): string {
  if (status === 'done') return '完成'
  if (status === 'active') return '进行中'
  if (status === 'paused') return '待继续'
  return '等待'
}

export default function PhaseTracker(): JSX.Element {
  const phase = useStore((s) => s.phase)
  const sources = useStore((s) => s.sources)
  const cleaningProgress = useStore((s) => s.cleaningProgress)
  const reportMarkdown = useStore((s) => s.reportMarkdown)
  const artifacts = useStore((s) => s.artifacts)
  const moduleStates = useStore((s) => s.moduleStates)
  const readOnly = useStore((s) => s.readOnly)
  const retryModule = useStore((s) => s.retryModule)
  const ai = activeIndex(phase)
  const uploadedFileCount = topLevelSourceCount(sources)
  const parsedFileCount = topLevelSourceCount(sources.filter((source) => source.dataUrl || source.text))
  const competitorFileCount = topLevelSourceCount(sources.filter((source) => /竞品数据|竞品|对标|对手/.test(source.attribution ?? '')))
  const derivedCount = derivedSourceCount(sources)

  const analysisTasks = [...REPORT_MODULES].sort((left, right) => left.id - right.id).map((module) => ({
    id: module.id,
    key: module.key,
    title: ANALYSIS_COPY[module.id]?.title ?? module.title,
    desc: moduleStates[module.key]?.status === 'done' && moduleStates[module.key]?.message
      ? moduleStates[module.key]!.message!
      : ANALYSIS_COPY[module.id]?.desc ?? ''
  }))
  const isTaskDone = (id: number): boolean => {
    return Boolean(artifacts[id])
  }
  const doneCount = analysisTasks.filter((task) => isTaskDone(task.id)).length
  const firstPending = analysisTasks.find((task) => !isTaskDone(task.id))

  const getTaskStatus = (id: number): TaskStatus => {
    if (isTaskDone(id)) return 'done'
    if (phase === 'analyzing' && moduleStates[analysisTasks.find((task) => task.id === id)?.key || 'product-info']?.status === 'running') return 'active'
    if (moduleStates[analysisTasks.find((task) => task.id === id)?.key || 'product-info']?.status === 'failed') return 'paused'
    if (phase === 'checkpoint1' && id === firstPending?.id && doneCount > 0) return 'paused'
    return 'idle'
  }

  const analysisPercent = Math.round((doneCount / Math.max(analysisTasks.length, 1)) * 100)

  return (
    <div className="pane phase-pane">
      <div className="pane-title">研究流程</div>
      <div className="pane-body">
        <div className="macro-list">
          {MACROS.map((m, i) => {
            const status = ai > i ? 'done' : ai === i ? 'active' : 'idle'
            return (
              <div key={i} className={`macro ${status}`}>
                <span className="macro-num">{status === 'done' ? '✓' : i + 1}</span>
                <div className="macro-main">
                  <div className="macro-title">{m.title}</div>
                  <div className="macro-desc">{m.desc}</div>
                </div>
              </div>
            )
          })}
        </div>

        <div className="analysis-flow">
          <div className="analysis-flow-head">
            <div>
              <b>6 模块自动分析</b>
              <span>{readOnly ? '旧报告只读' : phase === 'analyzing' ? '按三波并行处理' : '确认资料后自动完成'}</span>
            </div>
            <em>
              {doneCount}/{analysisTasks.length}
            </em>
          </div>
          <div className="analysis-progress-track" aria-label={`正式分析完成度 ${analysisPercent}%`}>
            <div style={{ width: `${analysisPercent}%` }} />
          </div>
          <div className="analysis-task-list">
            {analysisTasks.map((task) => {
              const status = getTaskStatus(task.id)
              return (
                <div key={task.id} className={`analysis-task ${status}`}>
                  <span className="analysis-task-dot">{status === 'done' ? '✓' : task.id}</span>
                  <div className="analysis-task-main">
                    <div className="analysis-task-title">
                      <span>{task.title}</span>
                    </div>
                    <div className="analysis-task-desc">{task.desc}</div>
                  </div>
                  {(moduleStates[task.key]?.status === 'failed' || moduleStates[task.key]?.message?.includes('旧版内容转换')) && !readOnly ? (
                    <button className="btn xs" type="button" onClick={() => void retryModule(task.key)}>
                      {moduleStates[task.key]?.message?.includes('旧版内容转换') ? '按新版重新生成' : '重试本模块'}
                    </button>
                  ) : (
                    <span className="analysis-task-status">{taskLabel(status)}</span>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        <div className="source-health">
          <div className="source-health-title">
            <span>资料状态</span>
            <small>最多上传 50 份资料</small>
          </div>
          <div className="health-row">
            <span>已上传</span>
            <b>{uploadedFileCount} 份</b>
          </div>
          <div className="health-row">
            <span>可分析</span>
            <b>{parsedFileCount} 份</b>
          </div>
          <div className="health-row">
            <span>竞品资料</span>
            <b>{competitorFileCount} 份</b>
          </div>
          {derivedCount > 0 && (
            <div className="health-row">
              <span>已展开证据</span>
              <b>{derivedCount} 项</b>
            </div>
          )}
          {phase === 'cleaning' && (
            <>
              <div className="health-row strong">
                <span>正在清洗</span>
                <b>{cleaningProgress.done}/{cleaningProgress.total}</b>
              </div>
              <div className="health-row">
                <span>预计时间</span>
                <b>{cleaningProgress.done > 0 && cleaningProgress.startedAt
                  ? `约 ${Math.max(1, Math.ceil(((Date.now() - cleaningProgress.startedAt) / cleaningProgress.done) * Math.max(0, cleaningProgress.total - cleaningProgress.done) / 60_000))} 分钟`
                  : '通常需数分钟'}</b>
              </div>
            </>
          )}
          {phase === 'analyzing' && (
            <div className="health-row">
              <span>预计时间</span>
              <b>大项目约10-20分钟</b>
            </div>
          )}
          {reportMarkdown && (
            <div className="health-row strong ok">
              <span>报告</span>
              <b>{phase === 'analyzing' ? '生成中' : '已生成'}</b>
            </div>
          )}
        </div>
        <div className="macro-note">
          新版只需确认一次：资料整理完成后确认，随后8个模块自动完成并生成报告。
        </div>
      </div>
    </div>
  )
}
