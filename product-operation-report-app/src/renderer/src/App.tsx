import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { ActivationStatus, PointsWalletStatus, UpdateDownloadProgress, UpdateInfo } from '../../shared/types'
import { buildProjectSnapshot, useStore } from './store'
import PhaseTracker from './components/PhaseTracker'
import ConversationPanel from './components/ConversationPanel'
import ReportPreview from './components/ReportPreview'
import SettingsModal from './components/SettingsModal'
import ReportReuseModal from './components/ReportReuseModal'
import ContactAuthor from './components/ContactAuthor'

const SOP_GUIDE_URL =
  'https://my.feishu.cn/docx/BTSjddkiXo2IGKxiDCJcTM1qnCe?from=from_copylink'
const AUTHORIZATION_REFRESH_INTERVAL_MS = 60_000

function friendlyUiError(value: unknown, fallback: string): string {
  const raw = (value instanceof Error ? value.message : String(value || ''))
    .replace(/^Error invoking remote method '[^']+':\s*Error:\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!raw) return fallback
  if (/更新配置签名无效|update.*signature|signature.*invalid/i.test(raw)) {
    return '更新信息暂时无法验证，已为你停止本次更新。当前版本可以继续正常使用，请稍后再试。'
  }
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

function formatPoints(value: number): string {
  return Number.isInteger(value) ? value.toLocaleString('zh-CN') : value.toLocaleString('zh-CN', { maximumFractionDigits: 3 })
}

function formatLedgerTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
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
  const analysisSessionId = useStore((s) => s.analysisSessionId)
  const settings = useStore((s) => s.settings)
  const phase = useStore((s) => s.phase)
  const sources = useStore((s) => s.sources)
  const messages = useStore((s) => s.messages)
  const cleanedData = useStore((s) => s.cleanedData)
  const cleanDetails = useStore((s) => s.cleanDetails)
  const artifacts = useStore((s) => s.artifacts)
  const taskJournal = useStore((s) => s.taskJournal)
  const reportMarkdown = useStore((s) => s.reportMarkdown)
  const reportStale = useStore((s) => s.reportStale)
  const steering = useStore((s) => s.steering)
  const engineVersion = useStore((s) => s.engineVersion)
  const readOnly = useStore((s) => s.readOnly)
  const legacyNotice = useStore((s) => s.legacyNotice)
  const moduleStates = useStore((s) => s.moduleStates)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const saveSettings = useStore((s) => s.saveSettings)
  const resetAnalysis = useStore((s) => s.resetAnalysis)
  const restorePreviousAnalysis = useStore((s) => s.restorePreviousAnalysis)
  const previousProjectAvailable = useStore((s) => s.previousProjectAvailable)
  const [activationStatus, setActivationStatus] = useState<ActivationStatus | null>(null)
  const [pointsWallet, setPointsWallet] = useState<PointsWalletStatus | null>(null)
  const [activationCode, setActivationCode] = useState('')
  const [activationError, setActivationError] = useState('')
  const [activationActionNotice, setActivationActionNotice] = useState('')
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
  const [licenseEntryOpen, setLicenseEntryOpen] = useState(false)
  const [replacementCode, setReplacementCode] = useState('')
  const [replacementError, setReplacementError] = useState('')
  const [replacementBusy, setReplacementBusy] = useState(false)
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [updateDismissed, setUpdateDismissed] = useState(false)
  const [updateBusy, setUpdateBusy] = useState<'idle' | 'check' | 'download' | 'install'>('idle')
  const [updateProgress, setUpdateProgress] = useState<UpdateDownloadProgress | null>(null)
  const [updateError, setUpdateError] = useState('')
  const [updateCheckNotice, setUpdateCheckNotice] = useState('')
  const autosaveAttempt = useRef(0)
  const activationRefreshInFlight = useRef(false)
  const updateCheckAttempted = useRef(false)
  const checkActivation = async (): Promise<void> => {
    setActivationLoadError('')
    try {
      const status = await window.api.getActivationStatus()
      setActivationStatus(status)
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

  useEffect(() => window.api.onActivationStatusChanged((status) => {
    setActivationStatus(status)
    if (status.activated) {
      setActivationError('')
      setActivationActionNotice('')
    }
  }), [])
  useEffect(() => window.api.onPointsWalletChanged(setPointsWallet), [])

  useEffect(() => {
    // Invalidate a save that started under the previous authorization. A remote
    // unbind can finish while that save is still awaiting the main process; its
    // expected "not activated" rejection must not survive a successful rebind.
    autosaveAttempt.current += 1
    setAutosaveError('')
  }, [activationStatus?.activated, activationStatus?.licenseId])

  useEffect(() => {
    if (activationStatus?.source !== 'server') return
    let disposed = false
    const refreshAuthorization = async (): Promise<void> => {
      if (activationRefreshInFlight.current) return
      activationRefreshInFlight.current = true
      try {
        const status = await window.api.refreshActivationStatus()
        if (!disposed) setActivationStatus(status)
      } catch {
        // The main process retains the last safe status on a network failure.
        // Focus, visibility and interval events will retry without blocking UI.
      } finally {
        activationRefreshInFlight.current = false
      }
    }
    const handleFocus = (): void => {
      void refreshAuthorization()
    }
    const handleVisibilityChange = (): void => {
      if (!document.hidden) void refreshAuthorization()
    }
    void refreshAuthorization()
    const retryTimers = activationStatus.authorizationState === 'offline_grace'
      ? [2_000, 5_000, 15_000].map((delay) => window.setTimeout(() => void refreshAuthorization(), delay))
      : []
    const timer = window.setInterval(handleFocus, AUTHORIZATION_REFRESH_INTERVAL_MS)
    window.addEventListener('focus', handleFocus)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      disposed = true
      retryTimers.forEach((handle) => window.clearTimeout(handle))
      window.clearInterval(timer)
      window.removeEventListener('focus', handleFocus)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [activationStatus?.activated, activationStatus?.source, activationStatus?.licenseId, activationStatus?.bindingStatus, activationStatus?.authorizationState])

  useEffect(() => window.api.onUpdateProgress(setUpdateProgress), [])

  useEffect(() => {
    if (!updateCheckNotice) return
    const handle = window.setTimeout(() => setUpdateCheckNotice(''), 5000)
    return () => window.clearTimeout(handle)
  }, [updateCheckNotice])

  useEffect(() => {
    if (!activationStatus?.activated || initialized) return
    setInitError('')
    void init().catch((error: unknown) => {
      setInitError(friendlyUiError(error, '初始化软件失败，请重试。'))
    })
  }, [activationStatus?.activated, init, initialized])

  useEffect(() => {
    if (!activationStatus?.activated) return
    void window.api.getPointsWallet().then(setPointsWallet).catch(() => undefined)
  }, [activationStatus?.activated, activationStatus?.licenseId])

  useEffect(() => {
    if (!activationStatus?.activated || !initialized || !settings || persistencePaused) return
    const handle = window.setTimeout(() => {
      const attempt = ++autosaveAttempt.current
      void window.api
        .saveLastProject(
          buildProjectSnapshot({
            projectRevision,
            analysisSessionId,
            sources,
            messages,
            cleanedData,
            cleanDetails,
            artifacts,
            taskJournal,
            reportMarkdown,
            reportStale,
            phase,
            steering,
            engineVersion,
            readOnly,
            legacyNotice,
            moduleStates
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
    }, 900)
    return () => window.clearTimeout(handle)
  }, [activationStatus?.activated, activationStatus?.licenseId, initialized, persistencePaused, settings, projectRevision, analysisSessionId, sources, messages, cleanedData, cleanDetails, artifacts, taskJournal, reportMarkdown, reportStale, phase, steering, engineVersion, readOnly, legacyNotice, moduleStates])

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
  const updateVisible = Boolean(updateInfo?.available && !updateDismissed)
  const licenseLabel = activationStatus?.unlimited || pointsWallet?.unlimited
    ? '无限使用'
    : pointsWallet
      ? pointsWallet.balancePoints < 0
      ? `欠费 ${formatPoints(Math.abs(pointsWallet.balancePoints))} 积分`
      : `剩余 ${formatPoints(pointsWallet.balancePoints)} 积分`
    : '积分加载中'

  useEffect(() => {
    if (
      !initialized ||
      !activationStatus?.activated ||
      needsPrivacyConsent ||
      updateCheckAttempted.current
    ) return
    updateCheckAttempted.current = true
    void window.api
      .checkForUpdates()
      .then((info) => {
        if (info.available) {
          setUpdateInfo(info)
          setUpdateDismissed(false)
        }
      })
      .catch(() => undefined)
  }, [activationStatus?.activated, initialized, needsPrivacyConsent])

  useEffect(() => {
    const elements = Array.from(document.querySelectorAll<HTMLElement>('.topbar, .panes'))
    const blocked = needsPrivacyConsent || updateVisible || licenseEntryOpen
    for (const element of elements) {
      if (blocked) element.setAttribute('inert', '')
      else element.removeAttribute('inert')
    }
    return () => elements.forEach((element) => element.removeAttribute('inert'))
  }, [licenseEntryOpen, needsPrivacyConsent, updateVisible])

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
    if (activationStatus?.authorizationState === 'vault_unavailable' || activationStatus?.authorizationState === 'vault_corrupt') {
      setActivationError('系统安全凭据当前不可用，已停止提交，避免覆盖原授权。')
      return
    }
    if (
      activationStatus?.authorizationState === 'merged_main_conflict' &&
      !window.confirm('本机保存的码已经作为积分码合并，不能再次作为主授权。\n\n只有管理员明确补发的新主码才应在这里继续激活。确认这是管理员补发的主码吗？')
    ) return
    setActivationBusy(true)
    setActivationError('')
    setActivationActionNotice('')
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

  const revalidateSavedActivation = async (): Promise<void> => {
    if (activationBusy) return
    if (
      activationStatus?.authorizationState === 'unbound' &&
      !window.confirm('服务器已经解除这台电脑的绑定。\n\n确认重新绑定到这台电脑吗？这会占用一次换机次数。')
    ) return
    if (
      activationStatus?.authorizationState === 'session_expired' &&
      !window.confirm('本机设备会话已过期。\n\n确认继续在这台电脑恢复原授权吗？')
    ) return
    setActivationBusy(true)
    setActivationError('')
    setActivationActionNotice('')
    try {
      const result = await window.api.revalidateSavedActivationCode()
      setActivationStatus(result.status)
      if (!result.ok) setActivationError(result.message)
    } catch (error) {
      setActivationError(friendlyUiError(error, '重新验证失败，请检查网络后重试。'))
    } finally {
      setActivationBusy(false)
    }
  }

  const refreshActivationEntry = async (): Promise<void> => {
    if (activationBusy) return
    setActivationBusy(true)
    setActivationError('')
    setActivationActionNotice('')
    try {
      const status = await window.api.refreshActivationStatus()
      setActivationStatus(status)
      if (!status.activated) setActivationActionNotice('已重新检测授权状态。')
    } catch (error) {
      setActivationError(friendlyUiError(error, '暂时无法检测授权状态，请稍后重试。'))
    } finally {
      setActivationBusy(false)
    }
  }

  const copyActivationDiagnostics = async (): Promise<void> => {
    setActivationError('')
    setActivationActionNotice('')
    try {
      const result = await window.api.copyActivationDiagnostics()
      if (result.ok) setActivationActionNotice(result.message)
      else setActivationError(result.message)
    } catch (error) {
      setActivationError(friendlyUiError(error, '复制诊断信息失败，请重试。'))
    }
  }

  const submitReplacementActivation = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (replacementBusy) return
    if (!window.confirm('确认将这个积分码合并到当前主授权吗？\n\n合并成功后，积分码只能使用一次，当前主激活码不会改变。')) return
    setReplacementBusy(true)
    setReplacementError('')
    try {
      const result = await window.api.redeemPointsCode(replacementCode)
      setActivationStatus(result.activation)
      setPointsWallet(result.wallet)
      if (result.ok) {
        setReplacementCode('')
        setLicenseEntryOpen(false)
      } else {
        setReplacementError(result.message)
      }
    } catch (error) {
      setReplacementError(friendlyUiError(error, '充值失败，请检查网络后重试。'))
    } finally {
      setReplacementBusy(false)
    }
  }

  const handleApplyUpdate = async (): Promise<void> => {
    if (updateBusy !== 'idle') return
    setUpdateError('')
    try {
      if (!updateInfo?.downloaded) {
        setUpdateBusy('download')
        setUpdateProgress({ receivedBytes: 0, percent: 0 })
        const download = await window.api.downloadUpdate()
        if (download.info) setUpdateInfo(download.info)
        if (!download.ok) {
          setUpdateError(download.message)
          return
        }
      }
      setUpdateBusy('install')
      const install = await window.api.installUpdate()
      if (install.info) setUpdateInfo(install.info)
      if (!install.ok) setUpdateError(install.message)
    } catch (error) {
      setUpdateError(friendlyUiError(error, '更新失败，当前版本仍可继续使用，请稍后重试。'))
    } finally {
      setUpdateBusy('idle')
    }
  }

  const handleCheckForUpdates = async (): Promise<void> => {
    if (updateBusy !== 'idle') return
    setUpdateBusy('check')
    setUpdateError('')
    setUpdateCheckNotice('')
    try {
      const info = await window.api.checkForUpdates()
      setUpdateInfo(info)
      if (info.available) {
        setUpdateDismissed(false)
      } else {
        setUpdateCheckNotice(`当前已经是最新版本 v${info.currentVersion}`)
      }
    } catch (error) {
      setUpdateCheckNotice(friendlyUiError(error, '暂时无法检查更新，请稍后重试。'))
    } finally {
      setUpdateBusy('idle')
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
          <h1>正在恢复原授权</h1>
          <p>{activationLoadError || '请稍候，正在读取本机安全凭据并向服务器确认。'}</p>
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
          <div className="activation-kicker">产品与内容经营报告系统</div>
          <h1>{activationStatus.authorizationState === 'unbound'
            ? '这台电脑已解除绑定'
            : activationStatus.authorizationState === 'merged_main_conflict'
              ? '未找到可用的原主授权'
            : activationStatus.authorizationState === 'session_expired'
              ? '确认恢复本机授权'
              : activationStatus.authorizationState === 'vault_unavailable'
                ? '系统凭据暂时不可读取'
                : activationStatus.authorizationState === 'vault_corrupt'
                  ? '本机授权文件需要处理'
                  : activationStatus.activationCodeAvailable
                    ? '重新验证授权'
                    : '首次使用需要激活'}</h1>
          <p>
            {activationStatus.authorizationState === 'unbound'
              ? '服务器已停止这台电脑的原授权。只有你明确确认后，软件才会使用已保存的原激活码重新绑定。'
              : activationStatus.authorizationState === 'merged_main_conflict'
                ? '软件已经检查本机保存的历史授权，但服务器没有认可其中任何一张为当前主码。请只输入管理员补发的主激活码；积分充值码需要进入软件后使用。'
              : activationStatus.authorizationState === 'session_expired'
                ? '原激活码和设备凭证仍安全保存在本机，无需重新输入；确认后即可恢复。'
                : activationStatus.authorizationState === 'vault_unavailable'
                  ? '请允许 Windows 凭据或 macOS 钥匙串访问，然后点击重新检测。软件不会覆盖原授权文件。'
                  : activationStatus.authorizationState === 'vault_corrupt'
                    ? '软件已保留原加密文件，没有生成新的设备码。请复制诊断信息发给管理员。'
                    : activationStatus.activationCodeAvailable
                      ? '本机已安全保存原激活码，可以直接重新验证。积分充值码请在进入软件后使用。'
                      : '请输入管理员发放的主激活码。首次成功后会绑定当前电脑。'}
          </p>
          {activationStatus.activationCodeAvailable &&
            activationStatus.authorizationState !== 'disabled' &&
            activationStatus.authorizationState !== 'expired' &&
            activationStatus.authorizationState !== 'machine_mismatch' &&
            activationStatus.authorizationState !== 'credential_revoked' &&
            activationStatus.authorizationState !== 'merged_main_conflict' &&
            activationStatus.authorizationState !== 'vault_unavailable' &&
            activationStatus.authorizationState !== 'vault_corrupt' && (
            <button
              type="button"
              className="btn activation-saved-code"
              onClick={() => void revalidateSavedActivation()}
              disabled={activationBusy}
            >
              {activationStatus.authorizationState === 'unbound'
                ? '重新绑定这台电脑'
                : activationStatus.authorizationState === 'session_expired'
                  ? '一键恢复本机授权'
                  : '使用已保存的原激活码'}
              {activationStatus.maskedActivationCode ? `（${activationStatus.maskedActivationCode}）` : ''}
            </button>
          )}
          <label className="activation-field">
            <span>激活码</span>
            <input
              autoFocus
              value={activationCode}
              onChange={(event) => {
                setActivationCode(event.target.value.toUpperCase())
                setActivationError('')
              }}
              placeholder="POR-XXXX-XXXX-XXXX-XXXX"
              spellCheck={false}
              disabled={activationBusy || activationStatus.authorizationState === 'vault_unavailable' || activationStatus.authorizationState === 'vault_corrupt'}
            />
          </label>
          <div className="activation-device">
            <div className="activation-device-info">
              <span>当前设备码</span>
              <b>{activationStatus.deviceId.slice(0, 12).toUpperCase()}</b>
            </div>
            <button type="button" className="activation-device-copy" onClick={() => void copyActivationDiagnostics()}>
              复制诊断信息
            </button>
          </div>
          <div className="activation-entry-actions">
            <button type="button" onClick={() => void refreshActivationEntry()} disabled={activationBusy}>
              重新检测授权状态
            </button>
          </div>
          <div className="activation-note">如果激活遇到问题，复制诊断信息发给管理员即可。</div>
          {activationStatus.message && !activationError && !activationActionNotice && (
            <div className="activation-notice" role="status">{activationStatus.message}</div>
          )}
          {activationActionNotice && !activationError && (
            <div className="activation-notice" role="status">{activationActionNotice}</div>
          )}
          {activationError && <div className="activation-error">{activationError}</div>}
          <button
            className="btn primary activation-submit"
            disabled={activationBusy || activationStatus.authorizationState === 'vault_unavailable' || activationStatus.authorizationState === 'vault_corrupt'}
          >
            {activationBusy ? '正在激活...' : '激活并进入软件'}
          </button>
          <div className="activation-note">
            本地只保存加密授权记录，不保存服务器密钥或 API Key。
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
          <span className="brand-mark" aria-label="产品与内容经营报告系统 Logo">
            <ProductLogo />
          </span>
          <span className="brand-copy">
            <span className="brand-main">产品与内容经营报告系统</span>
            <span className="sub">专业的产品经营与内容分析报告系统</span>
          </span>
        </div>
        <ContactAuthor />
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
          <button
            className={`license-pill${activationStatus.offline ? ' offline' : ''}${!activationStatus.unlimited && (pointsWallet?.balancePoints ?? 0) <= 0 ? ' empty' : ''}`}
            type="button"
            title={activationStatus.message || '查看积分余额或输入充值码'}
            onClick={() => {
              setReplacementError('')
              setLicenseEntryOpen(true)
            }}
          >
            {licenseLabel}{activationStatus.requiresRevalidation ? ' · 待验证' : ''}
          </button>
          {appVersion && (
            <button
              className={`app-version update-check-button${updateInfo?.available ? ' available' : ''}${updateInfo?.downloaded ? ' downloaded' : ''}`}
              type="button"
              disabled={updateBusy !== 'idle'}
              title={updateInfo?.downloaded
                ? '更新包已经下载完成，点击开始安装'
                : updateInfo?.available
                  ? '有新版本，点击查看更新说明'
                  : '手动检查是否有新版本'}
              onClick={() => void handleCheckForUpdates()}
            >
              {updateBusy === 'check'
                ? '正在检查…'
                : updateInfo?.downloaded
                  ? '安装更新'
                  : updateInfo?.available
                    ? `新版本 v${updateInfo.latestVersion}`
                    : `v${appVersion} · 检查更新`}
            </button>
          )}
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

      {(newAnalysisError || autosaveError || updateCheckNotice || activationStatus.offline) && (
        <div className="app-alert-stack">
          {activationStatus.offline && (
            <div className={`authorization-offline-notice${activationStatus.requiresRevalidation ? ' blocked' : ''}`} role="status">
              {activationStatus.requiresRevalidation
                ? '授权服务器暂时无法连接，离线宽限期已结束。历史报告仍可查看和导出。'
                : '当前离线，软件会稍后自动重连。授权仍在72小时宽限期内，可以继续使用。'}
            </div>
          )}
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
          {updateCheckNotice && (
            <div className="update-check-notice" role="status">
              {updateCheckNotice}
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
      <ReportReuseModal />

      {licenseEntryOpen && (
        <div className="privacy-mask" role="dialog" aria-modal="true" aria-labelledby="license-entry-title">
          <form className="privacy-card license-entry-card" onSubmit={(event) => void submitReplacementActivation(event)}>
            <div className="privacy-kicker">积分余额</div>
            <h2 id="license-entry-title">
              {activationStatus.unlimited ? '无限使用' : `剩余 ${formatPoints(pointsWallet?.balancePoints ?? 0)} 积分`}
            </h2>
            <p>如需充值，请输入管理员发放的积分码。</p>
            {pointsWallet?.stale && (
              <div className="points-wallet-stale" role="status">
                余额可能不是最新，网络恢复后会自动刷新。
              </div>
            )}
            <div className="points-ledger-preview" aria-label="最近积分记录">
              <strong>最近积分记录</strong>
              {pointsWallet?.ledger.length
                ? pointsWallet.ledger.slice(0, 8).map((entry) => (
                    <div key={entry.id}>
                      <span>
                        <small>{formatLedgerTime(entry.createdAt)}</small>
                        {entry.description}
                      </span>
                      <b className={entry.pointsDelta >= 0 ? 'positive' : 'negative'}>
                        {entry.pointsDelta >= 0 ? '+' : ''}{formatPoints(entry.pointsDelta)}
                      </b>
                    </div>
                  ))
                : <span className="points-ledger-empty">暂无积分变动记录</span>}
            </div>
            <label className="activation-field">
              <span>积分充值码</span>
              <input
                autoFocus
                value={replacementCode}
                onChange={(event) => setReplacementCode(event.target.value.toUpperCase())}
                placeholder="请输入管理员发放的积分码"
                spellCheck={false}
              />
            </label>
            {replacementError && <div className="privacy-error">{replacementError}</div>}
            <div className="privacy-actions">
              <button
                className="btn"
                type="button"
                disabled={replacementBusy}
                onClick={() => {
                  setLicenseEntryOpen(false)
                  setReplacementError('')
                }}
              >
                取消
              </button>
              <button className="btn primary" disabled={replacementBusy || !replacementCode.trim()}>
                {replacementBusy ? '正在充值…' : '充值积分'}
              </button>
            </div>
          </form>
        </div>
      )}

      {updateVisible && updateInfo && (
        <div className="privacy-mask update-mask" role="dialog" aria-modal="true" aria-labelledby="update-title">
          <div className="privacy-card update-card">
            <div className="update-heading">
              <div>
                <div className="privacy-kicker">{updateInfo.force ? '必须更新' : '发现新版本'}</div>
                <h2 id="update-title">产品与内容经营报告系统 {updateInfo.latestVersion}</h2>
              </div>
              <span className={`update-badge${updateInfo.force ? ' force' : ''}`}>
                {updateInfo.force ? '更新后才能继续' : '可稍后更新'}
              </span>
            </div>
            <div className="update-versions">
              <div><span>当前版本</span><b>v{updateInfo.currentVersion}</b></div>
              <div className="update-arrow" aria-hidden="true">→</div>
              <div><span>最新版本</span><b>v{updateInfo.latestVersion}</b></div>
            </div>
            <div className="update-notes">
              <strong>本次更新</strong>
              {updateInfo.notes.length ? (
                <ul>{updateInfo.notes.map((note, index) => <li key={`${index}-${note}`}>{note}</li>)}</ul>
              ) : (
                <p>修复问题并提升使用体验。</p>
              )}
            </div>
            {updateBusy === 'download' && (
              <div className="update-progress" aria-live="polite">
                <div><span>正在下载更新包</span><b>{updateProgress?.percent === undefined ? '请稍候' : `${updateProgress.percent}%`}</b></div>
                <progress max={100} value={updateProgress?.percent ?? undefined} />
              </div>
            )}
            {updateError && <div className="privacy-error">{updateError}</div>}
            <div className="privacy-actions update-actions">
              {!updateInfo.force && (
                <button
                  className="btn"
                  type="button"
                  disabled={updateBusy !== 'idle'}
                  onClick={() => setUpdateDismissed(true)}
                >
                  稍后更新
                </button>
              )}
              <button className="btn primary" disabled={updateBusy !== 'idle'} onClick={() => void handleApplyUpdate()}>
                {updateBusy === 'download'
                  ? '正在下载…'
                  : updateBusy === 'install'
                    ? '正在启动安装…'
                    : updateError
                      ? '重新更新'
                      : '立即更新'}
              </button>
            </div>
            <div className="update-safety-note">点击后会自动下载并校验安装包，校验通过才会启动安装。</div>
          </div>
        </div>
      )}

      {needsPrivacyConsent && (
        <div className="privacy-mask" role="dialog" aria-modal="true" aria-labelledby="privacy-title">
          <div className="privacy-card">
            <div className="privacy-kicker">首次使用确认</div>
            <h2 id="privacy-title">上传资料会发送到 AI 分析服务</h2>
            <p>
              本工具会读取你上传的自有数据、竞品数据、截图、表格、PDF 等资料，并把用于分析的文本或图片发送给 AI 分析服务处理。
              请确认你有权使用这些资料，并已了解相关商业数据会进入 AI 分析服务。
            </p>
            <div className="privacy-endpoint">
              <span>当前分析服务</span>
              <b>
                {managed
                  ? managed.configured
                    ? '软件分析服务已就绪'
                    : '分析服务配置异常，请联系软件管理员'
                  : active
                    ? '自定义分析服务已就绪'
                    : '尚未配置，请先完成分析服务设置'}
              </b>
            </div>
            <ul className="privacy-list">
              <li>AI 分析需要联网调用分析服务。</li>
              <li>如果资料包含客户隐私、合同、价格政策等敏感信息，请先确认是否允许上传分析。</li>
              <li>{managed ? '服务授权由软件统一管理，你不需要填写或保存 API Key。' : '你可以在设置中更换分析服务或 API Key。'}</li>
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
                title={modelConfigured ? '' : managed ? 'AI 服务暂不可用' : '请先完成分析服务设置'}
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
