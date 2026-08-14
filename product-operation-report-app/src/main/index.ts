import { app, shell, BrowserWindow, clipboard, dialog, ipcMain, Menu, session } from 'electron'
import { randomUUID } from 'crypto'
import { extname, isAbsolute, join, resolve } from 'path'
import { existsSync } from 'fs'
import type {
  AppSettings,
  CostOptimizationEvent,
  ChatMessage,
  ChatStreamEvent,
  ModelTaskContext,
  ModelTokenUsage,
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
import { runModelFallbackSequence } from './modelFallback'
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
  saveLastProject,
  saveLastProjectSync
} from './project'
import {
  activateWithCode,
  canStartLicensedAnalysis,
  consumeAnalysisCredit,
  deactivateCurrentDevice,
  getActivationStatus,
  getActivationStatusWithServerCheck,
  revealCurrentActivationCode,
  redeemPointsWithCode
} from './activation'
import { readBundledSopRules } from './sopRules'
import { checkForUpdates, downloadUpdate, installDownloadedUpdate } from './updater'
import {
  appendTokenUsageRecord,
  classifyModelFailure,
  estimateRequestTokens,
  getTokenUsageDashboard,
  readTokenUsageRecords,
  sanitizeModelTaskContext,
  tokenUsageLogPath
} from './tokenUsage'
import {
  applyActivationPoints,
  applyRechargeCodePoints,
  canStartPointsReport,
  getReportChargedPoints,
  getPointsWalletStatus,
  grantDevelopmentPoints,
  reconcileTokenUsage,
  settleTokenUsage,
  clearLocalPointsAfterUnbind
} from './pointsWallet'
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
import {
  authorizeProxyProfiles,
  clearAiProxySession,
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

function authorizationWallet(status = getActivationStatus()) {
  const localShape = getPointsWalletStatus()
  return {
    ...localShape,
    balancePoints: status.creditsRemaining ?? 0,
    unlimited: status.unlimited,
    totalTopupPoints: 0,
    totalCostPoints: 0,
    totalChargedPoints: 0,
    unbilledUsageCount: 0,
    ledger: []
  }
}

function broadcastAuthorization(status = getActivationStatus()): void {
  const wallet = getManagedModelState().mode === 'proxy'
    ? authorizationWallet(status)
    : applyActivationPoints(status).wallet
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue
    window.webContents.send('activation:changed', status)
    window.webContents.send('points:changed', wallet)
  }
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
    window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ---- IPC：设置 ----
ipcMain.handle('settings:get', () => {
  ensureActivated()
  return loadRendererSettings()
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
ipcMain.handle('source-clean-cache:lookup', (_event, input: SourceCleanCacheInput) => {
  ensureActivated()
  const profile = getActiveProfile()
  if (!profile) return { hit: false, cacheKey: '', stats: getSourceCleanCacheStats() }
  return lookupSourceCleanCache(input, profile.model)
})
ipcMain.handle(
  'source-clean-cache:store',
  (_event, payload: { input: SourceCleanCacheInput; text: string }) => {
    ensureActivated()
    const profile = getActiveProfile()
    if (!profile) return { stored: false, cacheKey: '', stats: getSourceCleanCacheStats() }
    return storeSourceCleanCache(payload.input, profile.model, payload.text)
  }
)
ipcMain.handle('report-result-cache:stats', () => getReportResultCacheStats())
ipcMain.handle('report-result-cache:clear', () => clearReportResultCache())
ipcMain.handle('report-result-cache:lookup', (_event, input: ReportResultCacheInput) => {
  ensureActivated()
  const profile = getActiveProfile()
  if (!profile) return { hit: false, cacheKey: '', stats: getReportResultCacheStats() }
  return lookupReportResultCache(input, profile.model)
})
ipcMain.handle(
  'report-result-cache:store',
  (_event, payload: { input: ReportResultCacheInput; snapshot: ReportResultCacheSnapshot }) => {
    ensureActivated()
    const profile = getActiveProfile()
    if (!profile) return { stored: false, cacheKey: '', stats: getReportResultCacheStats() }
    return storeReportResultCache(payload.input, profile.model, payload.snapshot)
  }
)
ipcMain.handle('cost-optimization:record', (_event, event: CostOptimizationEvent) => {
  ensureActivated()
  return appendCostOptimizationEvent(event)
})
ipcMain.handle('app:version', () => app.getVersion())
ipcMain.handle('activation:status', () => getActivationStatus())
ipcMain.handle('activation:refresh', async () => {
  const status = await getActivationStatusWithServerCheck()
  broadcastAuthorization(status)
  return status
})
ipcMain.handle('activation:activate', async (_e, code: string) => {
  const result = await activateWithCode(code)
  if (result.ok) {
    clearAiProxySession()
    broadcastAuthorization(result.status)
  }
  return result
})
ipcMain.handle('activation:code:reveal', () => revealCurrentActivationCode())
ipcMain.handle('activation:code:copy', () => {
  const result = revealCurrentActivationCode()
  if (!result.ok || !result.activationCode) return { ok: false, message: result.message }
  clipboard.writeText(result.activationCode)
  return { ok: true, message: '激活码已复制到剪贴板。', maskedCode: result.maskedCode }
})
ipcMain.handle('activation:deactivate', async () => {
  const proxyMode = getManagedModelState().mode === 'proxy'
  const before = proxyMode ? authorizationWallet() : getPointsWalletStatus()
  const result = await deactivateCurrentDevice()
  let wallet = proxyMode ? authorizationWallet(result.status) : before
  if (result.ok && result.unbindId) {
    clearAiProxySession()
    if (!proxyMode) {
      try {
        wallet = clearLocalPointsAfterUnbind(result.unbindId)
      } catch {
        result.message += ' 本机积分显示未能清理，但云端授权已解除；请不要在旧电脑继续使用，并联系管理员。'
      }
    }
  }
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('activation:changed', result.status)
      window.webContents.send('points:changed', wallet)
    }
  }
  return result
})
ipcMain.handle('license:canStartAnalysis', () => canStartLicensedAnalysis())
ipcMain.handle('license:consumeAnalysisCredit', (_e, operationId: string) => {
  const result = consumeAnalysisCredit(operationId)
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('activation:changed', result.status)
  }
  return result
})
ipcMain.handle('points:get', async () => {
  ensureActivated()
  if (getManagedModelState().mode === 'proxy') return authorizationWallet()
  applyActivationPoints(getActivationStatus())
  return reconcileTokenUsage(await readTokenUsageRecords())
})
ipcMain.handle('points:canStartReport', () => (
  getManagedModelState().mode === 'proxy'
    ? (() => {
        const access = canStartLicensedAnalysis()
        return { ok: access.ok, message: access.message, wallet: authorizationWallet(access.status) }
      })()
    : canStartPointsReport(getActivationStatus())
))
ipcMain.handle('points:reportCharge', async (_e, reportSessionId: string) => ({
  chargedPoints: getManagedModelState().mode === 'proxy'
    ? 0
    : getReportChargedPoints(reportSessionId)
}))
ipcMain.handle('points:grantDevelopment', () => {
  ensureActivated()
  const wallet = grantDevelopmentPoints(10_000, randomUUID())
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('points:changed', wallet)
  }
  return wallet
})
ipcMain.handle('points:redeem', async (_e, code: string) => {
  if (getManagedModelState().mode === 'proxy') {
    const merged = await redeemPointsWithCode(code)
    const wallet = authorizationWallet(merged.status)
    if (merged.ok) broadcastAuthorization(merged.status)
    return {
      ok: merged.ok,
      message: merged.message,
      activation: merged.status,
      addedPoints: merged.addedPoints,
      wallet
    }
  }
  const before = getPointsWalletStatus()
  const currentActivation = getActivationStatus()
  const grant = await redeemPointsWithCode(code)
  if (!grant.ok || !grant.grantId || !grant.points) {
    return {
      ok: false,
      message: grant.message,
      activation: currentActivation,
      addedPoints: 0,
      wallet: before
    }
  }
  const applied = applyRechargeCodePoints(grant.grantId, grant.points)
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('points:changed', applied.wallet)
    }
  }
  return {
    ok: applied.addedPoints > 0,
    message: applied.addedPoints > 0
      ? `充值成功，已增加 ${applied.addedPoints} 积分。`
      : '这个积分码已经入账过，积分没有重复增加。',
    activation: currentActivation,
    addedPoints: applied.addedPoints,
    wallet: applied.wallet
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
    const primaryProfile = profiles[0]
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
              else {
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
                : {})
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
        let wallet = managedState.mode === 'proxy'
          ? undefined
          : settleTokenUsage(finalRecord)
        if (managedState.mode === 'proxy' && terminal.type === 'done') {
          const refreshed = await getActivationStatusWithServerCheck().catch(() => getActivationStatus())
          wallet = authorizationWallet(refreshed)
          for (const window of BrowserWindow.getAllWindows()) {
            if (!window.isDestroyed()) window.webContents.send('activation:changed', refreshed)
          }
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
      })
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

  app.whenReady().then(() => {
    setupMenu()
    createWindow()
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
