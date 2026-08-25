import { app, shell, BrowserWindow, clipboard, dialog, ipcMain, Menu, session } from 'electron'
import { extname, isAbsolute, join, resolve } from 'path'
import { existsSync } from 'fs'
import type {
  ActivationResult,
  ActivationStatus,
  AppSettings,
  CostOptimizationEvent,
  ChatStreamEvent,
  ContactDisplayState,
  ModelTokenUsage,
  ModuleKey,
  SavedProject,
  ReportResultCacheInput,
  ReportResultCacheSnapshot,
  SourceCleanCacheInput,
  TestModelOptions,
  TokenUsageRecord
} from '../shared/types'
import { getActiveProfile, getActiveProfiles, loadRendererSettings, saveRendererSettings } from './settings'
import { getManagedModelState } from './managedModel'
import { chatStream, listModels, testModel } from './model'
import { profilesForTask, runModelFallbackSequence } from './modelFallback'
import {
  cancelParsingForOwner,
  disposeParseService,
  hasParsingForOwner,
  parseArchiveInUtility,
  parseFileInUtility
} from './parseService'
import { exportDocx, exportHtml, exportMarkdown } from './export'
import {
  archiveProject,
  loadLastProject,
  loadPreviousProject,
  preflightProjectStorage,
  pruneOrphanBlobs,
  saveLastProject,
  saveLastProjectSync
} from './project'
import {
  activateWithCode,
  canStartLicensedAnalysis,
  deactivateCurrentDevice,
  getActivationStatus,
  getActivationStatusWithServerCheck,
  revalidateSavedActivationCode,
  restoreAuthorizationOnStartup,
  revealCurrentActivationCode,
  redeemPointsWithCode
} from './activation'
import { buildActivationDiagnostic } from './activationDiagnostics'
import { ExclusiveOperationGate } from './exclusiveOperationGate'
import { readBundledSopRules } from './sopRules'
import { readBundledModulePrompt } from './modulePrompts'
import { checkForUpdates, downloadUpdate, installDownloadedUpdate } from './updater'
import {
  appendTokenUsageRecord,
  classifyModelFailure,
  estimateRequestTokens,
  getTokenUsageDashboard,
  sanitizeModelTaskContext,
  tokenUsageLogPath
} from './tokenUsage'
import {
  clearSourceCleanCache,
  getSourceCleanCacheStats,
  lookupSourceCleanCache,
  storeSourceCleanCache
} from './sourceCleanCache'
import {
  clearReportResultCache,
  getReportResultCacheStats,
  lookupReportResultCache,
  storeReportResultCache
} from './reportResultCache'
import { appendCostOptimizationEvent } from './costOptimization'
import { ChatRequestRegistry, validateChatStartPayload } from './chatAdmission'
import { getCachedContactState, refreshContactConfig } from './contact'
import {
  authorizeProxyProfiles,
  clearAiProxySession,
  clearProxyWalletSnapshot,
  fetchProxyWallet,
  testProxyHealth
} from './aiProxy'

const developmentUserDataDir =
  !app.isPackaged && process.env.PRODUCT_REPORT_ALLOW_DEV_OVERRIDES === '1'
    ? process.env.PRODUCT_REPORT_DEV_USER_DATA_DIR?.trim()
    : ''
if (developmentUserDataDir) app.setPath('userData', resolve(developmentUserDataDir))

let mainWindow: BrowserWindow | null = null
let latestProjectSnapshot: SavedProject | null = null
let hardExitTimer: ReturnType<typeof setTimeout> | null = null
const activationOperationGate = new ExclusiveOperationGate()
const ACTIVATION_REFRESH_MIN_INTERVAL_MS = 60_000
let lastActivationRefreshStartedAt = 0
const allowedLocalOpenPaths = new Set<string>()
const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) app.quit()

function armHardExitWatchdog(): void {
  if (hardExitTimer) return
  hardExitTimer = setTimeout(() => app.exit(0), 4_000)
}

