import { SOP_STEPS } from '../../../shared/types'
import { derivedSourceCount, topLevelSourceCount, useStore } from '../store'

const MACROS = [
  { title: '上传资料', desc: '产品手卡、自有数据、竞品数据' },
  { title: '资料校验', desc: '逐文件解析，清洗归类，确认缺口' },
  { title: '经营分析', desc: '卖点、竞品、人群、内容主线' },
  { title: '确认结论', desc: '核对卖点排序和报告初稿' },
  { title: '生成报告', desc: '定稿并导出 HTML / Word' }
]

const ANALYSIS_COPY: Record<number, { title: string; desc: string }> = {
  1: { title: '确定产品', desc: '产品、规格、价格、定位' },
  2: { title: '12维卖点', desc: '包装、价格、工艺、场景等' },
  3: { title: '竞品卖点', desc: '竞品素材与卖点拆解' },
  4: { title: '自有卖点排序', desc: '按用户决策价值排序' },
  5: { title: '人群画像', desc: '核心人群与购买动机' },
  6: { title: '痛点场景卖点矩阵', desc: '人群 x 痛点 x 场景 x 卖点' },
  7: { title: '视频号主线', desc: '3-5条内容主线' },
  8: { title: '执行选题表', desc: '可交付的选题与脚本方向' },
  9: { title: '成稿生成', desc: '整合为正式经营报告' }
}

const REPORT_STEP_ID = SOP_STEPS[SOP_STEPS.length - 1]?.id ?? 9

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
  const ai = activeIndex(phase)
  const uploadedFileCount = topLevelSourceCount(sources)
  const parsedFileCount = topLevelSourceCount(sources.filter((source) => source.dataUrl || source.text))
  const competitorFileCount = topLevelSourceCount(sources.filter((source) => /竞品数据|竞品|对标|对手/.test(source.attribution ?? '')))
  const derivedCount = derivedSourceCount(sources)

  const analysisTasks = SOP_STEPS.map((step) => ({
    id: step.id,
    confirm: step.confirm,
    title: ANALYSIS_COPY[step.id]?.title ?? step.title,
    desc: ANALYSIS_COPY[step.id]?.desc ?? ''
  }))
  const isTaskDone = (id: number): boolean => {
    if (id === REPORT_STEP_ID) return Boolean(artifacts[id]) || phase === 'checkpoint2' || phase === 'done'
    return Boolean(artifacts[id])
  }
  const doneCount = analysisTasks.filter((task) => isTaskDone(task.id)).length
  const firstPending = analysisTasks.find((task) => !isTaskDone(task.id))

  const getTaskStatus = (id: number): TaskStatus => {
    if (isTaskDone(id)) return 'done'
    if (phase === 'analyzing') {
      if (id === firstPending?.id) return 'active'
      if (id === REPORT_STEP_ID && reportMarkdown) return 'active'
    }
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
              <b>9 项自动分析</b>
              <span>{phase === 'analyzing' ? '系统正在逐项处理' : '确认资料后自动完成'}</span>
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
                  <span className="analysis-task-status">{taskLabel(status)}</span>
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
            <div className="health-row strong">
              <span>正在清洗</span>
              <b>
                {cleaningProgress.done}/{cleaningProgress.total}
              </b>
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
          只需确认两次：资料整理完成后一次、报告初稿完成后一次。过程中可随时补充要求。
        </div>
      </div>
    </div>
  )
}
