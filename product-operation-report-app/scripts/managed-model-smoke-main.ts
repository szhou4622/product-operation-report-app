import { app } from 'electron'
import { join } from 'node:path'
import { getManagedModelState } from '../src/main/managedModel'
import { testModel } from '../src/main/model'

if (process.env.APPDATA) {
  app.setPath('userData', join(process.env.APPDATA, 'product-operation-report-app'))
}

async function run(): Promise<void> {
  const managed = getManagedModelState()
  if (!managed.enabled || !managed.profile) {
    throw new Error('没有可用的私有内置模型配置。')
  }
  const result = await testModel({ profile: managed.profile })
  if (!result.ok) throw new Error('内置模型服务未通过连通性检查。')
  console.log(`Managed model smoke passed (${result.latencyMs ?? 0}ms; secret not rendered).`)
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