function resolveWindowIcon(): string | undefined {
  const candidates = [
    join(app.getAppPath(), 'assets', 'product-logo.png'),
    join(__dirname, '../../assets/product-logo.png'),
    join(process.resourcesPath || '', 'app.asar.unpacked', 'assets', 'product-logo.png')
  ]
  return candidates.find((p) => existsSync(p))
}

function isSafeExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}

async function openExternalUrl(url: string): Promise<void> {
  if (!isSafeExternalUrl(url)) throw new Error('仅支持打开 http/https 链接')
  await shell.openExternal(url)
}

function validateLocalPath(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || !isAbsolute(value)) {
    throw new Error('文件路径无效，请重新导出。')
  }
  if (!existsSync(value)) throw new Error('文件已被移动或删除，请重新导出。')
  const safeExtensions = new Set(['.html', '.htm', '.md', '.docx', '.pdf', '.txt', '.csv', '.xlsx', '.png', '.jpg', '.jpeg', '.webp'])
  if (!safeExtensions.has(extname(value).toLowerCase())) {
    throw new Error('为保护电脑安全，只能打开报告、数据表或图片文件。')
  }
  const normalized = resolve(value)
  if (!allowedLocalOpenPaths.has(normalized)) {
    throw new Error('只能打开由本软件刚刚导出的文件或更新安装包。')
  }
  return normalized
}

function rememberExportPath<T extends { ok: boolean; path?: string }>(result: T): T {
  if (result.ok && result.path && isAbsolute(result.path)) allowedLocalOpenPaths.add(resolve(result.path))
  return result
}

function ensureActivated(): void {
  if (!getActivationStatus().activated) throw new Error('软件未激活，请先输入激活码。')
}

async function broadcastAuthorization(status = getActivationStatus()): Promise<void> {
  const wallet = await fetchProxyWallet().catch(() => undefined)
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue
    window.webContents.send('activation:changed', status)
    if (wallet) window.webContents.send('points:changed', wallet)
  }
}

function broadcastContact(state: ContactDisplayState): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('contact:changed', state)
  }
}

async function refreshActivationStatusThrottled(): Promise<ActivationStatus> {
  return activationOperationGate.run(async () => {
    if (Date.now() - lastActivationRefreshStartedAt < ACTIVATION_REFRESH_MIN_INTERVAL_MS) {
      return getActivationStatus()
    }
    lastActivationRefreshStartedAt = Date.now()
    return getActivationStatusWithServerCheck()
  }, () => getActivationStatus())
}

