import { useEffect, useState } from 'react'
import { buildProjectSnapshot, useStore } from './store'
import PhaseTracker from './components/PhaseTracker'
import ConversationPanel from './components/ConversationPanel'
import ReportPreview from './components/ReportPreview'
import SettingsModal from './components/SettingsModal'

export default function App(): JSX.Element {
  const init = useStore((s) => s.init)
  const settings = useStore((s) => s.settings)
  const phase = useStore((s) => s.phase)
  const sources = useStore((s) => s.sources)
  const messages = useStore((s) => s.messages)
  const cleanedData = useStore((s) => s.cleanedData)
  const cleanDetails = useStore((s) => s.cleanDetails)
  const artifacts = useStore((s) => s.artifacts)
  const reportMarkdown = useStore((s) => s.reportMarkdown)
  const steering = useStore((s) => s.steering)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const saveSettings = useStore((s) => s.saveSettings)
  const [privacySaving, setPrivacySaving] = useState(false)
  const [privacyError, setPrivacyError] = useState('')

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    if (!settings) return
    const handle = window.setTimeout(() => {
      void window.api.saveLastProject(
        buildProjectSnapshot({
          sources,
          messages,
          cleanedData,
          cleanDetails,
          artifacts,
          reportMarkdown,
          phase,
          steering
        })
      )
    }, 800)
    return () => window.clearTimeout(handle)
  }, [settings, sources, messages, cleanedData, cleanDetails, artifacts, reportMarkdown, phase, steering])

  const active =
    settings?.profiles.find((p) => p.id === settings.activeProfileId) ?? settings?.profiles[0]

  const [columns, setColumns] = useState({ left: 240, right: 380 })
  const needsPrivacyConsent = Boolean(settings && !settings.privacyAccepted)

  const acceptPrivacy = async (): Promise<void> => {
    if (!settings || privacySaving) return
    setPrivacySaving(true)
    setPrivacyError('')
    try {
      await saveSettings({ ...settings, privacyAccepted: true })
    } catch (error) {
      setPrivacyError(error instanceof Error ? error.message : '保存确认状态失败，请重试')
    } finally {
      setPrivacySaving(false)
    }
  }

  const startResize = (side: 'left' | 'right', startX: number): void => {
    const start = { ...columns }
    const onMove = (event: MouseEvent): void => {
      const delta = event.clientX - startX
      setColumns((current) => {
        const width = window.innerWidth || 1280
        if (side === 'left') {
          const left = Math.min(420, Math.max(180, start.left + delta))
          return { ...current, left }
        }
        const right = Math.min(620, Math.max(280, start.right - delta))
        const maxRight = Math.max(280, width - current.left - 420)
        return { ...current, right: Math.min(right, maxRight) }
      })
    }
    const onUp = (): void => {
      document.body.classList.remove('resizing')
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    document.body.classList.add('resizing')
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div className="app app-workbench">
      <div className="topbar">
        <div className="brand">
          <span className="brand-mark">经营报</span>
          <span className="brand-main">AI 经营研究室</span>
          <span className="sub">上传资料 → 经营分析 → 报告交付</span>
        </div>
        <div className="right">
          <span className="model-pill">
            {active ? `模型：${active.name}（${active.model}）` : '未配置模型'}
          </span>
          <button className="btn" onClick={() => setSettingsOpen(true)}>
            ⚙ 设置
          </button>
        </div>
      </div>

      <div
        className="panes"
        style={{ gridTemplateColumns: `${columns.left}px 6px minmax(520px, 1fr) 6px ${columns.right}px` }}
      >
        <PhaseTracker />
        <div
          className="pane-resizer"
          role="separator"
          aria-label="调整资料栏宽度"
          onMouseDown={(event) => startResize('left', event.clientX)}
        />
        <ConversationPanel />
        <div
          className="pane-resizer"
          role="separator"
          aria-label="调整报告栏宽度"
          onMouseDown={(event) => startResize('right', event.clientX)}
        />
        <ReportPreview />
      </div>

      <SettingsModal />

      {needsPrivacyConsent && (
        <div className="privacy-mask" role="dialog" aria-modal="true" aria-labelledby="privacy-title">
          <div className="privacy-card">
            <div className="privacy-kicker">首次使用确认</div>
            <h2 id="privacy-title">上传资料会发送到当前配置的 AI 模型服务商</h2>
            <p>
              本工具会读取你上传的自有数据、竞品数据、截图、表格、PDF 等资料，并把用于分析的文本或图片发送给当前模型接口处理。
              请确认你有权使用这些资料，并已了解相关商业数据会进入你配置的 AI 服务。
            </p>
            <div className="privacy-endpoint">
              <span>当前模型服务</span>
              <b>{active ? `${active.name} · ${active.baseURL}` : '尚未配置，稍后将在设置中选择模型服务'}</b>
            </div>
            <ul className="privacy-list">
              <li>软件会尽量在本机保存配置，但 AI 分析需要调用你配置的模型接口。</li>
              <li>如果资料包含客户隐私、合同、价格政策等敏感信息，请先确认是否允许上传分析。</li>
              <li>你可以在设置中更换模型服务商或 API Key。</li>
            </ul>
            {privacyError && <div className="privacy-error">{privacyError}</div>}
            <div className="privacy-actions">
              <button className="btn" onClick={() => setSettingsOpen(true)}>
                先去设置模型
              </button>
              <button className="btn primary" disabled={privacySaving} onClick={() => void acceptPrivacy()}>
                {privacySaving ? '保存中…' : '我已知晓，继续使用'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
