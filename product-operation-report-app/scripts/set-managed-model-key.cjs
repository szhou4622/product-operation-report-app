const { app, BrowserWindow, ipcMain, safeStorage } = require('electron')
const { existsSync, readFileSync, renameSync, rmSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const projectDir = join(__dirname, '..')
const outputPath = join(projectDir, 'managed-model.local.json')
const tempPath = `${outputPath}.tmp`
const defaultUserData = join(process.env.APPDATA || '', 'product-operation-report-app')
app.setPath('userData', defaultUserData)

function readJson(path) {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
  } catch {
    return null
  }
}

function loadPublicConfig() {
  const local = readJson(outputPath)
  if (local?.baseURL && local?.model) {
    return {
      ...local,
      fallbackModels: Array.isArray(local.fallbackModels)
        ? local.fallbackModels
        : (String(local.model).toLowerCase() === 'gpt-5.5'
            ? ['claude-sonnet-4-6', 'gemini-3-flash', 'kimi-k2.6']
            : [])
    }
  }

  const settings = readJson(join(defaultUserData, 'settings.json'))
  const profiles = Array.isArray(settings?.profiles) ? settings.profiles : []
  const profile = profiles.find((item) => item.id === settings?.activeProfileId) || profiles[0]
  if (!profile?.baseURL || !profile?.model) return null
  return {
    version: 1,
    enabled: true,
    name: profile.name || '内置 AI 服务',
    baseURL: profile.baseURL,
    model: profile.model,
    supportsVision: profile.supportsVision !== false,
    temperature: profile.temperature ?? 0.3,
    fallbackModels: profile.model.toLowerCase() === 'gpt-5.5'
      ? ['claude-sonnet-4-6', 'gemini-3-flash', 'kimi-k2.6']
      : []
  }
}

function friendlyFailure(status) {
  if (status === 401 || status === 403) return '授权未通过，请确认粘贴的是完整 Key。'
  if (status === 404) return '模型服务没有找到当前模型，请联系开发人员检查。'
  if (status === 429) return '模型服务繁忙或额度不足，请稍后重试。'
  return `模型服务暂时无法使用（HTTP ${status}），旧 Key 未改变。`
}

async function testKey(config, apiKey) {
  const baseURL = String(config.baseURL || '').trim().replace(/\/+$/, '')
  const model = String(config.model || '').trim()
  const parsed = new URL(baseURL)
  if (parsed.protocol !== 'https:') throw new Error('模型服务地址不是安全的 https 地址。')

  const started = Date.now()
  let response
  try {
    response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: '你是连通性测试助手，请简短回复。' },
          { role: 'user', content: '请只回复两个字：可用' }
        ],
        temperature: Number(config.temperature) || 0.3,
        stream: false
      }),
      signal: AbortSignal.timeout(20_000)
    })
  } catch {
    throw new Error('无法连接模型服务，请检查网络后重试；旧 Key 未改变。')
  }
  if (!response.ok) throw new Error(friendlyFailure(response.status))
  const contentType = response.headers.get('content-type') || ''
  if (!contentType.includes('application/json')) {
    throw new Error('模型服务返回格式异常，旧 Key 未改变。')
  }
  const body = await response.json().catch(() => null)
  const reply = body?.choices?.[0]?.message?.content
  if (typeof reply !== 'string' || !reply.trim()) {
    throw new Error('模型已连接但没有返回有效内容，旧 Key 未改变。')
  }
  return Date.now() - started
}

function saveEncryptedConfig(config, apiKey) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('当前系统加密服务不可用，已停止保存。')
  }
  const temperature = Number(config.temperature)
  const output = {
    version: 1,
    enabled: true,
    name: typeof config.name === 'string' && config.name.trim() ? config.name.trim() : '内置 AI 服务',
    baseURL: String(config.baseURL).trim().replace(/\/+$/, ''),
    apiKeyEnc: safeStorage.encryptString(apiKey).toString('base64'),
    model: String(config.model).trim(),
    supportsVision: config.supportsVision !== false,
    temperature: Number.isFinite(temperature) && temperature >= 0 && temperature <= 2 ? temperature : 0.3,
    fallbackModels: Array.isArray(config.fallbackModels) ? config.fallbackModels.slice(0, 3) : []
  }
  try {
    writeFileSync(tempPath, JSON.stringify(output, null, 2), { encoding: 'utf8', mode: 0o600 })
    if (existsSync(outputPath)) rmSync(outputPath, { force: true })
    renameSync(tempPath, outputPath)
  } finally {
    if (existsSync(tempPath)) rmSync(tempPath, { force: true })
  }
}

app.whenReady().then(() => {
  const config = loadPublicConfig()
  if (!config) {
    process.stderr.write('没有找到当前模型地址和模型名称，无法只替换 Key。\n')
    app.exit(1)
    return
  }

  ipcMain.handle('managed-key:public-config', () => ({
    name: config.name || '内置 AI 服务',
    model: config.model
  }))
  ipcMain.handle('managed-key:save', async (_event, rawKey) => {
    const apiKey = typeof rawKey === 'string' ? rawKey.trim() : ''
    if (!apiKey || apiKey.length > 4096) {
      return { ok: false, message: '请输入完整、有效的 API Key。' }
    }
    try {
      const latencyMs = await testKey(config, apiKey)
      saveEncryptedConfig(config, apiKey)
      return { ok: true, message: `连接成功，已使用 Windows 系统加密保存（${latencyMs}ms）。` }
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : '保存失败，旧 Key 未改变。'
      }
    }
  })
  ipcMain.handle('managed-key:close', () => app.quit())

  const window = new BrowserWindow({
    width: 520,
    height: 430,
    minWidth: 480,
    minHeight: 390,
    resizable: false,
    autoHideMenuBar: true,
    title: '更新内置 API Key',
    backgroundColor: '#f5f7fb',
    webPreferences: {
      preload: join(__dirname, 'set-managed-model-key-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  window.setMenu(null)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  void window.loadFile(join(__dirname, 'set-managed-model-key.html'))
  window.on('closed', () => app.quit())
})
