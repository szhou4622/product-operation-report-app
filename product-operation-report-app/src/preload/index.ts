import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppSettings,
  ArchiveItem,
  ActivationResult,
  ActivationDeactivationResult,
  ActivationStatus,
  ChatMessage,
  ChatStreamEvent,
  CostOptimizationEvent,
  ExportResult,
  ModelListResult,
  ModelProfile,
  ModelTaskContext,
  ModelTokenUsage,
  LicenseUsageResult,
  ParsedFile,
  PointsAccessResult,
  PointsRedeemResult,
  PointsWalletStatus,
  ReportResultCacheInput,
  ReportResultCacheLookupResult,
  ReportResultCacheSnapshot,
  ReportResultCacheStats,
  ReportResultCacheStoreResult,
  SavedProject,
  SourceCleanCacheInput,
  SourceCleanCacheLookupResult,
  SourceCleanCacheStats,
  SourceCleanCacheStoreResult,
  TestModelOptions,
  TestModelResult,
  UpdateActionResult,
  UpdateDownloadProgress,
  UpdateInfo,
  TokenUsageDashboard
} from '../shared/types'

export interface ChatHandlers {
  onChunk?: (delta: string) => void
  onUsage?: (usage: ModelTokenUsage) => void
  onDone?: (full: string) => void
  onError?: (message: string) => void
}

