import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ActivationStatus,
  AppSettings,
  ModelProfile,
  PointsWalletStatus,
  ReportResultCacheStats,
  SourceCleanCacheStats,
  TestModelResult
} from '../../../shared/types'
import { useStore } from '../store'

const DEFAULT_PROFILE_NAME = 'ai英雄会'
const LEGACY_DEFAULT_PROFILE_NAME = '中转API（ai英雄会）'
const CONFIG_GUIDE_URL = 'https://my.feishu.cn/docx/DrvrdxXguorTW0xrEA8cMK93nCg?from=from_copylink'

function friendlySettingsError(value: unknown, fallback: string): string {
  const raw = (value instanceof Error ? value.message : String(value || '')).replace(/\s+/g, ' ').trim()
  if (!raw) return fallback
  if (/401|unauthorized|invalid api key|authentication/i.test(raw)) return 'API Key 不正确，请重新复制后再测试。'
  if (/404|not found|model.*不存在/i.test(raw)) return '模型地址或模型名不正确，请按教程检查。'
  if (/429|rate limit|quota|额度|限流/i.test(raw)) return '模型服务繁忙或额度不足，请稍后重试或联系管理员。'
  if (/timeout|timed out|超时/i.test(raw)) return '连接超时，请检查网络和模型地址。'
  if (/fetch failed|ECONN|ENOTFOUND|network|网络/i.test(raw)) return '无法连接模型服务，请检查网络后重试。'
  if (/HTML|网页/i.test(raw)) return '模型地址返回了网页，请按教程检查地址是否正确。'
  return raw.length <= 180 && !/[{}<>]/.test(raw) ? raw : fallback
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

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB'
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function formatPoints(value: number): string {
  return Number.isInteger(value)
    ? value.toLocaleString('zh-CN')
    : value.toLocaleString('zh-CN', { maximumFractionDigits: 3 })
}

function normalizeSettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    privacyAccepted: Boolean(settings.privacyAccepted),
    profiles: settings.profiles.map((profile) =>
      profile.name === LEGACY_DEFAULT_PROFILE_NAME ? { ...profile, name: DEFAULT_PROFILE_NAME } : profile
    )
  }
}

function createProfile(name = DEFAULT_PROFILE_NAME): ModelProfile {
  return {
    id: crypto.randomUUID(),
    name,
    baseURL: 'https://cool.ai123321.com/v1',
    apiKey: '',
    model: 'gpt-5.5',
    supportsVision: true,
    temperature: 0.3
  }
}

function createDraftSettings(settings: AppSettings | null): AppSettings {
  if (settings?.profiles.length) return normalizeSettings(structuredClone(settings))
  return {
    profiles: [createProfile()],
    activeProfileId: null,
    projectsDir: settings?.projectsDir || '',
    privacyAccepted: Boolean(settings?.privacyAccepted)
  }
}