function createWindow(): void {
  if (app.isPackaged) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
          ]
        }
      })
    })
  }
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 880,
    minHeight: 640,
    show: false,
    title: '产品与内容经营报告系统',
    icon: resolveWindowIcon(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      devTools: !app.isPackaged
    }
  })
  mainWindow = window
  const ownerId = window.webContents.id

  let forceClose = false
  let closePromptOpen = false
  const finishClose = (): void => {
    cancelParsingForOwner(ownerId, '软件正在关闭，文件解析已停止。')
    chatRequests.abortOwner(ownerId)
    if (process.platform !== 'darwin') armHardExitWatchdog()
    forceClose = true
    window.close()
  }

  window.on('close', (event) => {
    if (forceClose || window.webContents.isDestroyed()) return
    event.preventDefault()
    if (closePromptOpen) return
    const activePhase = latestProjectSnapshot?.phase === 'cleaning' || latestProjectSnapshot?.phase === 'analyzing'
    const hasActiveWork = activePhase || hasParsingForOwner(ownerId) || chatRequests.hasOwner(ownerId)
    if (!hasActiveWork) {
      finishClose()
      return
    }
    closePromptOpen = true
    void dialog
      .showMessageBox(window, {
        type: 'warning',
        title: '当前任务还没有完成',
        message: '资料仍在上传、解析或分析，确定要退出软件吗？',
        detail: '退出会停止当前任务。已经自动保存的资料和历史报告不会删除，下次打开可以继续处理。',
        buttons: ['停止任务并退出', '继续使用'],
        defaultId: 1,
        cancelId: 1
      })
      .then((result) => {
        closePromptOpen = false
        if (result.response === 0 && !window.isDestroyed()) finishClose()
      })
      .catch(() => {
        closePromptOpen = false
        if (!window.isDestroyed()) finishClose()
      })
  })
  window.on('session-end', () => {
    if (latestProjectSnapshot) {
      try {
        saveLastProjectSync(latestProjectSnapshot)
      } catch {
        // Windows 正在强制结束会话，无法阻止；尽最大努力保留最近一次主进程快照
      }
    }
    forceClose = true
  })

  window.webContents.on('render-process-gone', () => {
    cancelParsingForOwner(ownerId, '界面已重新加载，旧文件解析已停止。')
    chatRequests.abortOwner(ownerId)
  })

  window.on('ready-to-show', () => window.show())
  window.on('closed', () => {
    cancelParsingForOwner(ownerId, '窗口已关闭，旧文件解析已停止。')
    chatRequests.abortOwner(ownerId)
    if (mainWindow === window) mainWindow = null
  })

  // 输入框右键菜单：剪切 / 复制 / 粘贴 / 全选
  window.webContents.on('context-menu', (_e, params) => {
    if (params.isEditable) {
      Menu.buildFromTemplate([
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { type: 'separator' },
        { role: 'selectAll' }
      ]).popup({ window })
    } else if (params.selectionText) {
      Menu.buildFromTemplate([{ role: 'copy' }]).popup({ window })
    }
  })

  window.webContents.setWindowOpenHandler((details) => {
    void openExternalUrl(details.url).catch(() => undefined)
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, url) => {
    const currentUrl = window.webContents.getURL()
    const withoutHash = (value: string): string => value.split('#', 1)[0]
    if (url === currentUrl || (withoutHash(url) === withoutHash(currentUrl) && url.includes('#'))) return

    event.preventDefault()
    if (isSafeExternalUrl(url)) void openExternalUrl(url).catch(() => undefined)
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    void window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ---- IPC：设置 ----
ipcMain.handle('settings:get', () => {
  ensureActivated()
  return loadRendererSettings()
})
ipcMain.handle('contact:get', () => {
  const initial = getCachedContactState()
  void refreshContactConfig().then(broadcastContact)
  return initial
})
ipcMain.handle('settings:save', (_e, settings: AppSettings) => {
  ensureActivated()
  return saveRendererSettings(settings)
})
ipcMain.handle('shell:openExternal', (_e, url: string) => openExternalUrl(url))
ipcMain.handle('shell:openPath', async (_e, path: string) => {
  ensureActivated()
  const error = await shell.openPath(validateLocalPath(path))
  if (error) throw new Error('系统没有找到可打开此文件的程序，请点击“打开所在文件夹”。')
})
ipcMain.handle('shell:showItemInFolder', (_e, path: string) => {
  ensureActivated()
  shell.showItemInFolder(validateLocalPath(path))
})
ipcMain.handle('token-usage:summary', () => {
  ensureActivated()
  return getTokenUsageDashboard()
})
ipcMain.handle('token-usage:open-location', () => {
  ensureActivated()
  shell.showItemInFolder(tokenUsageLogPath())
})

ipcMain.handle('source-clean-cache:stats', () => getSourceCleanCacheStats())
ipcMain.handle('source-clean-cache:clear', () => clearSourceCleanCache())
ipcMain.handle('source-clean-cache:lookup', async (_event, input: SourceCleanCacheInput) => {
  ensureActivated()
  const profile = getActiveProfile()
  if (!profile) return { hit: false, cacheKey: '', stats: await getSourceCleanCacheStats() }
  return lookupSourceCleanCache(input, profile.model)
})
ipcMain.handle(
  'source-clean-cache:store',
  async (_event, payload: { input: SourceCleanCacheInput; text: string }) => {
    ensureActivated()
    const profile = getActiveProfile()
    if (!profile) return { stored: false, cacheKey: '', stats: await getSourceCleanCacheStats() }
    return storeSourceCleanCache(payload.input, profile.model, payload.text)
  }
)
ipcMain.handle('report-result-cache:stats', () => getReportResultCacheStats())
ipcMain.handle('report-result-cache:clear', () => clearReportResultCache())
ipcMain.handle('report-result-cache:lookup', async (_event, input: ReportResultCacheInput) => {
  ensureActivated()
  const profile = getActiveProfile()
  if (!profile) return { hit: false, cacheKey: '', stats: await getReportResultCacheStats() }
  return lookupReportResultCache(input, profile.model)
})
ipcMain.handle(
  'report-result-cache:store',
  async (_event, payload: { input: ReportResultCacheInput; snapshot: ReportResultCacheSnapshot }) => {
    ensureActivated()
    const profile = getActiveProfile()
    if (!profile) return { stored: false, cacheKey: '', stats: await getReportResultCacheStats() }
    return storeReportResultCache(payload.input, profile.model, payload.snapshot)
  }
)
ipcMain.handle('cost-optimization:record', (_event, event: CostOptimizationEvent) => {
  ensureActivated()
  return appendCostOptimizationEvent(event)
})
ipcMain.handle('app:version', () => app.getVersion())
ipcMain.handle('activation:refresh', async () => {
  const status = await refreshActivationStatusThrottled()
  if (!status.activated) clearAiProxySession()
  await broadcastAuthorization(status)
  return status
})
async function runActivationOperation(operation: () => Promise<ActivationResult>): Promise<ActivationResult> {
  return activationOperationGate.run(async () => {
    const result = await operation()
    if (result.ok) {
      clearAiProxySession()
      lastActivationRefreshStartedAt = Date.now()
    }
    if (!result.status.activated) clearAiProxySession()
    await broadcastAuthorization(result.status)
    return result
  }, () => ({
    ok: false,
    message: '正在处理上一次激活，请稍候。',
    status: getActivationStatus()
  }))
}
ipcMain.handle('activation:status', () => activationOperationGate.run(
  () => restoreAuthorizationOnStartup(),
  () => getActivationStatus()
))
ipcMain.handle('activation:activate', async (_e, code: unknown) => {
  if (typeof code !== 'string' || code.length > 512) {
    return { ok: false, message: '激活码格式不正确。', status: getActivationStatus() }
  }
  return runActivationOperation(() => activateWithCode(code))
})
ipcMain.handle('activation:revalidate-saved', async () => {
  return runActivationOperation(() => revalidateSavedActivationCode())
})
ipcMain.handle('activation:diagnostics:copy', () => {
  const diagnostic = buildActivationDiagnostic(
    getActivationStatus(),
    app.getVersion(),
    `${process.platform}-${process.arch}`
  )
  clipboard.writeText(diagnostic)
  return { ok: true, message: '设备诊断信息已复制，可直接发给管理员。' }
})
/*
 * Code reveal/copy remains deliberately separate from diagnostics. The full
 * activation code only crosses IPC after an explicit user reveal action.
 */
ipcMain.handle('activation:code:reveal', () => revealCurrentActivationCode())
ipcMain.handle('activation:code:copy', () => {
  const result = revealCurrentActivationCode()
  if (!result.ok || !result.activationCode) return { ok: false, message: result.message }
  clipboard.writeText(result.activationCode)
  return { ok: true, message: '激活码已复制到剪贴板。', maskedCode: result.maskedCode }
})
ipcMain.handle('activation:deactivate', async () => {
  const before = await fetchProxyWallet().catch(() => undefined)
  const result = await deactivateCurrentDevice()
  let wallet = before
  if (result.ok && result.unbindId) {
    clearAiProxySession()
    clearProxyWalletSnapshot()
    wallet = undefined
  }
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('activation:changed', result.status)
      if (wallet) window.webContents.send('points:changed', wallet)
    }
  }
  return result
})
ipcMain.handle('points:get', async () => {
  ensureActivated()
  return fetchProxyWallet()
})
ipcMain.handle('points:canStartReport', async () => {
  const access = canStartLicensedAnalysis()
  const wallet = await fetchProxyWallet()
  return { ok: access.ok, message: access.message, wallet }
})
ipcMain.handle('points:reportCharge', async (_e, reportSessionId: string) => {
  const wallet = await fetchProxyWallet()
  const chargedPoints = wallet.ledger
    .filter((entry) => entry.reportSessionId === reportSessionId && entry.pointsDelta < 0)
    .reduce((sum, entry) => sum + Math.abs(entry.pointsDelta), 0)
  return { chargedPoints }
})
ipcMain.handle('points:redeem', async (_e, code: string) => {
  const before = await fetchProxyWallet()
  const merged = await redeemPointsWithCode(code)
  if (merged.ok) {
    clearAiProxySession()
    clearProxyWalletSnapshot()
  }
  const wallet = merged.ok ? await fetchProxyWallet() : before
  if (merged.ok) await broadcastAuthorization(merged.status)
  return {
    ok: merged.ok,
    message: merged.message,
    activation: merged.status,
    addedPoints: merged.addedPoints,
    wallet
  }
})