const api = {
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),

  getActivationStatus: (): Promise<ActivationStatus> => ipcRenderer.invoke('activation:status'),

  refreshActivationStatus: (): Promise<ActivationStatus> => ipcRenderer.invoke('activation:refresh'),

  onActivationStatusChanged: (handler: (status: ActivationStatus) => void): (() => void) => {
    const listener = (_event: unknown, status: ActivationStatus): void => handler(status)
    ipcRenderer.on('activation:changed', listener)
    return () => ipcRenderer.removeListener('activation:changed', listener)
  },

  activate: (code: string): Promise<ActivationResult> =>
    ipcRenderer.invoke('activation:activate', code),

  deactivateCurrentDevice: (): Promise<ActivationDeactivationResult> =>
    ipcRenderer.invoke('activation:deactivate'),

  canStartLicensedAnalysis: (): Promise<LicenseUsageResult> =>
    ipcRenderer.invoke('license:canStartAnalysis'),

  consumeAnalysisCredit: (operationId: string): Promise<LicenseUsageResult> =>
    ipcRenderer.invoke('license:consumeAnalysisCredit', operationId),

  getPointsWallet: (): Promise<PointsWalletStatus> => ipcRenderer.invoke('points:get'),

  canStartPointsReport: (): Promise<PointsAccessResult> => ipcRenderer.invoke('points:canStartReport'),

  getReportPointsCharge: (reportSessionId: string): Promise<{ chargedPoints: number }> =>
    ipcRenderer.invoke('points:reportCharge', reportSessionId),

  redeemPointsCode: (code: string): Promise<PointsRedeemResult> =>
    ipcRenderer.invoke('points:redeem', code),

  grantDevelopmentPoints: (): Promise<PointsWalletStatus> =>
    ipcRenderer.invoke('points:grantDevelopment'),

  onPointsWalletChanged: (handler: (status: PointsWalletStatus) => void): (() => void) => {
    const listener = (_event: unknown, status: PointsWalletStatus): void => handler(status)
    ipcRenderer.on('points:changed', listener)
    return () => ipcRenderer.removeListener('points:changed', listener)
  },

  checkForUpdates: (): Promise<UpdateInfo> => ipcRenderer.invoke('update:check'),

  downloadUpdate: (): Promise<UpdateActionResult> => ipcRenderer.invoke('update:download'),

  installUpdate: (): Promise<UpdateActionResult> => ipcRenderer.invoke('update:install'),

  onUpdateProgress: (handler: (progress: UpdateDownloadProgress) => void): (() => void) => {
    const listener = (_event: unknown, progress: UpdateDownloadProgress): void => handler(progress)
    ipcRenderer.on('update:progress', listener)
    return () => ipcRenderer.removeListener('update:progress', listener)
  },

  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),

  saveSettings: (settings: AppSettings): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:save', settings),

  loadLastProject: (): Promise<SavedProject | null> => ipcRenderer.invoke('project:loadLast'),

  saveLastProject: (project: SavedProject): Promise<SavedProject> =>
    ipcRenderer.invoke('project:saveLast', project),

  cacheProjectSnapshot: (project: SavedProject): void =>
    ipcRenderer.send('project:cacheSnapshot', project),

  archiveProject: (project: SavedProject): Promise<SavedProject> =>
    ipcRenderer.invoke('project:archive', project),

  loadPreviousProject: (): Promise<SavedProject | null> => ipcRenderer.invoke('project:loadPrevious'),

  onBeforeClose: (handler: () => void | Promise<void>): (() => void) => {
    const listener = async (_event: unknown, payload: { id: string }): Promise<void> => {
      try {
        await handler()
        ipcRenderer.send('app:close-ready', { id: payload.id, ok: true })
      } catch (error) {
        ipcRenderer.send('app:close-ready', {
          id: payload.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
    ipcRenderer.on('app:before-close', listener)
    ipcRenderer.send('app:close-guard-state', true)
    return () => {
      ipcRenderer.removeListener('app:before-close', listener)
      ipcRenderer.send('app:close-guard-state', false)
    }
  },

  testModel: (opts: TestModelOptions): Promise<TestModelResult> =>
    ipcRenderer.invoke('model:test', opts),

  listModels: (profile: ModelProfile): Promise<ModelListResult> =>
    ipcRenderer.invoke('model:list', profile),

  parseFile: (name: string, data: ArrayBuffer): Promise<ParsedFile> =>
    ipcRenderer.invoke('file:parse', { name, data }),

  parseArchive: (name: string, data: ArrayBuffer): Promise<ArchiveItem[]> =>
    ipcRenderer.invoke('archive:parse', { name, data }),

  cancelFileParsing: (): Promise<void> => ipcRenderer.invoke('file:cancelAll'),

  getSopRules: (): Promise<string> => ipcRenderer.invoke('sop:rules'),

  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url),

  openPath: (path: string): Promise<void> => ipcRenderer.invoke('shell:openPath', path),

  showItemInFolder: (path: string): Promise<void> =>
    ipcRenderer.invoke('shell:showItemInFolder', path),

  getTokenUsageSummary: (): Promise<TokenUsageDashboard> =>
    ipcRenderer.invoke('token-usage:summary'),

  openTokenUsageLocation: (): Promise<void> => ipcRenderer.invoke('token-usage:open-location'),

  getSourceCleanCacheStats: (): Promise<SourceCleanCacheStats> =>
    ipcRenderer.invoke('source-clean-cache:stats'),

  clearSourceCleanCache: (): Promise<SourceCleanCacheStats> =>
    ipcRenderer.invoke('source-clean-cache:clear'),

  lookupSourceCleanCache: (input: SourceCleanCacheInput): Promise<SourceCleanCacheLookupResult> =>
    ipcRenderer.invoke('source-clean-cache:lookup', input),

  storeSourceCleanCache: (
    input: SourceCleanCacheInput,
    text: string
  ): Promise<SourceCleanCacheStoreResult> =>
    ipcRenderer.invoke('source-clean-cache:store', { input, text }),

  getReportResultCacheStats: (): Promise<ReportResultCacheStats> =>
    ipcRenderer.invoke('report-result-cache:stats'),

  clearReportResultCache: (): Promise<ReportResultCacheStats> =>
    ipcRenderer.invoke('report-result-cache:clear'),

  lookupReportResultCache: (input: ReportResultCacheInput): Promise<ReportResultCacheLookupResult> =>
    ipcRenderer.invoke('report-result-cache:lookup', input),

  storeReportResultCache: (
    input: ReportResultCacheInput,
    snapshot: ReportResultCacheSnapshot
  ): Promise<ReportResultCacheStoreResult> =>
    ipcRenderer.invoke('report-result-cache:store', { input, snapshot }),

  recordCostOptimization: (event: CostOptimizationEvent): Promise<boolean> =>
    ipcRenderer.invoke('cost-optimization:record', event),

  exportMarkdown: (content: string, name: string): Promise<ExportResult> =>
    ipcRenderer.invoke('export:markdown', { content, name }),

  exportDocx: (content: string, name: string): Promise<ExportResult> =>
    ipcRenderer.invoke('export:docx', { content, name }),

  exportHtml: (content: string, name: string): Promise<ExportResult> =>
    ipcRenderer.invoke('export:html', { content, name }),

  /** 发起一次流式对话，返回 { abort } 以便取消 */
  sendChat: (
    messages: ChatMessage[],
    context: ModelTaskContext,
    handlers: ChatHandlers
  ): { abort: () => void } => {
    const id = crypto.randomUUID()
    const channel = `chat:event:${id}`
    const listener = (_e: unknown, ev: ChatStreamEvent): void => {
      if (ev.type === 'chunk') handlers.onChunk?.(ev.delta)
      else if (ev.type === 'usage') handlers.onUsage?.(ev.usage)
      else if (ev.type === 'done') {
        cleanup()
        handlers.onDone?.(ev.full)
      } else if (ev.type === 'error') {
        cleanup()
        handlers.onError?.(ev.message)
      }
    }
    const cleanup = (): void => {
      ipcRenderer.removeListener(channel, listener)
    }
    ipcRenderer.on(channel, listener)
    ipcRenderer.send('chat:start', { id, messages, context })
    return {
      abort: () => {
        ipcRenderer.send('chat:abort', id)
        cleanup()
      }
    }
  }
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
