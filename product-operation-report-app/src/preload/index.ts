import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppSettings,
  ArchiveItem,
  ActivationResult,
  ActivationStatus,
  ChatMessage,
  ChatStreamEvent,
  ExportResult,
  ModelListResult,
  ModelProfile,
  ParsedFile,
  SavedProject,
  TestModelOptions,
  TestModelResult
} from '../shared/types'

export interface ChatHandlers {
  onChunk?: (delta: string) => void
  onDone?: (full: string) => void
  onError?: (message: string) => void
}

const api = {
  getActivationStatus: (): Promise<ActivationStatus> => ipcRenderer.invoke('activation:status'),

  activate: (code: string): Promise<ActivationResult> =>
    ipcRenderer.invoke('activation:activate', code),

  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),

  saveSettings: (settings: AppSettings): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:save', settings),

  loadLastProject: (): Promise<SavedProject | null> => ipcRenderer.invoke('project:loadLast'),

  saveLastProject: (project: SavedProject): Promise<SavedProject> =>
    ipcRenderer.invoke('project:saveLast', project),

  testModel: (opts: TestModelOptions): Promise<TestModelResult> =>
    ipcRenderer.invoke('model:test', opts),

  listModels: (profile: ModelProfile): Promise<ModelListResult> =>
    ipcRenderer.invoke('model:list', profile),

  parseFile: (name: string, data: ArrayBuffer): Promise<ParsedFile> =>
    ipcRenderer.invoke('file:parse', { name, data }),

  parseArchive: (name: string, data: ArrayBuffer): Promise<ArchiveItem[]> =>
    ipcRenderer.invoke('archive:parse', { name, data }),

  getSopRules: (): Promise<string> => ipcRenderer.invoke('sop:rules'),

  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url),

  exportMarkdown: (content: string, name: string): Promise<ExportResult> =>
    ipcRenderer.invoke('export:markdown', { content, name }),

  exportDocx: (content: string, name: string): Promise<ExportResult> =>
    ipcRenderer.invoke('export:docx', { content, name }),

  exportHtml: (content: string, name: string): Promise<ExportResult> =>
    ipcRenderer.invoke('export:html', { content, name }),

  /** 发起一次流式对话，返回 { abort } 以便取消 */
  sendChat: (messages: ChatMessage[], handlers: ChatHandlers): { abort: () => void } => {
    const id = crypto.randomUUID()
    const channel = `chat:event:${id}`
    const listener = (_e: unknown, ev: ChatStreamEvent): void => {
      if (ev.type === 'chunk') handlers.onChunk?.(ev.delta)
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
    ipcRenderer.send('chat:start', { id, messages })
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