// ---- IPC：自动更新 ----
ipcMain.handle('update:check', () => {
  ensureActivated()
  return checkForUpdates()
})
ipcMain.handle('update:download', (event) => {
  ensureActivated()
  return downloadUpdate((progress) => {
    if (!event.sender.isDestroyed()) event.sender.send('update:progress', progress)
  })
})
ipcMain.handle('update:install', () => {
  ensureActivated()
  return installDownloadedUpdate()
})

// ---- IPC：项目快照（不包含模型配置 / API Key）----
ipcMain.handle('project:loadLast', () => {
  ensureActivated()
  return loadLastProject()
})
ipcMain.handle('project:saveLast', (_e, project: SavedProject) => {
  ensureActivated()
  latestProjectSnapshot = project
  return saveLastProject(project)
})
ipcMain.handle('project:preflight', (_e, project: SavedProject) => {
  ensureActivated()
  return preflightProjectStorage(project)
})
ipcMain.on('project:cacheSnapshot', (_e, project: SavedProject) => {
  if (getActivationStatus().activated) latestProjectSnapshot = project
})
ipcMain.handle('project:archive', (_e, project: SavedProject) => {
  ensureActivated()
  return archiveProject(project)
})
ipcMain.handle('project:loadPrevious', () => {
  ensureActivated()
  return loadPreviousProject()
})

