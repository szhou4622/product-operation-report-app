const { writeFileSync } = require('node:fs')
const { join } = require('node:path')

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

const source = process.env.MANAGED_MODEL_CONFIG_JSON
if (!source) fail('缺少 MANAGED_MODEL_CONFIG_JSON，已停止构建，避免生成无法分析的安装包。')

let config
try {
  config = JSON.parse(source)
} catch {
  fail('MANAGED_MODEL_CONFIG_JSON 不是合法 JSON。')
}

const baseURL = typeof config.baseURL === 'string' ? config.baseURL.trim().replace(/\/+$/, '') : ''
const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : ''
const model = typeof config.model === 'string' ? config.model.trim() : ''
if (!baseURL || !apiKey || !model) fail('内置模型构建配置不完整。')
try {
  const parsed = new URL(baseURL)
  if (parsed.protocol !== 'https:') fail('发布版内置模型地址必须使用 https。')
} catch {
  fail('内置模型构建地址格式不正确。')
}
const name = typeof config.name === 'string' && config.name.trim() ? config.name.trim() : '内置 AI 服务'
const temperature = Number.isFinite(Number(config.temperature)) ? Number(config.temperature) : 0.3
if (baseURL.length > 2048 || apiKey.length > 4096 || model.length > 200 || name.length > 80) {
  fail('内置模型构建配置字段长度异常。')
}
if (temperature < 0 || temperature > 2) fail('内置模型 temperature 必须在 0 到 2 之间。')

const output = {
  version: 1,
  enabled: true,
  name,
  baseURL,
  apiKey,
  model,
  supportsVision: config.supportsVision !== false,
  temperature
}
writeFileSync(join(process.cwd(), 'managed-model.json'), JSON.stringify(output, null, 2), {
  encoding: 'utf8',
  mode: 0o600
})
process.stdout.write('已生成发布用内置模型配置（API Key 未输出）。\n')
