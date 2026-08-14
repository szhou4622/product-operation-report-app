const { app, safeStorage } = require('electron')
const { existsSync, readFileSync, renameSync, rmSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')

const PLAIN_PREFIX = 'plain:'
const defaultUserData = join(process.env.APPDATA || '', 'product-operation-report-app')
app.setPath('userData', defaultUserData)

function decrypt(value) {
  if (!value) return ''
  if (value.startsWith(PLAIN_PREFIX)) {
    return Buffer.from(value.slice(PLAIN_PREFIX.length), 'base64').toString('utf8')
  }
  if (!safeStorage.isEncryptionAvailable()) return ''
  try {
    return safeStorage.decryptString(Buffer.from(value, 'base64'))
  } catch {
    return ''
  }
}

function fail(message) {
  process.stderr.write(`${message}\n`)
  app.exit(1)
}

app.whenReady().then(() => {
  const settingsPath = process.env.PRODUCT_REPORT_SETTINGS_PATH
    ? resolve(process.env.PRODUCT_REPORT_SETTINGS_PATH)
    : join(defaultUserData, 'settings.json')
  const outputPath = join(process.cwd(), 'managed-model.local.json')
  const tempPath = `${outputPath}.tmp`

  try {
    if (!existsSync(settingsPath)) return fail('没有找到本机原有模型设置，无法导入内置配置。')
    if (existsSync(outputPath) && !process.argv.includes('--force')) {
      return fail('managed-model.local.json 已存在；如需覆盖，请使用 --force。')
    }
    const stored = JSON.parse(readFileSync(settingsPath, 'utf8'))
    const profiles = Array.isArray(stored.profiles) ? stored.profiles : []
    const profile = profiles.find((item) => item.id === stored.activeProfileId) || profiles[0]
    const apiKey = decrypt(profile?.apiKeyEnc || '')
    const baseURL = typeof profile?.baseURL === 'string' ? profile.baseURL.trim().replace(/\/+$/, '') : ''
    const model = typeof profile?.model === 'string' ? profile.model.trim() : ''
    if (!apiKey || !baseURL || !model) return fail('本机原有模型设置不完整或无法解密，请检查当前 Windows 用户。')
    const parsed = new URL(baseURL)
    const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
    if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) {
      return fail('原有模型地址不安全，未生成内置配置。')
    }

    const storedTemperature = Number(profile.temperature)
    const config = {
      version: 1,
      enabled: true,
      name: typeof profile.name === 'string' && profile.name.trim() ? profile.name.trim() : '内置 AI 服务',
      baseURL,
      apiKeyEnc: profile.apiKeyEnc,
      model,
      supportsVision: profile.supportsVision !== false,
      temperature: Number.isFinite(storedTemperature) && storedTemperature >= 0 && storedTemperature <= 2
        ? storedTemperature
        : 0.3,
      fallbackModels: model.toLowerCase() === 'gpt-5.5'
        ? ['claude-sonnet-4-6', 'gemini-3-flash', 'kimi-k2.6']
        : []
    }
    writeFileSync(tempPath, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 })
    if (existsSync(outputPath)) rmSync(outputPath, { force: true })
    renameSync(tempPath, outputPath)
    process.stdout.write('已从本机设置生成加密的私有内置模型配置（API Key 未输出，文件已被 Git 忽略）。\n')
    app.exit(0)
  } catch {
    if (existsSync(tempPath)) rmSync(tempPath, { force: true })
    fail('生成内置模型配置失败；未输出或记录 API Key。')
  }
})
