import { useEffect, useState } from 'react'
import { buildProjectSnapshot, useStore } from './store'
import PhaseTracker from './components/PhaseTracker'
import ConversationPanel from './components/ConversationPanel'
import ReportPreview from './components/ReportPreview'
import SettingsModal from './components/SettingsModal'

const SOP_GUIDE_URL = 'https://my.feishu.cn/docx/FU5FdRkHFoNH7JxUp6wciLksnEe'

function openExternalLink(url: string): void {
  const api = window.api as typeof window.api & { openExternal?: (targetUrl: string) => Promise<void> }
  if (typeof api.openExternal === 'function') {
    void api.openExternal(url).catch(() => {
      window.open(url, '_blank', 'noopener,noreferrer')
    })
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

function ProductLogo(): JSX.Element {
  return (
    <svg className="product-logo" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="logo-blue" x1="8" y1="6" x2="34" y2="42" gradientUnits="userSpaceOnUse">
          <stop stopColor="#38BDF8" />
          <stop offset="1" stopColor="#2563EB" />
        </linearGradient>
        <linearGradient id="logo-green" x1="18" y1="12" x2="42" y2="38" gradientUnits="userSpaceOnUse">
          <stop stopColor="#22C55E" />
          <stop offset="1" stopColor="#14B8A6" />
        </linearGradient>
      </defs>
      <path
        d="M24 4 7 13.5v21L17 40V19l7-4 7 4v6.5l-9 5.1V42l19-10.8V13.5L24 4Z"
        fill="url(#logo-blue)"
      />
      <path d="M24 14.8 17 19v21l7 4V27.2l14-8-7-4.1-7 4.1v-4.4Z" fill="url(#logo-green)" />
      <path d="M24 4 41 13.5l-10 5.7L24 15 17 19 7 13.5 24 4Z" fill="#7DD3FC" opacity="0.9" />
      <path d="M24 27.2 41 36.8 31 42.5 24 38.5v-11.3Z" fill="#1D4ED8" opacity="0.92" />
    </svg>
  )
}

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
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth || 1280)
  const needsPrivacyConsent = Boolean(settings && !settings.privacyAccepted)

  useEffect(() => {
    const onResize = (): void => setWindowWidth(window.innerWidth || 1280)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

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

  const compactLayout = windowWidth < 1240
  const leftColumn = Math.max(180, Math.min(columns.left, compactLayout ? 220 : 420))
  const rightColumn = Math.max(340, Math.min(columns.right, compactLayout ? 360 : 620))
  const middleMin = compactLayout ? 340 : 520
  const paneTemplate = `${leftColumn}px 6px minmax(${middleMin}px, 1fr) 6px minmax(340px, ${rightColumn}px)`

  return (
    <div className="app app-workbench">
      <div className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-label="产品经营报告 Logo">
            <ProductLogo />
          </span>
          <span className="brand-copy">
            <span className="brand-main">产品经营报告</span>
            <span className="sub">专业的产品经营分析与报告系统</span>
          </span>
        </div>
        <a
          className="tutorial-link"
          href={SOP_GUIDE_URL}
          target="_blank"
          rel="noreferrer"
          aria-label="打开使用教程 SOP 文档"
          onClick={(event) => {
            event.preventDefault()
            openExternalLink(SOP_GUIDE_URL)
          }}
        >
          <span className="tutorial-icon" aria-hidden="true">
            <svg viewBox="0 0 20 20" focusable="false">
              <path d="M5.4 2.5h6.1l3.1 3.1v11.9H5.4V2.5Z" />
              <path d="M11.5 2.8v3h3" />
              <path d="M7.5 9h5M7.5 12h5M7.5 15h3" />
            </svg>
          </span>
          <span className="tutorial-copy">
            <span className="tutorial-title">使用教程</span>
            <span className="tutorial-subtitle">SOP 文档</span>
          </span>
          <span className="tutorial-external" aria-hidden="true">
            <svg viewBox="0 0 16 16" focusable="false">
              <path d="M6 4h6v6" />
              <path d="M12 4 5 11" />
            </svg>
          </span>
        </a>
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
        style={{ gridTemplateColumns: paneTemplate }}
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
