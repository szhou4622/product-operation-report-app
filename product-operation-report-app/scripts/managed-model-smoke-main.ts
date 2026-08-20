import { app } from 'electron'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { getManagedModelState } from '../src/main/managedModel'
import { testModel } from '../src/main/model'

if (process.env.APPDATA) {
  app.setPath('userData', join(process.env.APPDATA, 'product-operation-report-app'))
}

async function run(): Promise<void> {
  const managed = getManagedModelState()
  if (!managed.enabled || !managed.profile || !managed.profiles.length) {
    throw new Error('没有可用的私有内置模型配置。')
  }
  const image = `data:image/png;base64,${readFileSync(join(app.getAppPath(), 'assets', 'product-logo.png')).toString('base64')}`
  let totalLatencyMs = 0
  for (const profile of managed.profiles) {
    const result = await testModel({ profile, withImageDataUrl: image, timeoutMs: 60_000 })
    if (!result.ok) {
      const reason = result.message.replace(/sk-[A-Za-z0-9_-]+/gu, '[secret]').slice(0, 240)
      throw new Error(`内置模型服务未通过连通性检查：${profile.model}；${reason}`)
    }
    totalLatencyMs += result.latencyMs ?? 0
  }
  console.log(`Managed model smoke passed (${managed.profiles.length} vision models; ${totalLatencyMs}ms; secret not rendered).`)
}

void app.whenReady().then(async () => {
  let exitCode = 0
  try {
    await run()
  } catch (error) {
    console.error(error instanceof Error ? error.message : '内置模型服务检查失败。')
    exitCode = 1
  } finally {
    app.exit(exitCode)
  }
})