// ---- IPC：测试模型 ----
ipcMain.handle('model:test', (_e, opts: TestModelOptions) => {
  ensureActivated()
  const managed = getManagedModelState()
  if (managed.enabled) {
    if (!managed.profile) return { ok: false, message: managed.info?.error || '内置模型服务配置不可用，请联系软件管理员。' }
    if (managed.mode === 'proxy') return testProxyHealth()
    return testModel({ ...opts, profile: managed.profile })
  }
  return testModel(opts)
})
ipcMain.handle('model:list', (_e, profile: Parameters<typeof listModels>[0]) => {
  ensureActivated()
  const managed = getManagedModelState()
  if (managed.enabled) {
    if (!managed.profile) return { ok: false, error: managed.info?.error || '内置模型服务配置不可用，请联系软件管理员。' }
    if (managed.mode === 'proxy') return { ok: true, models: managed.profiles.map((item) => item.model) }
    return listModels(managed.profile)
  }
  return listModels(profile)
})

// ---- IPC：文件解析 ----
ipcMain.handle('file:parse', (event, payload: { name: string; data: ArrayBuffer }) => {
  ensureActivated()
  return parseFileInUtility(event.sender.id, payload.name, payload.data)
})
ipcMain.handle('archive:parse', (event, payload: { name: string; data: ArrayBuffer }) => {
  ensureActivated()
  return parseArchiveInUtility(event.sender.id, payload.name, payload.data)
})
ipcMain.handle('file:cancelAll', (event) => {
  cancelParsingForOwner(event.sender.id)
})

