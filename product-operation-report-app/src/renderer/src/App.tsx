import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import type { ActivationStatus } from '../../shared/types'
import { buildProjectSnapshot, useStore } from './store'
import PhaseTracker from './components/PhaseTracker'
import ConversationPanel from './components/ConversationPanel'
import ReportPreview from './components/ReportPreview'
import SettingsModal from './components/SettingsModal'

const SOP_GUIDE_URL =
  'https://my.feishu.cn/docx/BTSjddkiXo2IGKxiDCJcTM1qnCe?from=from_copylink'

function friendlyUiError(value: unknown, fallback: string): string {
  const raw = (value instanceof Error ? value.message : String(value || '')).replace(/\s+/g, ' ').trim()
  if (!raw) return fallback
  if (/ENOSPC|no space|磁盘.*满/i.test(raw)) return '磁盘空间不足，请清理空间后重试。'
  if (/EACCES|EPERM|permission|access denied|权限/i.test(raw)) {
    return '没有写入权限，请关闭占用文件的软件，或换一个可保存的位置后重试。'
  }
  if (/fetch failed|ECONN|ENOTFOUND|network|网络/i.test(raw)) return '网络连接失败，请检查网络后重试。'
  return raw.length <= 160 && !/[{}<>]/.test(raw) ? raw : fallback
}

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
  const initialized = useStore((s) => s.initialized)
  const persistencePaused = useStore((s) => s.persistencePaused)
  const projectRevision = useStore((s) => s.projectRevision)
  const settings = useStore((s) => s.settings)
  const phase = useStore((s) => s.phase)
  const sources = useStore((s) => s.sources)
  const messages = useStore((s) => s.messages)
  const cleanedData = useStore((s) => s.cleanedData)
  const cleanDetails = useStore((s) => s.cleanDetails)
  const artifacts = useStore((s) => s.artifacts)
  const reportMarkdown = useStore((s) => s.reportMarkdown)
  const reportStale = useStore((s) => s.reportStale)
  const steering = useStore((s) => s.steering)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const saveSettings = useStore((s) => s.saveSettings)
  const resetAnalysis = useStore((s) => s.resetAnalysis)
  const restorePreviousAnalysis = useStore((s) => s.restorePreviousAnalysis)
  const previousProjectAvailable = useStore((s) => s.previousProjectAvailable)
  const [activationStatus, setActivationStatus] = useState<ActivationStatus | null>(null)
  const [activationCode, setActivationCode] = useState('')
  const [activationError, setActivationError] = useState('')
  const [activationBusy, setActivationBusy] = useState(false)
  const [privacySaving, setPrivacySaving] = useState(false)
  const [privacyError, setPrivacyError] = useState('')
  const [newAnalysisState, setNewAnalysisState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [newAnalysisError, setNewAnalysisError] = useState('')
  const [restoreBusy, setRestoreBusy] = useState(false)
  const [activationLoadError, setActivationLoadError] = useState('')
  const [initError, setInitError] = useState('')
  const [autosaveError, setAutosaveError] = useState('')
  const [appVersion, setAppVersion] = useState('')
  const autosaveAttempt = useRef(0)
  const reportForEmergencyCache =
    phase === 'cleaning' || phase === 'analyzing' ? artifacts[9] || '' : reportMarkdown

  const checkActivation = async (): Promise<void> => {
    setActivationLoadError('')
    try {
      setActivationStatus(await window.api.getActivationStatus())
    } catch (error) {
      setActivationLoadError(friendlyUiError(error, '读取激活状态失败，请重试。'))
    }
  }

  useEffect(() => {
    void window.api.getAppVersion().then(setAppVersion).catch(() => undefined)
  }, [])

  useEffect(() => {
    let alive = true
    void window.api
      .getActivationStatus()
      .then((status) => {
        if (alive) setActivationStatus(status)
      })
      .catch((error: unknown) => {
        if (alive) setActivationLoadError(friendlyUiError(error, '读取激活状态失败，请重试。'))
      })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (!activationStatus?.activated || initialized) return
    setInitError('')
    void init().catch((error: unknown) => {
      setInitError(friendlyUiError(error, '初始化软件失败，请重试。'))
    })
  }, [activationStatus?.activated, init, initialized])

  useEffect(() => {
    if (!initialized || !settings || persistencePaused) return
    const handle = window.setTimeout(() => {
      const attempt = ++autosaveAttempt.current
      void window.api
        .saveLastProject(
          buildProjectSnapshot({
            projectRevision,
            sources,
            messages,
            cleanedData,
            cleanDetails,
            artifacts,
            reportMarkdown,
            reportStale,
            phase,
            steering
          })
        )
        .then(() => {
          if (autosaveAttempt.current === attempt) setAutosaveError('')
        })
        .catch((error: unknown) => {
          if (autosaveAttempt.current === attempt) {
            setAutosaveError(friendlyUiError(error, '自动保存失败，请检查磁盘空间后重试。'))
          }
        })
    }, 100)
    return () => window.clearTimeout(handle)
  }, [initialized, persistencePaused, settings, projectRevision, sources, messages, cleanedData, cleanDetails, artifacts, reportMarkdown, reportStale, phase, steering])

  useLayoutEffect(() => {
    if (!initialized || persistencePaused) return
    window.api.cacheProjectSnapshot(
      buildProjectSnapshot({
        projectRevision,
        sources,
        messages,
        cleanedData,
        cleanDetails,
        artifacts,
        reportMarkdown: reportForEmergencyCache,
        reportStale,
        phase,
        steering
      })
    )
  }, [initialized, persistencePaused, projectRevision, sources, messages, cleanedData, cleanDetails, artifacts, reportForEmergencyCache, reportStale, phase, steering])

  useEffect(() => {
    if (!initialized) return
    return window.api.onBeforeClose(async () => {
      const state = useStore.getState()
      await window.api.saveLastProject(buildProjectSnapshot(state))
    })
  }, [initialized])

  useEffect(() => {
    if (newAnalysisState !== 'success' && newAnalysisState !== 'error') return
    const handle = window.setTimeout(() => {
      setNewAnalysisState('idle')
      setNewAnalysisError('')
    }, 2600)
    return () => window.clearTimeout(handle)
  }, [newAnalysisState])

  const active =
    settings?.profiles.find((p) => p.id === settings.activeProfileId) ?? settings?.profiles[0]
  const managed = settings?.managedModel?.enabled ? settings.managedModel : undefined

  const [columns, setColumns] = useState({ left: 240, right: 380 })
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth || 1280)
  const activeEndpoint = managed?.baseURL.trim().replace(/\/+$/, '') || active?.baseURL.trim().replace(/\/+$/, '') || ''
  const modelConfigured = Boolean(managed?.configured || active)
  const needsPrivacyConsent = Boolean(
    settings && modelConfigured && (!settings.privacyAccepted || settings.privacyEndpoint !== activeEndpoint)
  )

  useEffect(() => {
    const elements = Array.from(document.querySelectorAll<HTMLElement>('.topbar, .panes'))
    for (const element of elements) {
      if (needsPrivacyConsent) element.setAttribute('inert', '')
      else element.removeAttribute('inert')
    }
    return () => elements.forEach((element) => element.removeAttribute('inert'))
  }, [needsPrivacyConsent])

  const analysisBusy = phase === 'cleaning' || phase === 'analyzing'
  const hasAnalysis = Boolean(
    sources.length ||
      messages.length ||
      cleanedData ||
      cleanDetails.length ||
      Object.keys(artifacts).length ||
      reportMarkdown ||
      steering
  )

  const newAnalysisButtonLabel =
    newAnalysisState === 'loading'
      ? '正在新建…'
      : newAnalysisState === 'success'
        ? '已新建'
        : newAnalysisState === 'error'
          ? '新建失败'
          : '新建分析'

  const newAnalysisButtonTitle = analysisBusy
    ? '当前分析正在进行，请先等待完成或停止任务'
    : !hasAnalysis
      ? '当前已经是一份空白分析'
      : '清空当前资料、对话和报告，开始一份新的分析'

  const handleNewAnalysis = async (): Promise<void> => {
    if (!hasAnalysis || analysisBusy || newAnalysisState === 'loading') return
    const confirmed = window.confirm(
      '新建分析会清空当前资料、对话和报告。软件会保留上一份，您可以随时点“恢复上一份”。\n\n模型设置和激活状态不会改变。确定新建吗？'
    )
    if (!confirmed) return

    setNewAnalysisState('loading')
    setNewAnalysisError('')
    try {
      await resetAnalysis()
      setNewAnalysisState('success')
    } catch (error) {
      setNewAnalysisState('error')
      setNewAnalysisError(
        `新建分析失败，当前内容已保留：${friendlyUiError(error, '请检查磁盘空间后重试。')}`
      )
    }
  }

  const handleRestorePrevious = async (): Promise<void> => {
    if (hasAnalysis || analysisBusy || restoreBusy) return
    setRestoreBusy(true)
    setNewAnalysisError('')
    try {
      await restorePreviousAnalysis()
    } catch (error) {
      setNewAnalysisState('error')
      setNewAnalysisError(
        `恢复上一份分析失败：${friendlyUiError(error, '请重试。')}`
      )
    } finally {
      setRestoreBusy(false)
    }
  }

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
      await saveSettings({ ...settings, privacyAccepted: true, privacyEndpoint: activeEndpoint })
    } catch (error) {
      setPrivacyError(friendlyUiError(error, '保存确认状态失败，请重试。'))
    } finally {
      setPrivacySaving(false)
    }
  }

  const submitActivation = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (activationBusy) return
    setActivationBusy(true)
    setActivationError('')
    try {
      const result = await window.api.activate(activationCode)
      if (!result.ok) {
        setActivationError(result.message)
      }
      setActivationStatus(result.status)
    } catch (error) {
      setActivationError(friendlyUiError(error, '激活失败，请重试。'))
    } finally {
      setActivationBusy(false)
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

  if (!activationStatus) {
    return (
      <div className="activation-screen">
        <div className="activation-card activation-loading">
          <div className="activation-logo">
            <ProductLogo />
          </div>
          <h1>正在检查激活状态</h1>
          <p>{activationLoadError || '请稍候，正在读取本机授权信息。'}</p>
          {activationLoadError && (
            <button className="btn primary" onClick={() => void checkActivation()}>
              重新检查
            </button>
          )}
        </div>
      </div>
    )
  }

  if (!activationStatus.activated) {
    return (
      <div className="activation-screen">
        <form className="activation-card" onSubmit={(event) => void submitActivation(event)}>
          <div className="activation-logo">
            <ProductLogo />
          </div>
          <div className="activation-kicker">产品经营报告</div>
          <h1>首次使用需要激活</h1>
          <p>请输入管理员发放的激活码。激活成功后，本设备可永久使用。</p>
          <label className="activation-field">
            <span>激活码</span>
            <input
              autoFocus
              value={activationCode}
              onChange={(event) => setActivationCode(event.target.value.toUpperCase())}
              placeholder="POR-XXXX-XXXX-XXXX-XXXX"
              spellCheck={false}
            />
          </label>
          <div className="activation-device">
            <span>当前设备码</span>
            <b>{activationStatus.deviceId.slice(0, 12).toUpperCase()}</b>
          </div>
          <div className="activation-note">如果激活遇到问题，把设备码发给管理员即可。</div>
          {activationError && <div className="activation-error">{activationError}</div>}
          <button className="btn primary activation-submit" disabled={activationBusy}>
            {activationBusy ? '正在激活...' : '激活并进入软件'}
          </button>
          <div className="activation-note">
            激活码不会明文保存在软件包中；本机会保存一份授权记录。
          </div>
        </form>
      </div>
    )
  }

  if (!initialized) {
    return (
      <div className="activation-screen">
        <div className="activation-card activation-loading">
          <div className="activation-logo">
            <ProductLogo />
          </div>
          <h1>{initError ? '软件初始化失败' : '正在恢复上次分析'}</h1>
          <p>{initError || '请稍候，正在安全恢复资料、设置和报告。'}</p>
          {initError && (
            <button
              className="btn primary"
              onClick={() => {
                setInitError('')
                void init().catch((error: unknown) => {
                  setInitError(friendlyUiError(error, '初始化软件失败，请重试。'))
                })
              }}
            >
              重新加载
            </button>
          )}
        </div>
      </div>
    )
  }

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
          aria-label="打开使用教程"
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
            <span className="tutorial-subtitle">新手操作指南</span>
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
            {managed
              ? managed.configured
                ? `内置模型：${managed.model}`
                : '内置模型需要维护'
              : active
                ? `模型：${active.name}（${active.model}）`
                : '未配置模型'}
          </span>
          <button
            className="btn new-analysis-button"
            type="button"
            data-state={newAnalysisState}
            disabled={!hasAnalysis || analysisBusy || newAnalysisState === 'loading'}
            aria-label={newAnalysisButtonLabel}
            title={newAnalysisButtonTitle}
            onClick={() => void handleNewAnalysis()}
          >
            <span className="new-analysis-icon" aria-hidden="true">
              {newAnalysisState === 'loading'
                ? '·'
                : newAnalysisState === 'success'
                  ? '✓'
                  : newAnalysisState === 'error'
                    ? '!'
                    : '＋'}
            </span>
            <span>{newAnalysisButtonLabel}</span>
          </button>
          {previousProjectAvailable && !hasAnalysis && (
            <button
              className="btn restore-analysis-button"
              type="button"
              disabled={analysisBusy || restoreBusy}
              title="把刚才清空的上一份分析恢复回来"
              onClick={() => void handleRestorePrevious()}
            >
              {restoreBusy ? '正在恢复…' : '恢复上一份'}
            </button>
          )}
          {appVersion && <span className="app-version">v{appVersion}</span>}
          <button
            className="btn"
            disabled={analysisBusy}
            title={analysisBusy ? '当前分析完成或停止后才能查看设置' : managed ? '查看内置 AI 服务状态' : '打开模型设置'}
            onClick={() => setSettingsOpen(true)}
          >
            ⚙ {managed ? '服务状态' : '设置'}
          </button>
        </div>
      </div>

      {(newAnalysisError || autosaveError) && (
        <div className="app-alert-stack">
          {newAnalysisError && (
            <div className="new-analysis-error" role="alert">
              {newAnalysisError}
            </div>
          )}
          {autosaveError && (
            <div className="new-analysis-error" role="alert">
              自动保存失败，当前内容可能尚未写入磁盘：{autosaveError}
            </div>
          )}
        </div>
      )}

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
            <h2 id="privacy-title">上传资料会发送到{managed ? '软件内置的' : '当前配置的'} AI 模型服务</h2>
            <p>
              本工具会读取你上传的自有数据、竞品数据、截图、表格、PDF 等资料，并把用于分析的文本或图片发送给当前模型接口处理。
              请确认你有权使用这些资料，并已了解相关商业数据会进入{managed ? '软件内置的' : '你配置的'} AI 服务。
            </p>
            <div className="privacy-endpoint">
              <span>当前模型服务</span>
              <b>
                {managed
                  ? managed.configured
                    ? `${managed.name} · ${managed.model}`
                    : '内置服务配置异常，请联系软件管理员'
                  : active
                    ? `${active.name} · ${active.baseURL}`
                    : '尚未配置，稍后将在设置中选择模型服务'}
              </b>
            </div>
            <ul className="privacy-list">
              <li>AI 分析需要联网调用{managed ? '软件内置的模型服务' : '你配置的模型接口'}。</li>
              <li>如果资料包含客户隐私、合同、价格政策等敏感信息，请先确认是否允许上传分析。</li>
              <li>{managed ? '模型授权由软件统一管理，你不需要填写或保存 API Key。' : '你可以在设置中更换模型服务商或 API Key。'}</li>
            </ul>
            {privacyError && <div className="privacy-error">{privacyError}</div>}
            <div className="privacy-actions">
              {!managed?.configured && (
                <button className="btn" onClick={() => setSettingsOpen(true)}>
                  {managed ? '查看服务状态' : '先去设置模型'}
                </button>
              )}
              <button
                className="btn primary"
                disabled={privacySaving || !modelConfigured}
                title={modelConfigured ? '' : managed ? '内置模型服务暂不可用' : '请先完成模型设置'}
                onClick={() => void acceptPrivacy()}
              >
                {privacySaving ? '保存中…' : modelConfigured ? '我已知晓，继续使用' : managed ? '服务暂不可用' : '请先设置模型'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
