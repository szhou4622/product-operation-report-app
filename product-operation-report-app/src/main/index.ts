import { app, shell, BrowserWindow, dialog, ipcMain, Menu } from 'electron'
import { randomUUID } from 'crypto'
import { isAbsolute, join, resolve } from 'path'
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
import { getActiveProfile, loadRendererSettings, saveRendererSettings } from './settings'
import { getManagedModelState } from './managedModel'
import { chatStream, listModels, testModel } from './model'
import {
  cancelParsingForOwner,
  disposeParseService,
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
  getActivationStatusWithServerCheck
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
  canStartPointsReport,
  getReportChargedPoints,
  getPointsWalletStatus,
  grantDevelopmentPoints,
  reconcileTokenUsage,
  settleTokenUsage,
  transferOutPoints
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

const developmentUserDataDir =
  process.env.PRODUCT_REPORT_ALLOW_DEV_OVERRIDES === '1'
    ? process.env.PRODUCT_REPORT_DEV_USER_DATA_DIR?.trim()
    : ''
if (developmentUserDataDir) app.setPath('userData', resolve(developmentUserDataDir))

let mainWindow: BrowserWindow | null = null
let latestProjectSnapshot: SavedProject | null = null
const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) app.quit()

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
  return value
}

function ensureActivated(): void {
  if (!getActivationStatus().activated) throw new Error('软件未激活，请先输入激活码。')
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 880,
    minHeight: 640,
    show: false,
    title: '产品经营报告',
    icon: resolveWindowIcon(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })
  mainWindow = window
  const ownerId = window.webContents.id

  let forceClose = false
  let closeRequestId = ''
  let closeTimer: ReturnType<typeof setTimeout> | null = null
  let closeGuardReady = false
  const finishClose = (): void => {
    forceClose = true
    if (closeTimer) clearTimeout(closeTimer)
    closeTimer = null
    window.close()
  }
  const scheduleCloseTimeout = (delay = 5000): void => {
    if (closeTimer) clearTimeout(closeTimer)
    closeTimer = setTimeout(() => {
      closeTimer = null
      if (!closeRequestId || window.isDestroyed()) return
      void dialog
        .showMessageBox(window, {
          type: 'warning',
          title: '保存时间较长',
          message: '软件正在保存当前分析，暂时还不能安全关闭。',
          detail: '建议继续等待，避免丢失刚才的操作。',
          buttons: ['继续等待', '仍然退出'],
          defaultId: 0,
          cancelId: 0
        })
        .then((result) => {
          if (window.isDestroyed() || !closeRequestId) return
          if (result.response === 1) finishClose()
          else scheduleCloseTimeout(10000)
        })
    }, delay)
  }
  const onCloseReady = (
    event: Electron.IpcMainEvent,
    payload: { id?: string; ok?: boolean; error?: string }
  ): void => {
    if (event.sender !== window.webContents || !closeRequestId || payload?.id !== closeRequestId) return
    if (closeTimer) clearTimeout(closeTimer)
    closeTimer = null
    closeRequestId = ''
    if (payload.ok) {
      finishClose()
      return
    }
    void dialog.showMessageBox(window, {
      type: 'error',
      title: '暂时无法关闭',
      message: '当前分析还没有保存成功。',
      detail: payload.error || '请检查磁盘空间或文件权限，然后再关闭软件。',
      buttons: ['我知道了']
    })
  }
  ipcMain.on('app:close-ready', onCloseReady)
  const onCloseGuardState = (event: Electron.IpcMainEvent, ready: boolean): void => {
    if (event.sender === window.webContents) closeGuardReady = Boolean(ready)
  }
  ipcMain.on('app:close-guard-state', onCloseGuardState)

  window.on('close', (event) => {
    if (forceClose || !closeGuardReady || window.webContents.isDestroyed()) return
    event.preventDefault()
    if (closeRequestId) return
    closeRequestId = randomUUID()
    window.webContents.send('app:before-close', { id: closeRequestId })
    scheduleCloseTimeout()
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
    closeGuardReady = false
    cancelParsingForOwner(ownerId, '界面已重新加载，旧文件解析已停止。')
    for (const controller of inflight.values()) controller.abort()
    inflight.clear()
  })

  window.on('ready-to-show', () => window.show())
  window.on('closed', () => {
    if (closeTimer) clearTimeout(closeTimer)
    cancelParsingForOwner(ownerId, '窗口已关闭，旧文件解析已停止。')
    ipcMain.removeListener('app:close-ready', onCloseReady)
    ipcMain.removeListener('app:close-guard-state', onCloseGuardState)
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

  if (process.env['ELECTRON_RENDERER_URL']) {
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
  const wallet = applyActivationPoints(status).wallet
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('activation:changed', status)
      window.webContents.send('points:changed', wallet)
    }
  }
  return status
})
ipcMain.handle('activation:activate', async (_e, code: string) => {
  const result = await activateWithCode(code)
  if (result.ok) {
    const wallet = applyActivationPoints(result.status).wallet
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('activation:changed', result.status)
        window.webContents.send('points:changed', wallet)
      }
    }
  }
  return result
})
ipcMain.handle('activation:deactivate', async () => {
  const before = getPointsWalletStatus()
  const result = await deactivateCurrentDevice(before.balancePoints)
  let wallet = before
  if (result.ok && result.transferId) {
    try {
      wallet = transferOutPoints(result.transferId)
    } catch {
      result.message += ' 本机积分记录清理失败，但授权已解除；请不要在旧电脑继续使用，并联系管理员。'
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
  applyActivationPoints(getActivationStatus())
  return reconcileTokenUsage(await readTokenUsageRecords())
})
ipcMain.handle('points:canStartReport', () => canStartPointsReport(getActivationStatus()))
ipcMain.handle('points:reportCharge', (_e, reportSessionId: string) => ({
  chargedPoints: getReportChargedPoints(reportSessionId)
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
  const before = getPointsWalletStatus()
  const activation = await activateWithCode(code)
  if (!activation.ok) {
    return {
      ok: false,
      message: activation.message,
      activation: activation.status,
      addedPoints: 0,
      wallet: before
    }
  }
  const applied = applyActivationPoints(activation.status)
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('activation:changed', activation.status)
      window.webContents.send('points:changed', applied.wallet)
    }
  }
  return {
    ok: applied.addedPoints > 0,
    message: applied.addedPoints > 0
      ? `充值成功，已增加 ${applied.addedPoints} 积分。`
      : activation.status.licenseType !== 'credits' || (activation.status.creditsRemaining || 0) <= 0
        ? '这个激活码不包含可充值积分，请使用管理员发放的积分码。'
        : '这个充值码已经入账过，积分没有重复增加。',
    activation: activation.status,
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
    return testModel({ ...opts, profile: managed.profile })
  }
  return testModel(opts)
})
ipcMain.handle('model:list', (_e, profile: Parameters<typeof listModels>[0]) => {
  ensureActivated()
  const managed = getManagedModelState()
  if (managed.enabled) {
    if (!managed.profile) return { ok: false, error: managed.info?.error || '内置模型服务配置不可用，请联系软件管理员。' }
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
ipcMain.handle('export:markdown', (_e, p: { content: string; name: string }) => {
  ensureActivated()
  return exportMarkdown(p.content, p.name)
})
ipcMain.handle('export:docx', (_e, p: { content: string; name: string }) => {
  ensureActivated()
  return exportDocx(p.content, p.name)
})
ipcMain.handle('export:html', (_e, p: { content: string; name: string }) => {
  ensureActivated()
  return exportHtml(p.content, p.name)
})

// ---- IPC：流式聊天 ----
const inflight = new Map<string, AbortController>()

ipcMain.on(
  'chat:start',
  async (event, payload: { id: string; messages: ChatMessage[]; context: ModelTaskContext }) => {
    const { id, messages } = payload
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
    const profile = getActiveProfile()
    if (!profile) {
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
    const context = sanitizeModelTaskContext(payload.context)
    if (!context) {
      event.sender.send(channel, {
        type: 'error',
        message: '模型任务标识无效，请重新开始本次分析。',
        usage: emptyUsage(profile.model)
      })
      return
    }
    const controller = new AbortController()
    inflight.set(id, controller)
    const startedAt = new Date().toISOString()
    const initialEstimate = estimateRequestTokens(messages)
    const startedRecord: TokenUsageRecord = {
      schemaVersion: 1,
      eventType: 'started',
      requestId: id,
      ...context,
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
    try {
      await chatStream(
        profile,
        messages,
        (ev) => {
          if (ev.type === 'chunk') outputChars += ev.delta.length
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
        context.taskType === 'source_clean' || context.taskType === 'summary'
          ? { reasoningEffort: 'low' }
          : undefined
      )
    } finally {
      inflight.delete(id)
      const endedAt = new Date().toISOString()
      const status = controller.signal.aborted
        ? 'aborted'
        : terminal?.type === 'done'
          ? 'success'
          : 'error'
      const estimate = estimateRequestTokens(messages, outputChars)
      const finalRecord: TokenUsageRecord = {
        schemaVersion: 1,
        eventType: 'final',
        requestId: id,
        ...context,
        model: usage.model || profile.model.slice(0, 200),
        status,
        failureKind: classifyModelFailure(terminal?.type === 'error' ? terminal.message : '', status),
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
      const wallet = settleTokenUsage(finalRecord)
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send('points:changed', wallet)
      }
      if (terminal && !event.sender.isDestroyed()) event.sender.send(channel, terminal)
    }
  }
)

ipcMain.on('chat:abort', (_e, id: string) => {
  inflight.get(id)?.abort()
  inflight.delete(id)
})

// 应用菜单：提供标准编辑角色，让复制/剪切/粘贴/全选快捷键生效
function setupMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    { role: 'editMenu' },
    { role: 'viewMenu' },
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

app.on('will-quit', () => {
  disposeParseService()
})