// ---- IPC：读取 SOP 规则（SKILL.md）作为系统提示词 ----
function readSopRules(): string {
  const candidates = [
    join(app.getAppPath(), 'assets', 'skill', 'SKILL.md'),
    join(process.resourcesPath || '', 'app.asar.unpacked', 'assets', 'skill', 'SKILL.md'),
    join(__dirname, '../../assets/skill/SKILL.md')
  ]
  return readBundledSopRules(candidates)
}
ipcMain.handle('sop:rules', () => {
  ensureActivated()
  return readSopRules()
})
ipcMain.handle('module:prompt', (_event, key: ModuleKey) => {
  ensureActivated()
  const directories = [
    join(app.getAppPath(), 'assets', 'modules'),
    join(process.resourcesPath || '', 'app.asar.unpacked', 'assets', 'modules'),
    join(__dirname, '../../assets/modules')
  ]
  return readBundledModulePrompt(key, directories)
})

// ---- IPC：导出报告 ----
ipcMain.handle('export:markdown', async (_e, p: { content: string; name: string }) => {
  ensureActivated()
  return rememberExportPath(await exportMarkdown(p.content, p.name))
})
ipcMain.handle('export:docx', async (_e, p: { content: string; name: string }) => {
  ensureActivated()
  return rememberExportPath(await exportDocx(p.content, p.name))
})
ipcMain.handle('export:html', async (_e, p: { content: string; name: string }) => {
  ensureActivated()
  return rememberExportPath(await exportHtml(p.content, p.name))
})

// ---- IPC：流式聊天 ----
const chatRequests = new ChatRequestRegistry(4)

