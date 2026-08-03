const { app, safeStorage } = require('electron')
const { existsSync, readFileSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const { join } = require('node:path')

const projectDir = join(__dirname, '..')
const repositoryDir = join(projectDir, '..')
const configPath = join(projectDir, 'managed-model.local.json')
const defaultUserData = join(process.env.APPDATA || '', 'product-operation-report-app')
app.setPath('userData', defaultUserData)

function fail(message) {
  process.stderr.write(`${message}\n`)
  app.exit(1)
}

app.whenReady().then(() => {
  try {
    if (!existsSync(configPath)) return fail('没有找到本机内置模型配置。')
    const local = JSON.parse(readFileSync(configPath, 'utf8'))
    if (!safeStorage.isEncryptionAvailable() || typeof local.apiKeyEnc !== 'string') {
      return fail('本机内置 Key 不是可用的系统加密格式。')
    }
    let apiKey = ''
    try {
      apiKey = safeStorage.decryptString(Buffer.from(local.apiKeyEnc, 'base64')).trim()
    } catch {
      return fail('无法解密本机内置 Key。')
    }
    const baseURL = typeof local.baseURL === 'string' ? local.baseURL.trim().replace(/\/+$/, '') : ''
    const model = typeof local.model === 'string' ? local.model.trim() : ''
    if (!apiKey || !baseURL || !model) return fail('本机内置模型配置不完整。')
    const parsed = new URL(baseURL)
    if (parsed.protocol !== 'https:') return fail('发布版内置模型地址必须使用 https。')

    const managedConfig = JSON.stringify({
      version: 1,
      enabled: true,
      name: typeof local.name === 'string' && local.name.trim() ? local.name.trim() : '内置 AI 服务',
      baseURL,
      apiKey,
      model,
      supportsVision: local.supportsVision !== false,
      temperature: Number.isFinite(Number(local.temperature)) ? Number(local.temperature) : 0.3
    })
    apiKey = ''

    const result = spawnSync(
      'gh',
      ['secret', 'set', 'MANAGED_MODEL_CONFIG_JSON', '--app', 'actions'],
      {
        cwd: repositoryDir,
        input: managedConfig,
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      }
    )
    if (result.error || result.status !== 0) {
      return fail('GitHub Actions Secret 写入失败；API Key 未输出。')
    }
    process.stdout.write('GitHub Actions 内置模型 Secret 已安全更新（API Key 未输出）。\n')
    app.exit(0)
  } catch {
    fail('GitHub Actions Secret 写入失败；API Key 未输出。')
  }
})
