import { app, shell, BrowserWindow, ipcMain, Menu } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import type { AppSettings, ChatMessage, SavedProject, TestModelOptions } from '../shared/types'
import { getActiveProfile, loadSettings, saveSettings } from './settings'
import { chatStream, listModels, testModel } from './model'
import { parseArchive, parseFile } from './ingest'
import { exportDocx, exportHtml, exportMarkdown } from './export'
import { loadLastProject, saveLastProject } from './project'

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: '产品经营报告',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow.show())

  // 输入框右键菜单：剪切 / 复制 / 粘贴 / 全选
  mainWindow.webContents.on('context-menu', (_e, params) => {
    if (params.isEditable) {
      Menu.buildFromTemplate([
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { type: 'separator' },
        { role: 'selectAll' }
      ]).popup({ window: mainWindow })
    } else if (params.selectionText) {
      Menu.buildFromTemplate([{ role: 'copy' }]).popup({ window: mainWindow })
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ---- IPC：设置 ----
ipcMain.handle('settings:get', () => loadSettings())
ipcMain.handle('settings:save', (_e, settings: AppSettings) => saveSettings(settings))

// ---- IPC：项目快照（不包含模型配置 / API Key）----
ipcMain.handle('project:loadLast', () => loadLastProject())
ipcMain.handle('project:saveLast', (_e, project: SavedProject) => saveLastProject(project))

// ---- IPC：测试模型 ----
ipcMain.handle('model:test', (_e, opts: TestModelOptions) => testModel(opts))
ipcMain.handle('model:list', (_e, profile: Parameters<typeof listModels>[0]) => listModels(profile))

// ---- IPC：文件解析 ----
ipcMain.handle('file:parse', (_e, payload: { name: string; data: ArrayBuffer }) =>
  parseFile(payload.name, payload.data)
)
ipcMain.handle('archive:parse', (_e, payload: { name: string; data: ArrayBuffer }) =>
  parseArchive(payload.name, payload.data)
)

// ---- IPC：读取 SOP 规则（SKILL.md）作为系统提示词 ----
function readSopRules(): string {
  const candidates = [
    join(app.getAppPath(), 'assets', 'skill', 'SKILL.md'),
    join(process.resourcesPath || '', 'app.asar.unpacked', 'assets', 'skill', 'SKILL.md'),
    join(__dirname, '../../assets/skill/SKILL.md')
  ]
  for (const p of candidates) {
    try {
      if (existsSync(p)) return readFileSync(p, 'utf8')
    } catch {
      // try next
    }
  }
  return ''
}
ipcMain.handle('sop:rules', () => readSopRules())

// ---- IPC：导出报告 ----
ipcMain.handle('export:markdown', (_e, p: { content: string; name: string }) =>
  exportMarkdown(p.content, p.name)
)
ipcMain.handle('export:docx', (_e, p: { content: string; name: string }) =>
  exportDocx(p.content, p.name)
)
ipcMain.handle('export:html', (_e, p: { content: string; name: string }) =>
  exportHtml(p.content, p.name)
)

// ---- IPC：流式聊天 ----
const inflight = new Map<string, AbortController>()

ipcMain.on(
  'chat:start',
  async (event, payload: { id: string; messages: ChatMessage[] }) => {
    const { id, messages } = payload
    const channel = `chat:event:${id}`
    const profile = getActiveProfile()
    if (!profile) {
      event.sender.send(channel, { type: 'error', message: '未配置模型，请先在设置里添加模型配置。' })
      return
    }
    const controller = new AbortController()
    inflight.set(id, controller)
    await chatStream(
      profile,
      messages,
      (ev) => {
        if (!event.sender.isDestroyed()) event.sender.send(channel, ev)
      },
      controller.signal
    )
    inflight.delete(id)
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

app.whenReady().then(() => {
  setupMenu()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