ipcMain.on(
  'chat:start',
  async (event, payload: unknown) => {
    const rawId = payload && typeof payload === 'object' && typeof (payload as { id?: unknown }).id === 'string'
      ? (payload as { id: string }).id
      : ''
    let validated: ReturnType<typeof validateChatStartPayload>
    try {
      validated = validateChatStartPayload(payload)
    } catch (error) {
      if (/^[0-9a-f-]{36}$/i.test(rawId) && !event.sender.isDestroyed()) {
        event.sender.send(`chat:event:${rawId}`, {
          type: 'error',
          message: error instanceof Error ? error.message : '模型请求格式无效，请重新开始本次分析。',
          usage: {
            source: 'missing', inputTokens: 0, outputTokens: 0, reasoningTokens: 0,
            cachedInputTokens: 0, cacheCreationInputTokens: 0, totalTokens: 0, model: ''
          }
        })
      }
      return
    }
    const { id, messages } = validated
    const channel = `chat:event:${id}`
    const emptyUsage = (model = ''): ModelTokenUsage => ({
      source: 'missing',
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalTokens: 0,
      model
    })
    if (!getActivationStatus().activated) {
      event.sender.send(channel, {
        type: 'error',
        message: '软件未激活，请先输入激活码。',
        usage: emptyUsage()
      })
      return
    }
    let profiles = getActiveProfiles()
    const managedState = getManagedModelState()
    let primaryProfile = profiles[0]
    if (!primaryProfile) {
      const managed = getManagedModelState()
      event.sender.send(channel, {
        type: 'error',
        message: managed.enabled
          ? managed.info?.error || '内置模型服务暂不可用，请联系软件管理员。'
          : '未配置模型，请先在设置里添加模型配置。',
        usage: emptyUsage()
      })
      return
    }
    const context = sanitizeModelTaskContext(validated.context)
    if (!context) {
      event.sender.send(channel, {
        type: 'error',
        message: '模型任务标识无效，请重新开始本次分析。',
        usage: emptyUsage(primaryProfile.model)
      })
      return
    }
    profiles = profilesForTask(profiles, context.taskType)
    primaryProfile = profiles[0]
    const controller = new AbortController()
    try {
      chatRequests.claim(id, event.sender.id, controller)
    } catch (error) {
      event.sender.send(channel, {
        type: 'error',
        message: error instanceof Error ? error.message : '模型任务暂时无法开始。',
        usage: emptyUsage(primaryProfile.model)
      })
      return
    }
    const initialEstimate = estimateRequestTokens(messages)
    const proxyEndpointFailure = (message: string): boolean => (
      !/provider_route_unavailable|model[_ -]?(not[_ -]?found|unavailable)|unknown model|模型不存在|模型不可用/i.test(message) &&
      /业务服务器|会话|积分|HTTP\s+(401|402|403|404|409|429|5\d\d)\b|fetch failed|ECONN|ENOTFOUND|network|网络|timeout|超时/i.test(message)
    )
    try {
      if (managedState.mode === 'proxy') {
        try {
          const access = canStartLicensedAnalysis()
          if (!access.ok) {
            event.sender.send(channel, { type: 'error', message: access.message, usage: emptyUsage() })
            return
          }
          profiles = await authorizeProxyProfiles(profiles)
        } catch (error) {
          event.sender.send(channel, {
            type: 'error',
            message: error instanceof Error ? error.message : '业务服务器暂时不可用，请稍后重试。',
            usage: emptyUsage()
          })
          return
        }
      }
      const sequence = await runModelFallbackSequence(profiles, async (profile, profileIndex) => {
        const attemptRequestId = profileIndex === 0 ? id : `${id}:fallback:${profileIndex}`
        const startedAt = new Date().toISOString()
        const startedRecord: TokenUsageRecord = {
          schemaVersion: 1,
          eventType: 'started',
          requestId: attemptRequestId,
          ...context,
          attempt: Math.min(20, context.attempt + profileIndex),
          model: profile.model.slice(0, 200),
          status: 'started',
          startedAt,
          endedAt: startedAt,
          durationMs: 0,
          outputChars: 0,
          usageSource: 'missing',
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          cachedInputTokens: 0,
          cacheCreationInputTokens: 0,
          totalTokens: 0,
          estimatedInputTokens: initialEstimate.inputTokens,
          estimatedOutputTokens: 0,
          estimatedTotalTokens: initialEstimate.totalTokens
        }
        await appendTokenUsageRecord(startedRecord).catch((error) => {
          console.error('Unable to append token usage start record:', error)
        })

        let terminal: Extract<ChatStreamEvent, { type: 'done' | 'error' }> | undefined
        let usage = emptyUsage(profile.model)
        let outputChars = 0
        let hasVisibleOutput = false
        try {
          await chatStream(
            profile,
            messages,
            (ev) => {
              if (ev.type === 'chunk') {
                outputChars += ev.delta.length
                if (ev.delta.trim()) hasVisibleOutput = true
              }
              else if (ev.type === 'usage') usage = ev.usage
              else if (ev.type === 'done' || ev.type === 'error') {
                terminal = ev
                usage = ev.usage
                if (ev.type === 'done') outputChars = ev.full.length
              }
              if (ev.type !== 'done' && ev.type !== 'error' && !event.sender.isDestroyed()) {
                event.sender.send(channel, ev)
              }
            },
            controller.signal,
            {
              ...(profileIndex === 0 && (context.taskType === 'source_clean' || context.taskType === 'summary')
                ? { reasoningEffort: 'low' as const }
                : {}),
              ...(managedState.mode === 'proxy'
                ? {
                    requestHeaders: {
                      'x-request-id': attemptRequestId,
                      'x-billing-request-id': context.billingRequestId,
                      'x-report-session-id': context.reportSessionId,
                      'x-task-key': context.taskKey,
                      'x-task-type': context.taskType,
                      'x-task-attempt': String(Math.min(20, context.attempt + profileIndex))
                    }
                  }
                : {}),
              promptCacheKey: context.taskType === 'source_clean'
                ? `source-clean:${context.sourceId || context.taskKey}`
                : context.taskType === 'analysis_step'
                  ? `analysis:${context.reportSessionId}:evidence-digest-v1`
                  : `${context.taskType}:${context.reportSessionId}`
            }
          )
        } catch (error) {
          terminal = {
            type: 'error',
            message: error instanceof Error ? error.message : '模型请求异常结束。',
            usage
          }
        }
        if (!terminal) {
          terminal = {
            type: 'error',
            message: '模型请求已结束，但没有返回可用结果。',
            usage
          }
        }

        const endedAt = new Date().toISOString()
        const status = controller.signal.aborted
          ? 'aborted'
          : terminal.type === 'done'
            ? 'success'
            : 'error'
        const message = terminal.type === 'error' ? terminal.message : ''
        const failureKind = managedState.mode === 'proxy' && proxyEndpointFailure(message)
          ? 'proxy_unavailable'
          : classifyModelFailure(message, status)
        const estimate = estimateRequestTokens(messages, outputChars)
        const finalRecord: TokenUsageRecord = {
          schemaVersion: 1,
          eventType: 'final',
          requestId: attemptRequestId,
          ...context,
          attempt: Math.min(20, context.attempt + profileIndex),
          model: usage.model || profile.model.slice(0, 200),
          status,
          failureKind,
          startedAt,
          endedAt,
          durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)),
          outputChars,
          usageSource: usage.source,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          reasoningTokens: usage.reasoningTokens,
          cachedInputTokens: usage.cachedInputTokens,
          cacheCreationInputTokens: usage.cacheCreationInputTokens,
          totalTokens: usage.totalTokens,
          ...(usage.source === 'missing'
            ? {
                estimatedInputTokens: estimate.inputTokens,
                estimatedOutputTokens: estimate.outputTokens,
                estimatedTotalTokens: estimate.totalTokens
              }
            : {})
        }
        await appendTokenUsageRecord(finalRecord).catch((error) => {
          console.error('Unable to append token usage final record:', error)
        })
        let wallet
        if (managedState.mode === 'proxy' && terminal.type === 'done') {
          wallet = await fetchProxyWallet().catch(() => undefined)
        }
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed() && wallet) window.webContents.send('points:changed', wallet)
        }

        return {
          terminal,
          failureKind,
          outputChars,
          hasVisibleOutput,
          aborted: controller.signal.aborted
        }
      }, context.taskType)
      if (!event.sender.isDestroyed()) event.sender.send(channel, sequence.outcome.terminal)
    } finally {
      chatRequests.release(id, event.sender.id, controller)
    }
  }
)

ipcMain.on('chat:abort', (event, id: string) => {
  if (typeof id === 'string') chatRequests.abort(id, event.sender.id)
})

// 应用菜单：提供标准编辑角色，让复制/剪切/粘贴/全选快捷键生效
function setupMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    { role: 'editMenu' },
    ...(!app.isPackaged ? [{ role: 'viewMenu' as const }] : []),
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

if (hasSingleInstanceLock) {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  void app.whenReady().then(() => {
    setupMenu()
    createWindow()
    const blobPruneTimer = setTimeout(() => {
      void pruneOrphanBlobs().catch(() => undefined)
    }, 30_000)
    blobPruneTimer.unref()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  armHardExitWatchdog()
  chatRequests.abortAll()
  disposeParseService()
})