export default function SettingsModal(): JSX.Element | null {
  const open = useStore((s) => s.settingsOpen)
  const settings = useStore((s) => s.settings)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const saveSettings = useStore((s) => s.saveSettings)
  const phase = useStore((s) => s.phase)
  // 开发版热更新时主进程/预加载可能短暂仍是旧版本；所有新增缓存接口都必须可选，不能让设置页白屏。
  const cacheApi = window.api as unknown as {
    getSourceCleanCacheStats?: () => Promise<SourceCleanCacheStats>
    clearSourceCleanCache?: () => Promise<SourceCleanCacheStats>
    getReportResultCacheStats?: () => Promise<ReportResultCacheStats>
    clearReportResultCache?: () => Promise<ReportResultCacheStats>
  }

  // 本地草稿，确认后再写回
  const [draft, setDraft] = useState<AppSettings>(() => createDraftSettings(settings))
  const [selectedId, setSelectedId] = useState<string>(() => draft.profiles[0]?.id ?? '')
  const [testing, setTesting] = useState(false)
  const [fetchingModels, setFetchingModels] = useState(false)
  const [saving, setSaving] = useState(false)
  const [actionError, setActionError] = useState('')
  const [result, setResult] = useState<TestModelResult | null>(null)
  const [models, setModels] = useState<string[]>([])
  const [modelsMsg, setModelsMsg] = useState('')
  const [cacheStats, setCacheStats] = useState<SourceCleanCacheStats | null>(null)
  const [cacheBusy, setCacheBusy] = useState(false)
  const [cacheMessage, setCacheMessage] = useState('')
  const [reportCacheStats, setReportCacheStats] = useState<ReportResultCacheStats | null>(null)
  const [reportCacheBusy, setReportCacheBusy] = useState(false)
  const [reportCacheMessage, setReportCacheMessage] = useState('')
  const [cachePanelOpen, setCachePanelOpen] = useState(false)
  const [activationStatus, setActivationStatus] = useState<ActivationStatus | null>(null)
  const [pointsWallet, setPointsWallet] = useState<PointsWalletStatus | null>(null)
  const [deactivationConfirmOpen, setDeactivationConfirmOpen] = useState(false)
  const [deactivationBusy, setDeactivationBusy] = useState(false)
  const [deactivationError, setDeactivationError] = useState('')
  const [revealedActivationCode, setRevealedActivationCode] = useState('')
  const [activationCodeNotice, setActivationCodeNotice] = useState('')
  const imgRef = useRef<HTMLInputElement>(null)
  const testRequestSeq = useRef(0)
  const modelsRequestSeq = useRef(0)
  const baselineRef = useRef('')

  const selected = useMemo(
    () => draft.profiles.find((p) => p.id === selectedId) ?? draft.profiles[0],
    [draft, selectedId]
  )
  const hasApiKey = Boolean(selected?.apiKey.trim())
  const isFirstSetup = !settings?.profiles.length
  const hasConnectionResult = Boolean(result?.ok)
  const canTestVision = hasApiKey && Boolean(selected?.supportsVision)
  const hasUnsavedChanges = Boolean(baselineRef.current && JSON.stringify(draft) !== baselineRef.current)
  const analysisBusy = phase === 'cleaning' || phase === 'analyzing'

  const requestClose = useCallback((): void => {
    if (saving) return
    if (hasUnsavedChanges && !window.confirm('设置还没有保存。\n\n要放弃刚才的修改吗？')) return
    setRevealedActivationCode('')
    setSettingsOpen(false)
  }, [hasUnsavedChanges, saving, setSettingsOpen])

  useEffect(() => {
    if (!open || !settings) return
    const next = createDraftSettings(settings)
    setDraft(next)
    baselineRef.current = JSON.stringify(next)
    setSelectedId(
      next.profiles.some((profile) => profile.id === next.activeProfileId)
        ? next.activeProfileId || next.profiles[0]?.id || ''
        : next.profiles[0]?.id || ''
    )
    setResult(null)
    setModels([])
    setModelsMsg('')
    setActionError('')
    setCachePanelOpen(false)
    setCacheMessage('')
    setReportCacheMessage('')
  }, [open, settings])

  useEffect(() => {
    if (!open || !settings?.managedModel?.enabled) return
    let alive = true
    setDeactivationConfirmOpen(false)
    setDeactivationError('')
    setRevealedActivationCode('')
    setActivationCodeNotice('')
    void Promise.all([window.api.getActivationStatus(), window.api.getPointsWallet()])
      .then(([activation, wallet]) => {
        if (!alive) return
        setActivationStatus(activation)
        setPointsWallet(wallet)
      })
      .catch(() => {
        if (alive) setDeactivationError('设备授权状态暂时无法读取，请关闭窗口后重试。')
      })
    return () => {
      alive = false
    }
  }, [open, settings?.managedModel?.enabled])

  useEffect(() => {
    testRequestSeq.current++
    modelsRequestSeq.current++
    setTesting(false)
    setFetchingModels(false)
    setResult(null)
    setModels([])
    setModelsMsg('')
  }, [selectedId, selected?.apiKey, selected?.baseURL, selected?.model, selected?.supportsVision])

  const loadCacheStats = async (): Promise<void> => {
    const tasks: Promise<unknown>[] = []
    if (typeof cacheApi.getSourceCleanCacheStats === 'function') {
      tasks.push(
        cacheApi.getSourceCleanCacheStats().then(setCacheStats).catch(() => {
          setCacheStats(null)
          setCacheMessage('清洗缓存暂时无法读取，不影响正常生成报告。')
        })
      )
    } else {
      setCacheStats(null)
      setCacheMessage('缓存服务尚未加载，请关闭并重新打开软件。')
    }
    if (typeof cacheApi.getReportResultCacheStats === 'function') {
      tasks.push(
        cacheApi.getReportResultCacheStats().then(setReportCacheStats).catch(() => {
          setReportCacheStats(null)
          setReportCacheMessage('报告缓存暂时无法读取，不影响正常生成报告。')
        })
      )
    } else {
      setReportCacheStats(null)
      setReportCacheMessage('缓存服务尚未加载，请关闭并重新打开软件。')
    }
    await Promise.all(tasks)
  }

  // Esc 关闭弹窗
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') requestClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, requestClose])

  const clearCleaningCache = async (): Promise<void> => {
    if (cacheBusy || !window.confirm('确定清理本机文件清洗缓存吗？\n\n不会删除报告或原始文件；下次使用相同资料时需要重新处理。')) return
    if (typeof cacheApi.clearSourceCleanCache !== 'function') {
      setCacheMessage('缓存服务尚未加载，请关闭并重新打开软件。')
      return
    }
    setCacheBusy(true)
    setCacheMessage('')
    try {
      setCacheStats(await cacheApi.clearSourceCleanCache())
      setCacheMessage('清洗缓存已清理。')
    } catch (error) {
      setCacheMessage(friendlySettingsError(error, '清理缓存失败，请重启软件后重试。'))
    } finally {
      setCacheBusy(false)
    }
  }

  const clearReportCache = async (): Promise<void> => {
    if (reportCacheBusy || !window.confirm('确定清理完整报告复用缓存吗？\n\n不会删除历史项目、导出报告或原始文件；以后相同资料需要重新生成。')) return
    if (typeof cacheApi.clearReportResultCache !== 'function') {
      setReportCacheMessage('缓存服务尚未加载，请关闭并重新打开软件。')
      return
    }
    setReportCacheBusy(true)
    setReportCacheMessage('')
    try {
      setReportCacheStats(await cacheApi.clearReportResultCache())
      setReportCacheMessage('完整报告缓存已清理。')
    } catch (error) {
      setReportCacheMessage(friendlySettingsError(error, '清理完整报告缓存失败，请重启软件后重试。'))
    } finally {
      setReportCacheBusy(false)
    }
  }

  const submitDeactivation = async (): Promise<void> => {
    if (deactivationBusy || analysisBusy) return
    setDeactivationBusy(true)
    setDeactivationError('')
    try {
      const result = await window.api.deactivateCurrentDevice()
      if (!result.ok) {
        setDeactivationError(result.message)
        return
      }
      setSettingsOpen(false)
    } catch (error) {
      setDeactivationError(friendlySettingsError(error, '解除绑定失败，本机仍保持激活，请稍后重试。'))
    } finally {
      setDeactivationBusy(false)
    }
  }

  const copyCurrentActivationCode = async (): Promise<void> => {
    try {
      const result = await window.api.copyActivationCode()
      if (!result.ok) {
        setActivationCodeNotice(result.message)
        return
      }
      setActivationCodeNotice('已复制')
    } catch {
      setActivationCodeNotice('复制失败，请点击“显示”后手动记录。')
    }
  }

  const toggleCurrentActivationCode = async (): Promise<void> => {
    if (revealedActivationCode) {
      setRevealedActivationCode('')
      return
    }
    try {
      const result = await window.api.revealActivationCode()
      if (!result.ok || !result.activationCode) {
        setActivationCodeNotice(result.message)
        return
      }
      setRevealedActivationCode(result.activationCode)
      setActivationCodeNotice('完整激活码仅在当前窗口临时显示。')
    } catch {
      setActivationCodeNotice('读取激活码失败，请稍后重试。')
    }
  }

  if (!open) return null

  const cachePanel = (
    <details
      className="cache-management"
      onToggle={(event) => {
        const nextOpen = event.currentTarget.open
        setCachePanelOpen(nextOpen)
        if (nextOpen) void loadCacheStats()
      }}
    >
      <summary>本机缓存管理（一般不用）</summary>
      {cachePanelOpen && <div className="cache-card-stack">
      <div className="clean-cache-card">
        <div>
          <span>本机清洗缓存</span>
          <b>{cacheStats ? `${cacheStats.entryCount} 份 · 命中 ${cacheStats.totalHits} 次 · ${formatBytes(cacheStats.totalBytes)}` : '正在读取…'}</b>
          <em>相同文件30天内自动复用，可减少重复等待。</em>
          {cacheMessage && <small>{cacheMessage}</small>}
        </div>
        <button className="btn" type="button" disabled={cacheBusy || !cacheStats?.entryCount} onClick={() => void clearCleaningCache()}>
          {cacheBusy ? '清理中…' : '清理缓存'}
        </button>
      </div>
      <div className="clean-cache-card report-cache-card">
        <div>
          <span>完整报告复用</span>
          <b>{reportCacheStats ? `${reportCacheStats.entryCount} 份 · 命中 ${reportCacheStats.totalHits} 次 · ${formatBytes(reportCacheStats.totalBytes)}` : '正在读取…'}</b>
          <em>完全相同的资料和要求，30天内可选择直接恢复上次结果。</em>
          {reportCacheMessage && <small>{reportCacheMessage}</small>}
        </div>
        <button className="btn" type="button" disabled={reportCacheBusy || !reportCacheStats?.entryCount} onClick={() => void clearReportCache()}>
          {reportCacheBusy ? '清理中…' : '清理报告缓存'}
        </button>
      </div>
      </div>}
    </details>
  )

  const managed = settings?.managedModel
  if (managed?.enabled) {
    return (
      <div className="modal-mask">
        <div className="modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={(e) => e.stopPropagation()}>
          <div className="modal-head">
            <h3 id="settings-title">设置 · AI 服务</h3>
            <button className="btn" disabled={deactivationBusy} onClick={() => setSettingsOpen(false)}>
              关闭
            </button>
          </div>
          <div className="modal-body">
            <div className="settings-guide">
              <div className="settings-guide-main">
                <span className="settings-guide-kicker">无需填写 API Key</span>
                <b>{managed.configured ? 'AI 服务已就绪' : 'AI 服务需要维护'}</b>
                <span>
                  {managed.configured
                    ? '服务和授权已由软件配置完成，直接上传资料并开始生成报告即可。'
                    : managed.error || 'AI 服务暂不可用，请联系软件管理员。'}
                </span>
              </div>
            </div>
            <div className={`test-result ${managed.configured ? 'ok' : 'err'}`} role="status">
              {managed.configured ? '✓ 服务配置正常' : '✗ 服务配置异常'}
              {'\n'}
              {managed.configured
                ? `支持文字资料分析${managed.supportsVision ? '和图片识别' : ''}`
                : '用户无需自行修改设置，请把此提示反馈给软件管理员。'}
            </div>
            <section className="service-device-transfer" aria-labelledby="service-device-title">
              <div className="service-device-heading">
                <div>
                  <span>设备授权</span>
                  <b id="service-device-title">当前电脑已激活</b>
                  <small>只有准备换到另一台电脑使用时，才需要解除本机绑定。</small>
                </div>
                <div className="service-device-actions">
                <button
                  className="btn"
                  type="button"
                  disabled={analysisBusy || deactivationBusy || activationStatus?.activated === false}
                  title={analysisBusy ? '请先等待当前分析完成或停止' : '解除当前电脑绑定'}
                  onClick={() => {
                    setDeactivationError('')
                    setDeactivationConfirmOpen(true)
                  }}
                >
                  更换电脑
                </button>
                </div>
              </div>
              <div className="service-license-code">
                <div>
                  <span>当前软件激活码</span>
                  <code>
                    {activationStatus?.activationCodeAvailable
                      ? revealedActivationCode
                        ? revealedActivationCode
                        : activationStatus.maskedActivationCode || '••••••••'
                      : '旧版本地授权未保存原码'}
                  </code>
                  <small>积分充值码只增加余额，不会替换这里的激活码。</small>
                </div>
                {activationStatus?.activationCodeAvailable && (
                  <div className="service-license-actions">
                    <button className="btn" type="button" onClick={() => void toggleCurrentActivationCode()}>
                      {revealedActivationCode ? '隐藏' : '显示激活码'}
                    </button>
                    <button className="btn" type="button" onClick={() => void copyCurrentActivationCode()}>
                      复制
                    </button>
                  </div>
                )}
                {activationCodeNotice && <em>{activationCodeNotice}</em>}
              </div>
              {deactivationConfirmOpen && (
                <div className="service-transfer-confirm" role="group" aria-label="确认解除本机绑定">
                  <strong>确认解除这台电脑的绑定？</strong>
                  <p>
                    {activationStatus?.source === 'legacy'
                      ? '当前是旧版本地授权，没有建立云端设备绑定。解除后历史报告仍保留；新电脑通过服务器输入激活码后即可使用，积分以服务器记录为准。'
                      : `解除后软件会回到激活页面。历史报告仍保留；在新电脑输入同一个激活码即可继续使用。${
                          activationStatus?.unlimited
                            ? ' 当前为无限使用授权，重新绑定后仍由服务器恢复无限授权。'
                            : pointsWallet
                            ? ` 当前剩余 ${formatPoints(pointsWallet.balancePoints)} 积分由服务器保留，重新绑定后自动恢复。`
                            : ''
                        }`}
                  </p>
                  {deactivationError && <div className="privacy-error">{deactivationError}</div>}
                  <div className="service-transfer-actions">
                    <button
                      className="btn"
                      type="button"
                      disabled={deactivationBusy}
                      onClick={() => {
                        setDeactivationConfirmOpen(false)
                        setDeactivationError('')
                      }}
                    >
                      取消
                    </button>
                    <button
                      className="btn danger"
                      type="button"
                      disabled={deactivationBusy || analysisBusy}
                      onClick={() => void submitDeactivation()}
                    >
                      {deactivationBusy ? '正在安全解绑…' : '确认解除绑定'}
                    </button>
                  </div>
                </div>
              )}
              {!deactivationConfirmOpen && deactivationError && (
                <div className="privacy-error">{deactivationError}</div>
              )}
            </section>
            {cachePanel}
            <div className="hint">为避免误操作，模型地址、模型名称和授权信息不会显示在用户界面中。</div>
          </div>
          <div className="modal-foot">
            <div />
            <button className="btn primary" disabled={deactivationBusy} onClick={() => setSettingsOpen(false)}>
              我知道了
            </button>
          </div>
        </div>
      </div>
    )
  }

  const patch = (p: Partial<ModelProfile>): void => {
    setDraft((d) => ({
      ...d,
      profiles: d.profiles.map((x) => (x.id === selected.id ? { ...x, ...p } : x))
    }))
  }

  const addProfile = (): void => {
    const np = createProfile('新模型配置')
    setDraft((d) => ({ ...d, profiles: [...d.profiles, np] }))
    setSelectedId(np.id)
    setResult(null)
  }

  const removeProfile = (): void => {
    if (!window.confirm(`确定删除“${selected.name || '这个模型配置'}”吗？`)) return
    setDraft((d) => {
      const profiles = d.profiles.filter((x) => x.id !== selected.id)
      return {
        ...d,
        profiles,
        activeProfileId: d.activeProfileId === selected.id ? null : d.activeProfileId
      }
    })
    const remain = draft.profiles.filter((x) => x.id !== selected.id)
    setSelectedId(remain[0]?.id ?? '')
  }

  const runTest = async (withImageDataUrl?: string): Promise<void> => {
    const requestId = ++testRequestSeq.current
    setTesting(true)
    setResult(null)
    setActionError('')
    try {
      const r = await window.api.testModel({ profile: selected, withImageDataUrl })
      if (testRequestSeq.current === requestId) setResult(r)
    } catch (error) {
      if (testRequestSeq.current === requestId) {
        setActionError(friendlySettingsError(error, '模型测试失败，请重试。'))
      }
    } finally {
      if (testRequestSeq.current === requestId) setTesting(false)
    }
  }

  const fetchModels = async (): Promise<void> => {
    const requestId = ++modelsRequestSeq.current
    setFetchingModels(true)
    setModelsMsg('拉取中…')
    setModels([])
    setActionError('')
    try {
      const r = await window.api.listModels(selected)
      if (modelsRequestSeq.current !== requestId) return
      if (r.ok) {
        setModels(r.models ?? [])
        setModelsMsg(r.models?.length ? `共 ${r.models.length} 个，点一个填入` : '该端点没有返回模型列表')
      } else {
        setModelsMsg(`拉取失败：${friendlySettingsError(r.error, '请检查模型地址和网络。')}`)
      }
    } catch (error) {
      if (modelsRequestSeq.current === requestId) {
        setModelsMsg('')
        setActionError(friendlySettingsError(error, '拉取模型失败，请重试。'))
      }
    } finally {
      if (modelsRequestSeq.current === requestId) setFetchingModels(false)
    }
  }

  const onPickImage = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    if (!f.type.startsWith('image/')) {
      setActionError('请选择 PNG、JPG、WebP 或 GIF 图片。')
      return
    }
    if (f.size > 10 * 1024 * 1024) {
      setActionError('测试图片超过 10MB，请换一张较小的截图。')
      return
    }
    const reader = new FileReader()
    reader.onload = () => void runTest(reader.result as string)
    reader.onerror = () => setActionError('图片读取失败，请重新选择。')
    reader.readAsDataURL(f)
  }

  const onSave = async (): Promise<void> => {
    if (saving || !selected) return
    const apiKey = selected.apiKey.trim()
    const baseURL = selected.baseURL.trim().replace(/\/+$/, '')
    const model = selected.model.trim()
    if (!apiKey) {
      setActionError('请先粘贴 API Key；没有 API Key 无法开始分析。')
      return
    }
    if (!baseURL || !model) {
      setActionError('模型地址或模型名为空，请恢复默认值或按教程填写。')
      return
    }
    if (isFirstSetup && !result?.ok) {
      setActionError('第一次配置请先点“测试连通”，显示成功后再保存。')
      return
    }
    try {
      const parsed = new URL(baseURL)
      const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
      if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) {
        setActionError('为保护 API Key 和商业资料，模型地址必须使用 https。')
        return
      }
    } catch {
      setActionError('模型地址格式不正确。一般保持默认地址即可。')
      return
    }
    const cleanedDraft: AppSettings = {
      ...draft,
      profiles: draft.profiles.map((profile) => ({
        ...profile,
        name: profile.name.trim() || DEFAULT_PROFILE_NAME,
        baseURL: profile.baseURL.trim().replace(/\/+$/, ''),
        apiKey: profile.apiKey.trim(),
        model: profile.model.trim()
      })),
      activeProfileId: selected.id
    }
    setSaving(true)
    setActionError('')
    try {
      await saveSettings(cleanedDraft)
      baselineRef.current = JSON.stringify(cleanedDraft)
      setSettingsOpen(false)
    } catch (error) {
      setActionError(friendlySettingsError(error, '保存设置失败，请重试。'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-mask">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3 id="settings-title">设置 · 模型配置</h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {!settings?.profiles.length && (
              <span style={{ fontSize: 12, color: 'var(--text-weak)' }}>未填写 API Key 无法开始分析</span>
            )}
            <button className="btn" disabled={saving} onClick={requestClose}>
              关闭
            </button>
          </div>
        </div>

        <div className="modal-body">
          <div className="settings-guide">
            <div className="settings-guide-main">
              <span className="settings-guide-kicker">推荐默认配置</span>
              <b>ai英雄会</b>
              <span>粘贴 API Key，点“测试连通”，成功后保存即可。其他设置一般不用改。</span>
            </div>
            <a
              href={CONFIG_GUIDE_URL}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => {
                event.preventDefault()
                openExternalLink(CONFIG_GUIDE_URL)
              }}
            >
              打开配置教程
            </a>
          </div>

          {cachePanel}

          <div className="settings-steps" aria-label="模型配置步骤">
            <div className={`settings-step ${hasApiKey ? 'done' : 'active'}`}>
              <span>1</span>
              <div>
                <b>填 API Key</b>
                <em>{hasApiKey ? '已填写' : '先粘贴服务商给你的 Key'}</em>
              </div>
            </div>
            <div className={`settings-step ${hasConnectionResult ? 'done' : hasApiKey ? 'active' : ''}`}>
              <span>2</span>
              <div>
                <b>测试连通{isFirstSetup ? '' : '（建议）'}</b>
                <em>{hasApiKey ? '确认 Key 和模型可以正常使用' : '填写 Key 后再测试'}</em>
              </div>
            </div>
            <div className={`settings-step ${selected?.supportsVision && hasConnectionResult ? 'active' : ''}`}>
              <span>3</span>
              <div>
                <b>测试读图（可选）</b>
                <em>{selected?.supportsVision ? '不影响直接使用，可用于排查图片识别' : '当前模型未开启读图'}</em>
              </div>
            </div>
          </div>

          <div className="profiles-bar">
            {draft.profiles.map((p) => (
              <button
                key={p.id}
                className={`profile-tab ${p.id === selected?.id ? 'active' : ''}`}
                onClick={() => {
                  setSelectedId(p.id)
                  setResult(null)
                }}
              >
                {p.name || '(未命名)'}
                {draft.activeProfileId === p.id ? ' ·当前' : ''}
              </button>
            ))}
            <button className="profile-tab" onClick={addProfile}>
              ＋ 新增模型
            </button>
          </div>

          {selected && (
            <>
              <div className="active-profile-card">
                <div>
                  <span>保存后将使用</span>
                  <strong>{selected.name || DEFAULT_PROFILE_NAME}</strong>
                </div>
              </div>

              <div className="field">
                <label>名称</label>
                <input
                  type="text"
                  value={selected.name}
                  onChange={(e) => patch({ name: e.target.value })}
                  placeholder="ai英雄会"
                />
              </div>
              <div className="field">
                <label>API Key</label>
                <input
                  type="password"
                  value={selected.apiKey}
                  onChange={(e) => patch({ apiKey: e.target.value })}
                  placeholder="粘贴 API Key，例如 sk-..."
                />
                <div className="hint">只保存在这台电脑，并由系统安全加密。</div>
              </div>

              <div className="settings-test-panel">
                <div>
                  <b>{isFirstSetup ? '首次必须完成' : '连接检查'}</b>
                  <span>{isFirstSetup ? '先测试连通，成功后再保存。' : '修改 Key 或模型后，建议重新测试。'}</span>
                </div>
                <div className="settings-test-actions">
                  <button className="btn primary" disabled={testing || !hasApiKey} onClick={() => runTest()}>
                    {testing ? '测试中…' : '测试连通'}
                  </button>
                  <button
                    className="btn"
                    disabled={testing || !canTestVision}
                    onClick={() => imgRef.current?.click()}
                    title={selected.supportsVision ? '' : '请先勾选支持读图'}
                  >
                    测试读图
                  </button>
                  <input
                    ref={imgRef}
                    type="file"
                    accept="image/*"
                    style={{ display: 'none' }}
                    onChange={onPickImage}
                  />
                </div>
              </div>

              {result && (
                <div className={`test-result ${result.ok ? 'ok' : 'err'}`}>
                  {result.ok ? '✓ 连通成功' : '✗ 失败'}
                  {typeof result.latencyMs === 'number' ? `（${result.latencyMs}ms）` : ''}
                  {'\n'}
                  {result.ok ? result.message : friendlySettingsError(result.message, '测试失败，请检查设置后重试。')}
                </div>
              )}
              {actionError && <div className="test-result err">{actionError}</div>}

              <details className="advanced-settings">
                <summary className="advanced-settings-title">高级配置（一般不用改）</summary>
                <div className="advanced-settings-desc">一般保持默认即可；需要接入其他服务时再修改。</div>
                <div className="field">
                <label>Base URL</label>
                <input
                  type="text"
                  value={selected.baseURL}
                  onChange={(e) => patch({ baseURL: e.target.value })}
                  placeholder="https://cool.ai123321.com/v1"
                />
                <div className="hint">OpenAI 兼容端点，末尾到 /v1 即可（会自动补 /chat/completions）。</div>
              </div>
                <div className="field">
                <label>模型名</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="text"
                    value={selected.model}
                    onChange={(e) => patch({ model: e.target.value })}
                    placeholder="gpt-5.5"
                  />
                  <button
                    className="btn"
                    style={{ flex: '0 0 auto' }}
                    disabled={!hasApiKey || fetchingModels}
                    onClick={() => void fetchModels()}
                    title={selected.apiKey ? '从端点拉取可用模型' : '请先填 API Key'}
                  >
                    {fetchingModels ? '拉取中…' : '拉取模型'}
                  </button>
                </div>
                {modelsMsg && <div className="hint">{modelsMsg}</div>}
                {models.length > 0 && (
                  <div className="model-chips">
                    {models.map((m) => (
                      <button
                        key={m}
                        className={`model-chip ${m === selected.model ? 'active' : ''}`}
                        onClick={() => patch({ model: m })}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                )}
              </div>
                <div className="field">
                  <div className="checkbox-row">
                  <input
                    id="vision"
                    type="checkbox"
                    checked={selected.supportsVision}
                    onChange={(e) => patch({ supportsVision: e.target.checked })}
                  />
                  <label htmlFor="vision" style={{ margin: 0 }}>
                    该模型支持读图（多模态）—— 上传的截图会直接发给模型
                  </label>
                  </div>
                </div>
              </details>
            </>
          )}
        </div>

        <div className="modal-foot">
          <div>
            {selected && draft.profiles.length > 1 && (
              <button className="btn" onClick={removeProfile}>
                删除此配置
              </button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary" disabled={saving} onClick={() => void onSave()}>
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
