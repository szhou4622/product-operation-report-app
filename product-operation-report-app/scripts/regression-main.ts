import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import JSZip from 'jszip'
import Papa from 'papaparse'
import iconv from 'iconv-lite'
import type { SavedProject } from '../src/shared/types'
import { parseArchive, parseFile } from '../src/main/ingest'
import { chatStream, listModels, testModel } from '../src/main/model'
import { loadLastProject, saveLastProject } from '../src/main/project'
import {
  activateWithCode,
  consumeAnalysisCredit,
  getActivationStatus,
  getActivationStatusWithServerCheck
} from '../src/main/activation'
import { ACTIVATION_CODE_HASHES } from '../src/main/activationCodes'
import {
  getActiveProfile,
  loadRendererSettings,
  loadSettings,
  saveRendererSettings,
  saveSettings
} from '../src/main/settings'
import { managedModelInternals } from '../src/main/managedModel'
import { readBundledSopRules } from '../src/main/sopRules'
import { checkForUpdates, compareVersions, downloadUpdate } from '../src/main/updater'
import {
  buildHtmlReportPresentation,
  markdownToHtmlDocument,
  parseHtmlReportModel,
  sanitizeHtmlFragment,
  stripProductVisualBrief
} from '../src/main/htmlReport'
import {
  buildProjectSnapshot,
  friendlyError,
  inspectImageHeader,
  MAX_CLEANING_CONCURRENCY,
  useStore
} from '../src/renderer/src/store'
import type { ChatStreamEvent, ModelProfile } from '../src/shared/types'

const tempUserData = mkdtempSync(join(tmpdir(), 'por-regression-'))
app.setPath('userData', tempUserData)
let topbarAuditWindow: BrowserWindow | null = null

function snapshot(revision: number, reportMarkdown: string): SavedProject {
  return {
    revision,
    sources: [],
    messages: [],
    cleanedData: '',
    cleanDetails: [],
    artifacts: {},
    reportMarkdown,
    reportStale: false,
    phase: reportMarkdown ? 'done' : 'idle',
    steering: '',
    updatedAt: new Date().toISOString()
  }
}

async function testProjectRevisionAndBackup(): Promise<void> {
  await saveLastProject(snapshot(1, '旧报告'))
  await saveLastProject(snapshot(2, ''))
  await saveLastProject(snapshot(1, '迟到的旧快照'))
  assert.equal(loadLastProject()?.revision, 2)
  assert.equal(loadLastProject()?.reportMarkdown, '')

  writeFileSync(join(tempUserData, 'last-project.json'), '{broken', 'utf8')
  assert.equal(loadLastProject()?.revision, 2)
  assert.equal(loadLastProject()?.reportMarkdown, '')

  writeFileSync(join(tempUserData, 'last-project.json'), '{}', 'utf8')
  assert.equal(loadLastProject()?.revision, 2)

  writeFileSync(join(tempUserData, 'last-project.json'), JSON.stringify(snapshot(3, '主文件')), 'utf8')
  writeFileSync(join(tempUserData, 'last-project.json.bak'), JSON.stringify(snapshot(5, '更新备份')), 'utf8')
  assert.equal(loadLastProject()?.revision, 5)
  assert.equal(loadLastProject()?.reportMarkdown, '更新备份')
}

async function testActivationAndSettingsBackup(): Promise<void> {
  const deviceId = getActivationStatus().deviceId
  const activationRecord = {
    version: 1,
    codeHash: ACTIVATION_CODE_HASHES[0],
    deviceId,
    activatedAt: new Date().toISOString()
  }
  writeFileSync(join(tempUserData, 'activation.json'), '{broken', 'utf8')
  writeFileSync(join(tempUserData, 'activation.json.bak'), JSON.stringify(activationRecord), 'utf8')
  const activationStatus = getActivationStatus()
  assert.equal(activationStatus.activated, true)
  assert.equal(activationStatus.appName, 'ProductOperationReport')
  assert.equal(activationStatus.source, 'legacy')
  assert.equal(activationStatus.unlimited, true)
  assert.equal(activationStatus.offline, false)

  const firstSettings = {
    profiles: [{ ...profile, name: '第一配置', apiKey: ' key-one ' }],
    activeProfileId: profile.id,
    projectsDir: '',
    privacyAccepted: true,
    privacyEndpoint: profile.baseURL
  }
  saveSettings(firstSettings)
  saveSettings({
    ...firstSettings,
    profiles: [{ ...profile, name: '第二配置', apiKey: 'key-two' }]
  })
  writeFileSync(join(tempUserData, 'settings.json'), '{broken', 'utf8')
  const recovered = loadSettings()
  assert.equal(recovered.profiles[0]?.name, '第一配置')
  assert.equal(recovered.profiles[0]?.apiKey, 'key-one')

  assert.throws(
    () =>
      saveSettings({
        ...firstSettings,
        profiles: [{ ...profile, baseURL: 'http://remote.example/v1' }]
      }),
    /https/
  )
}

async function testServerActivationAndCredits(): Promise<void> {
  const originalFetch = globalThis.fetch
  const code = 'SERVER-POINTS-TEST-CODE'
  let requestBody: Record<string, unknown> = {}
  try {
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>
      return new Response(JSON.stringify({
        ok: true,
        license: {
          license_id: 'license-test-points',
          license_type: 'credits',
          credits: 100,
          unlimited: false,
          status: 'active'
        },
        message: '激活成功'
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const activated = await activateWithCode(code)
    assert.equal(activated.ok, true)
    assert.equal(activated.status.licenseType, 'credits')
    assert.equal(activated.status.creditsRemaining, 100)
    assert.equal(requestBody.app_name, 'ProductOperationReport')
    assert.equal(requestBody.activation_code, code)
    assert.equal(requestBody.machine_code, activated.status.deviceId)
    assert.equal(typeof requestBody.software_version, 'string')
    assert.equal(typeof requestBody.platform, 'string')
    assert.doesNotMatch(readFileSync(join(tempUserData, 'activation.json'), 'utf8'), new RegExp(code))

    const firstUse = consumeAnalysisCredit('analysis-session-one')
    assert.equal(firstUse.ok, true)
    assert.equal(firstUse.status.creditsRemaining, 99)
    const repeatedUse = consumeAnalysisCredit('analysis-session-one')
    assert.equal(repeatedUse.status.creditsRemaining, 99)

    const refreshed = await getActivationStatusWithServerCheck()
    assert.equal(refreshed.activated, true)
    assert.equal(refreshed.creditsRemaining, 99)
    assert.equal(refreshed.offline, false)

    globalThis.fetch = (async () => { throw new TypeError('network unavailable') }) as typeof fetch
    const offline = await getActivationStatusWithServerCheck()
    assert.equal(offline.activated, true)
    assert.equal(offline.offline, true)

    globalThis.fetch = (async () => new Response(JSON.stringify({
      ok: false,
      error: '激活码已禁用'
    }), { status: 403, headers: { 'content-type': 'application/json' } })) as typeof fetch
    const disabled = await getActivationStatusWithServerCheck()
    assert.equal(disabled.activated, false)
    assert.match(disabled.message || '', /禁用/)
  } finally {
    globalThis.fetch = originalFetch
    const deviceId = getActivationStatus().deviceId
    writeFileSync(join(tempUserData, 'activation.json'), JSON.stringify({
      version: 1,
      codeHash: ACTIVATION_CODE_HASHES[0],
      deviceId,
      activatedAt: new Date().toISOString()
    }), 'utf8')
  }
}

function testUpdateVersionComparison(): void {
  assert.equal(compareVersions('0.3.0', '0.2.5'), 1)
  assert.equal(compareVersions('v1.0.0', '1.0'), 0)
  assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-beta.11'), -1)
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1)
  assert.equal(compareVersions('2.0.0', '10.0.0'), -1)
}

async function testUpdateConfigAndChecksum(): Promise<void> {
  const originalFetch = globalThis.fetch
  const payload = Buffer.from('verified-update-payload', 'utf8')
  const correctChecksum = createHash('sha256').update(payload).digest('hex')
  let requestedUrl = ''
  try {
    globalThis.fetch = (async (input: string | URL | Request) => {
      requestedUrl = String(input)
      return new Response(JSON.stringify({
        app_name: 'ProductOperationReport',
        version: '999.0.0',
        min_supported_version: '998.0.0',
        download_url: { windows_x64: 'https://downloads.example.test/POR-test-update.bin' },
        sha256: { windows_x64: '0'.repeat(64) },
        notes: ['测试更新'],
        force: false
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const forced = await checkForUpdates()
    assert.equal(new URL(requestedUrl).searchParams.get('app_name'), 'ProductOperationReport')
    assert.equal(forced.available, true)
    assert.equal(forced.force, true)
    assert.equal(forced.latestVersion, '999.0.0')

    globalThis.fetch = (async () => {
      const response = new Response(payload, {
        status: 200,
        headers: { 'content-length': String(payload.length) }
      })
      Object.defineProperty(response, 'url', { value: 'https://downloads.example.test/POR-test-update.bin' })
      return response
    }) as typeof fetch
    const rejected = await downloadUpdate()
    assert.equal(rejected.ok, false)
    assert.match(rejected.message, /校验失败/)

    globalThis.fetch = (async () => new Response(JSON.stringify({
      app_name: 'ProductOperationReport',
      version: '999.0.1',
      download_url: { windows_x64: 'https://downloads.example.test/POR-test-update.bin' },
      sha256: { windows_x64: correctChecksum },
      notes: '通过校验',
      force: false
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
    const offered = await checkForUpdates()
    assert.equal(offered.available, true)
    assert.equal(offered.force, false)

    globalThis.fetch = (async () => {
      const response = new Response(payload, {
        status: 200,
        headers: { 'content-length': String(payload.length) }
      })
      Object.defineProperty(response, 'url', { value: 'https://downloads.example.test/POR-test-update.bin' })
      return response
    }) as typeof fetch
    const accepted = await downloadUpdate()
    assert.equal(accepted.ok, true)
    assert.equal(existsSync(accepted.info?.downloadPath || ''), true)

    globalThis.fetch = (async () => new Response('{}', { status: 404 })) as typeof fetch
    const noConfig = await checkForUpdates()
    assert.equal(noConfig.available, false)
  } finally {
    globalThis.fetch = originalFetch
  }
}

function testManagedModelIsolation(): void {
  const secret = 'managed-secret-never-rendered'
  const validConfig = {
    version: 1,
    enabled: true,
    name: '内置 AI 服务',
    baseURL: 'https://managed.example.com/v1/',
    apiKey: secret,
    model: 'managed-model',
    supportsVision: true,
    temperature: 0.3
  }
  const parsed = managedModelInternals.parseConfig(validConfig)
  assert.equal(parsed.enabled, true)
  assert.equal(parsed.profile?.apiKey, secret)
  assert.equal(parsed.profile?.baseURL, 'https://managed.example.com/v1')
  assert.equal(JSON.stringify(parsed.info).includes(secret), false)
  assert.equal(managedModelInternals.parseConfig({ ...validConfig, apiKey: '' }).profile, null)
  assert.equal(managedModelInternals.parseConfig({ ...validConfig, baseURL: 'http://remote.example.com/v1' }).profile, null)
  assert.equal(managedModelInternals.parseConfig({ ...validConfig, enabled: false }).enabled, false)

  process.env.PRODUCT_REPORT_MANAGED_MODEL_CONFIG_JSON = JSON.stringify(validConfig)
  try {
    const rendererSettings = loadRendererSettings()
    assert.equal(rendererSettings.profiles.length, 0)
    assert.equal(rendererSettings.managedModel?.configured, true)
    assert.equal(JSON.stringify(rendererSettings).includes(secret), false)
    assert.equal(getActiveProfile()?.apiKey, secret)

    const saved = saveRendererSettings({
      ...rendererSettings,
      profiles: [
        {
          id: 'injected',
          name: '恶意替换',
          baseURL: 'https://attacker.example.com/v1',
          apiKey: 'attacker-key',
          model: 'attacker-model',
          supportsVision: false
        }
      ],
      activeProfileId: 'injected',
      privacyAccepted: true,
      privacyEndpoint: 'https://attacker.example.com/v1'
    })
    assert.equal(saved.profiles.length, 0)
    assert.equal(saved.privacyEndpoint, 'https://managed.example.com/v1')
    assert.equal(getActiveProfile()?.id, 'managed-model')
  } finally {
    delete process.env.PRODUCT_REPORT_MANAGED_MODEL_CONFIG_JSON
  }
}

async function testSourceInvalidation(): Promise<void> {
  useStore.setState({
    phase: 'checkpoint1',
    sources: [{ id: 'source-1', name: '旧资料.csv', kind: 'table', text: 'a,b' }],
    cleanDetails: [{ id: 'source-1', name: '旧资料.csv', text: '旧清洗结果' }],
    cleanedData: '旧汇总',
    artifacts: { 1: '旧分析' },
    reportMarkdown: '旧报告'
  })
  useStore.getState().removeSource('source-1')
  const state = useStore.getState()
  assert.equal(state.phase, 'idle')
  assert.equal(state.sources.length, 0)
  assert.equal(state.cleanDetails.length, 0)
  assert.equal(state.cleanedData, '')
  assert.equal(state.reportMarkdown, '旧报告')
  assert.equal(state.artifacts[9], '旧报告')
  assert.equal(state.reportStale, true)
}

async function testResetRollbackOnSaveFailure(): Promise<void> {
  let saves = 0
  ;(globalThis as typeof globalThis & { window: unknown }).window = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    api: {
      cancelFileParsing: async () => undefined,
      archiveProject: async (project: SavedProject) => project,
      saveLastProject: async (project: SavedProject) => {
        saves++
        if (saves === 1) throw new Error('simulated save failure')
        return project
      }
    }
  }
  useStore.setState({
    projectRevision: 10,
    persistencePaused: false,
    phase: 'idle',
    sources: [{ id: 'pending', name: 'pending.csv', kind: 'table', parsing: true }],
    messages: [],
    cleanedData: '',
    cleanDetails: [],
    artifacts: { 9: '已完成报告' },
    reportMarkdown: '已完成报告',
    reportStale: false,
    steering: ''
  })
  await assert.rejects(useStore.getState().resetAnalysis(), /simulated save failure/)
  const state = useStore.getState()
  assert.equal(state.sources.length, 1)
  assert.equal(state.sources[0].parsing, false)
  assert.match(state.sources[0].error || '', /中断/)
  assert.equal(state.reportMarkdown, '已完成报告')
  assert.equal(state.projectRevision, 12)
  assert.equal(state.persistencePaused, false)
  assert.equal(saves, 2)
}

async function testZipCannotReturnAfterReset(): Promise<void> {
  let finishArchive!: (items: Array<{ name: string; kind: 'doc'; text: string; ok: true }>) => void
  const archiveResult = new Promise<Array<{ name: string; kind: 'doc'; text: string; ok: true }>>((resolve) => {
    finishArchive = resolve
  })
  ;(globalThis as typeof globalThis & { window: unknown }).window = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    api: {
      parseArchive: () => archiveResult,
      cancelFileParsing: async () => undefined,
      archiveProject: async (project: SavedProject) => project,
      saveLastProject: async (project: SavedProject) => project
    }
  }

  useStore.setState({
    phase: 'idle',
    sources: [],
    messages: [],
    cleanedData: '',
    cleanDetails: [],
    artifacts: {},
    reportMarkdown: '',
    analysisSessionId: crypto.randomUUID()
  })

  const fakeZip = {
    name: 'slow.zip',
    size: 32,
    arrayBuffer: async () => new ArrayBuffer(8)
  }
  const adding = useStore.getState().addSources([fakeZip as File])
  await Promise.resolve()
  await useStore.getState().resetAnalysis()
  finishArchive([{ name: 'old.txt', kind: 'doc', text: '旧内容', ok: true }])
  await adding
  assert.equal(useStore.getState().sources.length, 0)
}

async function testNewAndRestorePreviousAnalysis(): Promise<void> {
  let archived: SavedProject | null = null
  let previous = snapshot(20, '上一份完整报告')
  ;(globalThis as typeof globalThis & { window: unknown }).window = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    api: {
      cancelFileParsing: async () => undefined,
      archiveProject: async (project: SavedProject) => {
        archived = project
        previous = project
        return project
      },
      loadPreviousProject: async () => previous,
      saveLastProject: async (project: SavedProject) => project
    }
  }

  useStore.setState({
    projectRevision: 20,
    persistencePaused: false,
    previousProjectAvailable: false,
    phase: 'done',
    sources: [{ id: 'old', name: '旧资料.csv', kind: 'table', text: 'a,b' }],
    messages: [],
    cleanedData: '旧清洗结果',
    cleanDetails: [],
    artifacts: { 9: '上一份完整报告' },
    reportMarkdown: '上一份完整报告',
    reportStale: false,
    steering: '旧目标',
    analysisSessionId: crypto.randomUUID()
  })

  await useStore.getState().resetAnalysis()
  assert.equal(archived?.reportMarkdown, '上一份完整报告')
  assert.equal(useStore.getState().sources.length, 0)
  assert.equal(useStore.getState().reportMarkdown, '')
  assert.equal(useStore.getState().previousProjectAvailable, true)

  await useStore.getState().restorePreviousAnalysis()
  assert.equal(useStore.getState().sources[0]?.name, '旧资料.csv')
  assert.equal(useStore.getState().reportMarkdown, '上一份完整报告')
  assert.equal(useStore.getState().phase, 'done')
  assert.equal(useStore.getState().previousProjectAvailable, false)
}

async function testIdleGoalAndLateSessionIsolation(): Promise<void> {
  ;(globalThis as typeof globalThis & { window: unknown }).window = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    api: {}
  }
  useStore.setState({
    phase: 'idle',
    messages: [],
    steering: '',
    sources: [],
    cleanedData: '',
    cleanDetails: [],
    artifacts: {},
    reportMarkdown: '',
    reportStale: false,
    abortFn: null
  })
  await useStore.getState().sendMessage('重点分析年轻用户')
  assert.equal(useStore.getState().steering, '重点分析年轻用户')
  assert.match(useStore.getState().messages.at(-1)?.text || '', /已保存/)

  let abortCalls = 0
  ;(globalThis as typeof globalThis & { window: unknown }).window = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    api: {
      sendChat: (
        _messages: unknown,
        handlers: { onError?: (message: string) => void }
      ) => ({
        abort: () => {
          abortCalls++
          handlers.onError?.('已停止')
        }
      }),
      cancelFileParsing: async () => undefined,
      archiveProject: async (project: SavedProject) => project,
      saveLastProject: async (project: SavedProject) => project
    }
  }
  useStore.setState({
    phase: 'checkpoint2',
    messages: [],
    cleanedData: '清洗内容',
    artifacts: { 1: '第一步', 9: '旧报告' },
    reportMarkdown: '旧报告',
    steering: '修订',
    abortFn: null,
    analysisSessionId: crypto.randomUUID()
  })
  const rerun = useStore.getState()._rerunReport()
  await Promise.resolve()
  await useStore.getState().resetAnalysis()
  await rerun
  assert.equal(abortCalls, 1)
  assert.equal(useStore.getState().phase, 'idle')
  assert.equal(useStore.getState().reportMarkdown, '')
  assert.equal(useStore.getState().messages.length, 0)
}

async function testReportRollbackAndExportGuard(): Promise<void> {
  let exportCalls = 0
  ;(globalThis as typeof globalThis & { window: unknown }).window = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    api: {
      sendChat: (_messages: unknown, handlers: { onChunk?: (value: string) => void; onError?: (value: string) => void }) => {
        queueMicrotask(() => {
          handlers.onChunk?.('不完整的新报告')
          handlers.onError?.('模拟中断')
        })
        return { abort: () => undefined }
      },
      exportHtml: async () => {
        exportCalls++
        return { ok: true, path: 'test.html' }
      }
    }
  }

  useStore.setState({
    phase: 'checkpoint2',
    cleanedData: '清洗数据',
    artifacts: { 1: '步骤一', 9: '完整旧报告' },
    reportMarkdown: '完整旧报告',
    steering: '修订要求',
    abortFn: null
  })
  await useStore.getState()._rerunReport()
  assert.equal(useStore.getState().phase, 'checkpoint2')
  assert.equal(useStore.getState().reportMarkdown, '完整旧报告')

  useStore.setState({ phase: 'analyzing', reportMarkdown: '生成中的半成品' })
  await useStore.getState().exportReport('html')
  assert.equal(exportCalls, 0)

  const duringGeneration = buildProjectSnapshot({
    projectRevision: 4,
    sources: [],
    messages: [],
    cleanedData: '清洗数据',
    cleanDetails: [],
    artifacts: { 9: '上一次完整报告' },
    reportMarkdown: '本次只生成了一半',
    reportStale: true,
    phase: 'analyzing',
    steering: ''
  })
  assert.equal(duringGeneration.reportMarkdown, '上一次完整报告')
}

async function testDoubleExportGuard(): Promise<void> {
  let exportCalls = 0
  let finishExport!: () => void
  const pending = new Promise<void>((resolve) => {
    finishExport = resolve
  })
  ;(globalThis as typeof globalThis & { window: unknown }).window = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    api: {
      exportDocx: async () => {
        exportCalls++
        await pending
        return { ok: true, path: 'report.docx' }
      }
    }
  }
  useStore.setState({
    phase: 'done',
    artifacts: { 9: '最终报告' },
    reportMarkdown: '最终报告',
    reportStale: false,
    exportStatus: ''
  })
  const first = useStore.getState().exportReport('docx')
  const second = useStore.getState().exportReport('docx')
  await second
  assert.equal(exportCalls, 1)
  finishExport()
  await first
  assert.match(useStore.getState().exportStatus, /已导出/)
}

async function testFeedbackArrivingDuringRevision(): Promise<void> {
  let calls = 0
  ;(globalThis as typeof globalThis & { window: unknown }).window = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    api: {
      sendChat: (
        _messages: unknown,
        handlers: { onChunk?: (value: string) => void; onDone?: (value: string) => void }
      ) => {
        const call = ++calls
        queueMicrotask(() => {
          handlers.onChunk?.(`第${call}段`)
          if (call === 1) useStore.setState({ steering: '第一条要求\n修订期间的新要求' })
          handlers.onDone?.(`第${call}段`)
        })
        return { abort: () => undefined }
      }
    }
  }
  useStore.setState({
    phase: 'checkpoint2',
    messages: [],
    cleanedData: '清洗内容',
    artifacts: { 1: '第一步', 9: '旧完整报告' },
    reportMarkdown: '旧完整报告',
    reportStale: false,
    steering: '第一条要求',
    abortFn: null,
    analysisSessionId: crypto.randomUUID()
  })
  await useStore.getState()._rerunReport()
  assert.equal(calls, 8)
  assert.equal(useStore.getState().phase, 'checkpoint2')
  assert.match(useStore.getState().reportMarkdown, /第5段/)
  assert.equal(useStore.getState().artifacts[9], useStore.getState().reportMarkdown)
}

const profile: ModelProfile = {
  id: 'test',
  name: '测试模型',
  baseURL: 'https://example.invalid/v1',
  apiKey: 'secret',
  model: 'test-model',
  supportsVision: false
}

function responseStream(chunks: string[], contentType = 'text/event-stream'): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      }
    }),
    { headers: { 'content-type': contentType } }
  )
}

async function testStrictModelCompletion(): Promise<void> {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }), {
        headers: { 'content-type': 'application/json' }
      })) as typeof fetch
    const empty = await testModel({ profile })
    assert.equal(empty.ok, false)
    assert.match(empty.message, /没有返回文字/)

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '半截' }, finish_reason: 'length' }] }), {
        headers: { 'content-type': 'application/json' }
      })) as typeof fetch
    const truncated = await testModel({ profile })
    assert.equal(truncated.ok, false)
    assert.match(truncated.message, /不完整/)

    const normalEvents: ChatStreamEvent[] = []
    globalThis.fetch = (async () =>
      responseStream([
        'data: {"choices":[{"delta":{"content":"完"}}]}\n',
        '\ndata: {"choices":[{"delta":{"content":"整"},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n'
      ])) as typeof fetch
    await chatStream(profile, [{ role: 'user', content: '测试' }], (event) => normalEvents.push(event))
    assert.equal(normalEvents.at(-1)?.type, 'done')
    assert.equal(normalEvents.at(-1)?.type === 'done' ? normalEvents.at(-1)?.full : '', '完整')

    const earlyEofEvents: ChatStreamEvent[] = []
    globalThis.fetch = (async () =>
      responseStream(['data: {"choices":[{"delta":{"content":"半截"}}]}\n\n'])) as typeof fetch
    await chatStream(profile, [{ role: 'user', content: '测试' }], (event) => earlyEofEvents.push(event))
    assert.equal(earlyEofEvents.at(-1)?.type, 'error')
    assert.match(earlyEofEvents.at(-1)?.type === 'error' ? earlyEofEvents.at(-1)?.message || '' : '', /提前结束/)

    const lengthEvents: ChatStreamEvent[] = []
    globalThis.fetch = (async () =>
      responseStream([
        'data: {"choices":[{"delta":{"content":"半截"}}]}\n\n',
        'data: {"choices":[{"finish_reason":"length"}]}\n\n'
      ])) as typeof fetch
    await chatStream(profile, [{ role: 'user', content: '测试' }], (event) => lengthEvents.push(event))
    assert.equal(lengthEvents.at(-1)?.type, 'error')
    assert.match(lengthEvents.at(-1)?.type === 'error' ? lengthEvents.at(-1)?.message || '' : '', /长度上限/)

    const malformedEvents: ChatStreamEvent[] = []
    globalThis.fetch = (async () =>
      responseStream([
        'data: {"choices":[{"delta":{"content":"半截"}}]}\n\n',
        'data: {broken-json}\n\n',
        'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n'
      ])) as typeof fetch
    await chatStream(profile, [{ role: 'user', content: '测试' }], (event) => malformedEvents.push(event))
    assert.equal(malformedEvents.at(-1)?.type, 'error')
    assert.match(malformedEvents.at(-1)?.type === 'error' ? malformedEvents.at(-1)?.message || '' : '', /损坏/)

    const rateLimitEvents: ChatStreamEvent[] = []
    globalThis.fetch = (async () =>
      new Response('{"error":"busy"}', {
        status: 429,
        statusText: 'Too Many Requests',
        headers: { 'retry-after': '2' }
      })) as typeof fetch
    await chatStream(profile, [{ role: 'user', content: '测试' }], (event) => rateLimitEvents.push(event))
    assert.equal(rateLimitEvents.at(-1)?.type, 'error')
    assert.match(rateLimitEvents.at(-1)?.type === 'error' ? rateLimitEvents.at(-1)?.message || '' : '', /等待 2 秒/)

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ data: Array.from({ length: 650 }, (_, index) => ({ id: `model-${index}` })) }),
        { headers: { 'content-type': 'application/json' } }
      )) as typeof fetch
    const models = await listModels(profile)
    assert.equal(models.ok, true)
    assert.equal(models.models?.length, 500)
  } finally {
    globalThis.fetch = originalFetch
  }
}

async function testCsvAndArchiveGuards(): Promise<void> {
  assert.equal(MAX_CLEANING_CONCURRENCY, 4)
  const csv = 'name,comment\nA,"foo,bar"\n'
  const csvBuffer = Buffer.from(csv)
  const parsed = await parseFile(
    'quoted.csv',
    csvBuffer.buffer.slice(csvBuffer.byteOffset, csvBuffer.byteOffset + csvBuffer.byteLength) as ArrayBuffer
  )
  assert.equal(parsed.ok, true)
  const reparsed = Papa.parse<string[]>(parsed.text).data as string[][]
  assert.deepEqual(reparsed[1], ['A', 'foo,bar'])

  const gb18030 = iconv.encode('姓名,备注\n张三,"你好,世界"\n一,业务和丝\n', 'gb18030')
  const gbParsed = await parseFile(
    'gb18030.csv',
    gb18030.buffer.slice(gb18030.byteOffset, gb18030.byteOffset + gb18030.byteLength) as ArrayBuffer
  )
  assert.equal(gbParsed.ok, true)
  assert.match(gbParsed.text, /张三/)
  assert.match(gbParsed.text, /你好,世界/)
  assert.match(gbParsed.text, /一,"?业务和丝"?/)

  const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('标题\t内容\n一\t你好', 'utf16le')])
  const utf16Parsed = await parseFile(
    'utf16.txt',
    utf16le.buffer.slice(utf16le.byteOffset, utf16le.byteOffset + utf16le.byteLength) as ArrayBuffer
  )
  assert.equal(utf16Parsed.ok, true)
  assert.match(utf16Parsed.text, /你好/)

  const utf16WithoutBom = Buffer.from('name,内容\nA,你好\n', 'utf16le')
  const utf16WithoutBomParsed = await parseFile(
    'utf16-no-bom.csv',
    utf16WithoutBom.buffer.slice(
      utf16WithoutBom.byteOffset,
      utf16WithoutBom.byteOffset + utf16WithoutBom.byteLength
    ) as ArrayBuffer
  )
  assert.equal(utf16WithoutBomParsed.ok, true)
  assert.match(utf16WithoutBomParsed.text, /你好/)

  const malformed = Buffer.from('name,comment\nA,"没有结束\n', 'utf8')
  const malformedParsed = await parseFile(
    'malformed.csv',
    malformed.buffer.slice(malformed.byteOffset, malformed.byteOffset + malformed.byteLength) as ArrayBuffer
  )
  assert.equal(malformedParsed.ok, false)
  assert.match(malformedParsed.error || '', /CSV/)

  const wrongColumns = Buffer.from('a,b\n1,2,3\n', 'utf8')
  const wrongColumnsParsed = await parseFile(
    'wrong-columns.csv',
    wrongColumns.buffer.slice(wrongColumns.byteOffset, wrongColumns.byteOffset + wrongColumns.byteLength) as ArrayBuffer
  )
  assert.equal(wrongColumnsParsed.ok, true)
  assert.match(wrongColumnsParsed.warning || '', /自动兼容/)
  const preservedWrongColumns = Papa.parse<string[]>(wrongColumnsParsed.text).data as string[][]
  assert.deepEqual(preservedWrongColumns[1], ['1', '2', '3'])

  const line678Rows = ['a,b']
  for (let index = 2; index <= 677; index++) line678Rows.push(`${index},正常`)
  line678Rows.push('678,备注里多出的内容,仍需保留')
  const line678 = Buffer.from(line678Rows.join('\n'), 'utf8')
  const line678Parsed = await parseFile(
    '第678行错列.csv',
    line678.buffer.slice(line678.byteOffset, line678.byteOffset + line678.byteLength) as ArrayBuffer
  )
  assert.equal(line678Parsed.ok, true)
  assert.match(line678Parsed.warning || '', /第 678 行/)
  assert.match(line678Parsed.text, /仍需保留/)

  const missingTail = Buffer.from('a,b,c\n1,2\n', 'utf8')
  const missingTailParsed = await parseFile(
    '缺少尾列.csv',
    missingTail.buffer.slice(missingTail.byteOffset, missingTail.byteOffset + missingTail.byteLength) as ArrayBuffer
  )
  assert.equal(missingTailParsed.ok, true)
  const paddedRows = Papa.parse<string[]>(missingTailParsed.text).data as string[][]
  assert.deepEqual(paddedRows[1], ['1', '2', ''])

  const zip = new JSZip()
  zip.file('high-ratio.txt', '0'.repeat(2 * 1024 * 1024))
  const zipped = await zip.generateAsync({
    type: 'arraybuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 }
  })
  const archive = await parseArchive('high-ratio.zip', zipped)
  assert.equal(archive[0]?.ok, false)
  assert.match(archive[0]?.error || '', /压缩比异常/)

  const duplicateNames = new JSZip()
  duplicateNames.file('文件夹A/同名.txt', 'A')
  duplicateNames.file('文件夹B/同名.txt', 'B')
  const duplicateBytes = await duplicateNames.generateAsync({ type: 'arraybuffer' })
  const duplicateArchive = await parseArchive('同名.zip', duplicateBytes)
  assert.deepEqual(
    duplicateArchive.map((item) => item.name).sort(),
    ['文件夹A/同名.txt', '文件夹B/同名.txt']
  )

  const officeBomb = new JSZip()
  officeBomb.file('xl/worksheets/sheet1.xml', '0'.repeat(2 * 1024 * 1024))
  const officeBytes = await officeBomb.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 }
  })
  const officeParsed = await parseFile(
    'unsafe.xlsx',
    officeBytes.buffer.slice(officeBytes.byteOffset, officeBytes.byteOffset + officeBytes.byteLength) as ArrayBuffer
  )
  assert.equal(officeParsed.ok, false)
  assert.match(officeParsed.error || '', /压缩比例异常/)
}

async function testFileCountGuard(): Promise<void> {
  ;(globalThis as typeof globalThis & { window: unknown }).window = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    api: {
      parseFile: async (name: string) => ({ name, kind: 'doc', text: 'ok', ok: true })
    }
  }
  useStore.setState({
    phase: 'idle',
    sources: [],
    messages: [],
    artifacts: {},
    reportMarkdown: '',
    cleanedData: '',
    cleanDetails: [],
    reportStale: false,
    analysisSessionId: crypto.randomUUID()
  })
  const files = Array.from({ length: 201 }, (_, index) => ({
    name: `资料-${index}.txt`,
    size: 2,
    arrayBuffer: async () => new TextEncoder().encode('ok').buffer
  })) as unknown as File[]
  await useStore.getState().addSources(files)
  assert.equal(useStore.getState().sources.length, 200)
  assert.match(useStore.getState().messages[0]?.text || '', /最多保留 200/)
}

async function testZipExpansionGlobalCountGuard(): Promise<void> {
  ;(globalThis as typeof globalThis & { window: unknown }).window = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    api: {
      parseArchive: async (name: string) =>
        Array.from({ length: 120 }, (_, index) => ({
          name: `${name}/资料-${index}.txt`,
          kind: 'doc' as const,
          size: 2,
          text: 'ok',
          ok: true
        }))
    }
  }
  useStore.setState({
    phase: 'idle',
    sources: [],
    messages: [],
    artifacts: {},
    reportMarkdown: '',
    cleanedData: '',
    cleanDetails: [],
    reportStale: false,
    analysisSessionId: crypto.randomUUID()
  })
  const zips = ['一.zip', '二.zip'].map((name) => ({
    name,
    size: 10,
    arrayBuffer: async () => new ArrayBuffer(8)
  })) as unknown as File[]
  await useStore.getState().addSources(zips)
  assert.equal(useStore.getState().sources.length, 200)
  assert.equal(useStore.getState().sources.filter((source) => /数量提示/.test(source.name)).length, 1)
}

async function testPrivacyMustMatchEndpoint(): Promise<void> {
  let chatCalls = 0
  ;(globalThis as typeof globalThis & { window: unknown }).window = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    api: {
      sendChat: () => {
        chatCalls++
        return { abort: () => undefined }
      }
    }
  }
  useStore.setState({
    settings: {
      profiles: [profile],
      activeProfileId: profile.id,
      projectsDir: '',
      privacyAccepted: true,
      privacyEndpoint: 'https://old.example/v1'
    },
    phase: 'idle',
    sources: [{ id: 'safe', name: '自有资料.txt', kind: 'doc', text: '内容', attribution: '自有数据' }],
    messages: [],
    cleanedData: '',
    cleanDetails: [],
    artifacts: {},
    reportMarkdown: '',
    reportStale: false
  })
  await useStore.getState().startGeneration()
  assert.equal(chatCalls, 0)
  assert.equal(useStore.getState().phase, 'idle')
  assert.match(useStore.getState().messages.at(-1)?.text || '', /隐私确认/)
}

function makePng(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 13)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

function makeWebp(type: 'VP8 ' | 'VP8L' | 'VP8X', payload: Uint8Array): Uint8Array {
  const padded = payload.length + (payload.length & 1)
  const bytes = new Uint8Array(20 + padded)
  bytes.set([0x52, 0x49, 0x46, 0x46])
  new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true)
  bytes.set([0x57, 0x45, 0x42, 0x50], 8)
  bytes.set(Array.from(type).map((char) => char.charCodeAt(0)), 12)
  new DataView(bytes.buffer).setUint32(16, payload.length, true)
  bytes.set(payload, 20)
  return bytes
}

function makeGif(twoFrames = false): Uint8Array {
  const header = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x02, 0x00, 0x03, 0x00, 0x00, 0x00, 0x00]
  const frame = [
    0x2c,
    0x00,
    0x00,
    0x00,
    0x00,
    0x02,
    0x00,
    0x03,
    0x00,
    0x00,
    0x02,
    0x02,
    0x44,
    0x01,
    0x00
  ]
  return Uint8Array.from([...header, ...frame, ...(twoFrames ? frame : []), 0x3b])
}

async function testImageHeaderGuards(): Promise<void> {
  assert.deepEqual(inspectImageHeader(makePng(1600, 900)), {
    format: 'png',
    width: 1600,
    height: 900,
    frames: 1
  })
  assert.throws(() => inspectImageHeader(makePng(10_001, 1)), /像素尺寸过大/)
  const apng = new Uint8Array(53)
  apng.set(makePng(100, 100))
  const apngView = new DataView(apng.buffer)
  apngView.setUint32(33, 8)
  apng.set([0x61, 0x63, 0x54, 0x4c], 37)
  apngView.setUint32(41, 2)
  apngView.setUint32(45, 0)
  assert.throws(() => inspectImageHeader(apng), /动态 PNG/)

  const vp8 = new Uint8Array(10)
  vp8.set([0x9d, 0x01, 0x2a], 3)
  new DataView(vp8.buffer).setUint16(6, 640, true)
  new DataView(vp8.buffer).setUint16(8, 360, true)
  assert.equal(inspectImageHeader(makeWebp('VP8 ', vp8)).width, 640)
  assert.equal(inspectImageHeader(makeWebp('VP8 ', vp8)).height, 360)

  const vp8l = new Uint8Array(5)
  vp8l[0] = 0x2f
  const packed = (319 | (239 << 14)) >>> 0
  new DataView(vp8l.buffer).setUint32(1, packed, true)
  assert.equal(inspectImageHeader(makeWebp('VP8L', vp8l)).width, 320)
  assert.equal(inspectImageHeader(makeWebp('VP8L', vp8l)).height, 240)

  const truncatedWebp = makeWebp('VP8L', vp8l)
  new DataView(truncatedWebp.buffer).setUint32(4, truncatedWebp.length + 20, true)
  assert.throws(() => inspectImageHeader(truncatedWebp), /结构不完整/)

  const animated = new Uint8Array(10)
  animated[0] = 0x02
  assert.throws(() => inspectImageHeader(makeWebp('VP8X', animated)), /动态 WebP/)
  assert.throws(() => inspectImageHeader(makeWebp('VP8X', new Uint8Array(10))), /没有可读取的静态画面/)

  const mismatchedWebp = new Uint8Array(48)
  mismatchedWebp.set([0x52, 0x49, 0x46, 0x46])
  const mismatchView = new DataView(mismatchedWebp.buffer)
  mismatchView.setUint32(4, mismatchedWebp.length - 8, true)
  mismatchedWebp.set([0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58], 8)
  mismatchView.setUint32(16, 10, true)
  mismatchedWebp.set([0x56, 0x50, 0x38, 0x20], 30)
  mismatchView.setUint32(34, 10, true)
  mismatchedWebp.set([0x9d, 0x01, 0x2a], 41)
  mismatchView.setUint16(44, 2, true)
  mismatchView.setUint16(46, 3, true)
  assert.throws(() => inspectImageHeader(mismatchedWebp), /画布尺寸与实际画面不一致/)

  assert.equal(inspectImageHeader(makeGif()).frames, 1)
  assert.throws(() => inspectImageHeader(makeGif(true)), /动态 GIF/)
  const oversizedGifFrame = makeGif()
  new DataView(oversizedGifFrame.buffer).setUint16(18, 10_001, true)
  assert.throws(() => inspectImageHeader(oversizedGifFrame), /像素尺寸过大/)

  const jpeg = Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x07,
    0x08,
    0x01,
    0x2c,
    0x02,
    0x58,
    0xff,
    0xd9
  ])
  assert.deepEqual(inspectImageHeader(jpeg), {
    format: 'jpeg',
    width: 600,
    height: 300,
    frames: 1
  })
}

async function testBulkAttributionAndExportOpen(): Promise<void> {
  useStore.setState({
    phase: 'idle',
    sources: [
      { id: 'blank', name: '资料一.csv', kind: 'table', text: 'a,b' },
      {
        id: 'chosen',
        name: '竞品.csv',
        kind: 'table',
        text: 'a,b',
        attribution: '竞品数据'
      },
      { id: 'failed', name: '坏文件.pdf', kind: 'doc', error: '文件损坏' }
    ],
    cleanDetails: [{ id: 'blank', name: '资料一.csv', text: '旧清洗' }],
    cleanedData: '旧清洗',
    artifacts: { 9: '已完成报告' },
    reportMarkdown: '已完成报告',
    reportStale: false
  })
  useStore.getState().setUnconfirmedAttribution('自有数据')
  const afterBulk = useStore.getState()
  assert.equal(afterBulk.sources.find((source) => source.id === 'blank')?.attribution, '自有数据')
  assert.equal(afterBulk.sources.find((source) => source.id === 'chosen')?.attribution, '竞品数据')
  assert.equal(afterBulk.sources.find((source) => source.id === 'failed')?.attribution, undefined)
  assert.equal(afterBulk.cleanDetails.length, 0)
  assert.equal(afterBulk.reportMarkdown, '已完成报告')
  assert.equal(afterBulk.reportStale, true)

  let opened = ''
  let shown = ''
  ;(globalThis as typeof globalThis & { window: unknown }).window = {
    api: {
      exportDocx: async () => ({ ok: true, path: 'D:\\报告\\产品经营报告.docx' }),
      openPath: async (path: string) => {
        opened = path
      },
      showItemInFolder: async (path: string) => {
        shown = path
      }
    }
  }
  useStore.setState({
    phase: 'done',
    artifacts: { 9: '已完成报告' },
    reportMarkdown: '已完成报告',
    reportStale: false,
    exportStatus: '',
    lastExportPath: ''
  })
  await useStore.getState().exportReport('docx')
  assert.equal(useStore.getState().lastExportPath, 'D:\\报告\\产品经营报告.docx')
  await useStore.getState().openLastExport()
  await useStore.getState().showLastExportInFolder()
  assert.equal(opened, 'D:\\报告\\产品经营报告.docx')
  assert.equal(shown, 'D:\\报告\\产品经营报告.docx')
}

function testExportButtonContract(): void {
  const component = readFileSync(
    join(process.cwd(), 'src', 'renderer', 'src', 'components', 'ReportPreview.tsx'),
    'utf8'
  )
  const htmlIndex = component.indexOf('导出 HTML')
  const mdIndex = component.indexOf('导出 MD')
  const wordIndex = component.indexOf('导出 Word')
  assert.ok(htmlIndex >= 0 && htmlIndex < mdIndex && mdIndex < wordIndex)
  assert.equal(component.includes('export-more'), false)
  assert.equal(component.includes('其他格式'), false)
}

async function testWorkbenchTopbarContract(): Promise<void> {
  const appComponent = readFileSync(
    join(process.cwd(), 'src', 'renderer', 'src', 'App.tsx'),
    'utf8'
  )
  const expectedGuideUrl =
    'https://my.feishu.cn/docx/BTSjddkiXo2IGKxiDCJcTM1qnCe?from=from_copylink'
  assert.ok(appComponent.includes(expectedGuideUrl))
  assert.equal(appComponent.includes('FU5FdRkHFoNH7JxUp6wciLksnEe'), false)

  const styles = readFileSync(
    join(process.cwd(), 'src', 'renderer', 'src', 'styles.css'),
    'utf8'
  ).replace(/<\/style/gi, '<\\/style')
  const htmlPath = join(tempUserData, 'topbar-layout.html')
  writeFileSync(
    htmlPath,
    `<!doctype html><html><head><meta charset="UTF-8"><style>${styles}</style></head><body>
      <div class="app">
        <div class="topbar">
          <div class="brand">
            <span class="brand-mark"></span>
            <span class="brand-copy">
              <span class="brand-main">产品经营报告</span>
              <span class="sub">专业的产品经营分析与报告系统</span>
            </span>
          </div>
          <a class="tutorial-link" href="${expectedGuideUrl}">
            <span class="tutorial-icon"></span>
            <span class="tutorial-copy">
              <span class="tutorial-title">使用教程</span>
              <span class="tutorial-subtitle">新手操作指南</span>
            </span>
            <span class="tutorial-external"></span>
          </a>
          <div class="right">
            <span class="model-pill">模型：ai英雄会（gpt-5.5）</span>
            <button class="btn new-analysis-button"><span class="new-analysis-icon">＋</span><span>新建分析</span></button>
            <button class="btn restore-analysis-button">恢复上一份</button>
            <span class="app-version">v0.2.3</span>
            <button class="btn">设置</button>
          </div>
        </div>
      </div>
    </body></html>`,
    'utf8'
  )

  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 180,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: 'topbar-layout-audit'
    }
  })
  topbarAuditWindow = window
  try {
    await window.loadFile(htmlPath)
    for (const width of [880, 960, 1005, 1120, 1280, 1536, 1600]) {
      window.setContentSize(width, 180)
      let layout: {
        innerWidth: number
        scrollWidth: number
        brand: { left: number; right: number; width: number } | null
        tutorial: { left: number; right: number; width: number } | null
        actions: { left: number; right: number; width: number } | null
        modelDisplay: string
      }
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 50))
        layout = (await window.webContents.executeJavaScript(
          `(() => {
            const rect = (selector) => {
              const element = document.querySelector(selector)
              if (!(element instanceof HTMLElement)) return null
              const box = element.getBoundingClientRect()
              return { left: box.left, right: box.right, width: box.width }
            }
            const model = document.querySelector('.model-pill')
            return {
              innerWidth: window.innerWidth,
              scrollWidth: document.documentElement.scrollWidth,
              brand: rect('.brand'),
              tutorial: rect('.tutorial-link'),
              actions: rect('.topbar .right'),
              modelDisplay: model instanceof HTMLElement ? getComputedStyle(model).display : ''
            }
          })()`
        )) as typeof layout
        if (layout.innerWidth === width) break
      }
      layout ??= {
        innerWidth: -1,
        scrollWidth: -1,
        brand: null,
        tutorial: null,
        actions: null,
        modelDisplay: ''
      }
      assert.equal(layout.innerWidth, width)
      assert.ok(layout.scrollWidth <= layout.innerWidth, `${width}px 顶栏出现横向滚动`)
      assert.ok(layout.brand && layout.tutorial && layout.actions)
      assert.ok(
        layout.brand!.right + 8 <= layout.tutorial!.left,
        `${width}px 品牌区与教程入口重叠`
      )
      assert.ok(
        layout.tutorial!.right + 8 <= layout.actions!.left,
        `${width}px 教程入口与操作区重叠`
      )
      assert.equal(layout.modelDisplay !== 'none', width >= 1536)
    }
  } catch (error) {
    if (!window.isDestroyed()) window.destroy()
    topbarAuditWindow = null
    throw error
  }
}

const HTML_REPORT_FIXTURE = `# 盐中甜酸菜 产品经营报告
生成日期：2026-07-27
<!-- Product visual brief
role: 家庭日常快速配餐
audience: 需要直接、可信表达的家庭主理人
scene: 工作日晚餐和早餐配餐
value-signal: practicality
trust-model: visible-use
design-direction: household-field-guide
evidence-confidence: confirmed
-->

## 0. 结论先行
这是一个面向家庭日常快速配餐的产品，经营上应优先讲清方便、真实吃法和复购理由。

| 优先级 | 核心人群 | 关键判断 |
|---|---|---|
| P0 | 31-45 岁家庭主理人 | 晚餐配菜和早餐配餐需求明确 |
| P1 | 50 岁以上家庭用户 | 更重视口味熟悉和使用方便 |

## 1. 数据来源与使用范围
| 数据类型 | 来源 | 本次用途 |
|---|---|---|
| 成交人群 | 视频号截图 | 判断家庭人群 |
| 购买画像 | 巨量云图 | 判断年龄结构 |

## 2. 产品基础信息
| 模块 | 当前判断 |
|---|---|
| 产品名称 / 类目 | 盐中甜酸菜 / 佐餐食品 |
| 核心成交规模 | GMV 128.6万元 |
| 当前客单 | 79元 |
| 主要使用场景 | 早餐、晚餐、家庭囤货 |

## 3. 一方数据核心判断
### 3.1 视频号成交人群
| 维度 | 关键数据 | 经营含义 |
|---|---|---|
| 女性 | 67.4% | 家庭主理人是重点 |
| 31-45 岁 | 48.2% | 处于家庭餐食决策阶段 |

### 3.2 云图购买画像
| 维度 | 关键数据 | 经营含义 |
|---|---|---|
| 小镇中年 | 32.1% | 关注熟悉口味 |
| 都市银发 | 21.6% | 关注方便与可信 |

### 重复标题
同名标题第一次。
### 重复标题
同名标题第二次。

## 4. 竞品与素材打法判断
### 4.1 自有爆款素材结构
| 指标 | 结果 |
|---|---|
| 场景开头 | 45% |
| 口味展示 | 35% |
| 机制收口 | 20% |

### 4.2 竞品素材结构
| 竞品开头 | 打法本质 | 我方可迁移方向 |
|---|---|---|
| 今天晚饭不知道吃什么 | 场景切入 | 家庭快餐场景 |

## 5. 产品全量卖点拆解
| 卖点维度 | 我方产品卖点 | 用户能感知的好处 |
|---|---|---|
| 产品包装 | 小袋分装 | 开袋方便 |
| 价格 | 需补充 | 需补充 |
| 场景 | 家庭佐餐 | 不用临时准备复杂配菜 |

## 6. 卖点用户视角排序
| 排序 | 用户视角卖点 | 对应产品事实 | 打动的人群/场景 | 作用 |
|---|---|---|---|---|
| 1 | 开袋就能配饭 | 小袋分装 | 工作日晚餐 | 转化钩子 |
| 2 | 熟悉口味更安心 | 原料和口味资料 | 家庭复购 | 信任支撑 |

## 7. 核心成交人群画像与卖点场景匹配
一句话总判断：家庭餐食决策者是当前主力。

| 优先级 | 成交人群 | 数据依据/特征 | 核心卖点 | 核心场景 | 内容语言 |
|---|---|---|---|---|---|
| 第一主力 | 31-45 岁已育女性/家庭主理人 | 视频号女性 67.4% | 开袋方便 | 工作日晚餐 | 直接展示吃法 |
| 第二承接 | 50+ 家庭用户 | 银发 21.6% | 熟悉口味 | 早餐佐餐 | 真实、易懂 |

## 8. 视频号内容主线设计
| 内容主线 | 数据/分析依据 | 对应人群 | 对应卖点 | 核心场景 | 内容表达 | 作用 |
|---|---|---|---|---|---|---|
| 家庭快餐 | 视频号画像 | 家庭主理人 | 方便 | 晚餐 | 实拍吃法 | 主转化 |
| 熟悉口味 | 银发画像 | 50+ 家庭用户 | 口味 | 早餐 | 用户体验 | 信任 |
| 囤货机制 | 复购场景 | 家庭用户 | 规格 | 囤货 | 机制解释 | 收口 |

建议内容体量：

| 内容主线 | 建议占比 | 原因 |
|---|---|---|
| 家庭快餐 | 50% | 主需求 |
| 熟悉口味 | 30% | 信任 |
| 囤货机制 | 20% | 转化 |

## 9. 内容执行方向
### 9.1 第一轮建议选题
| 脚本编号 | 内容主线 | 选题 | 视频分类 | 视角 | 人群 | 场景 | 开头类型 | 3 秒开头来源 | 参考视频结构 | 优先级 |
|---|---|---|---|---|---|---|---|---|---|---|
| S01 | 家庭快餐 | 下班十分钟开饭 | 3.1 | 用户 | 家庭主理人 | 晚餐 | 场景 | 自有素材A | 场景-吃法-产品 | P0 |
| S02 | 熟悉口味 | 爸妈早餐怎么配 | 3.2 | 专业 | 50+ 家庭用户 | 早餐 | 痛点 | 自有素材B | 痛点-展示-证据 | P0 |
| S03 | 囤货机制 | 家庭一周怎么备 | 3.99 | 商家 | 家庭用户 | 囤货 | 机制 | 自有素材C | 规格-场景-机制 | P1 |

### 9.2 3 秒开头库
| 开头类型 | 可直接复用的原始开头 |
|---|---|
| 场景 | 今天晚饭不知道吃什么 |

## 10. 经营建议
1. 优先制作家庭晚餐场景素材。
2. 用真实吃法补足信任证据。
3. 补齐价格与规格机制。

## 11. 本次报告的限制
- 价格机制仍需品牌确认。
- 部分素材缺少完整成交字段。
- 超长字段测试：这是一段用于验证小屏幕自动换行且不会把页面撑出横向滚动的中文长文本这是一段用于验证小屏幕自动换行且不会把页面撑出横向滚动的中文长文本。

<script>alert("bad")</script>
<img src="https://example.com/tracker.png" onerror="alert(1)">
> (注：内容由 AI 生成，请谨慎参考）`

async function testHtmlReportRenderer(): Promise<void> {
  const model = parseHtmlReportModel(HTML_REPORT_FIXTURE)
  assert.equal(model.sections.length, 12)
  assert.deepEqual(model.sections.map((section) => section.number), [
    '0',
    '1',
    '2',
    '3',
    '4',
    '5',
    '6',
    '7',
    '8',
    '9',
    '10',
    '11'
  ])
  assert.equal(model.brief.designDirection, 'household-field-guide')
  assert.equal(model.brief.evidenceConfidence, 'confirmed')
  const presentation = buildHtmlReportPresentation(model)
  assert.ok(presentation.mainMetric)
  assert.match(presentation.mainMetric?.label || '', /女性占比/)
  for (const metric of [presentation.mainMetric, ...presentation.supportingSignals]) {
    if (!metric) continue
    const source = metric.source
    assert.notEqual(source.tableIndex, null)
    assert.notEqual(source.rowIndex, null)
    assert.notEqual(source.columnIndex, null)
    assert.equal(
      model.sections
        .find((section) => section.number === source.sectionNumber)
        ?.tables[source.tableIndex!]?.rows[source.rowIndex!]?.[source.columnIndex!],
      source.rawValue
    )
  }
  for (const sectionPlan of presentation.sections) {
    const section = model.sections.find((candidate) => candidate.number === sectionPlan.sectionNumber)
    assert.ok(section)
    for (const source of sectionPlan.visualSources) {
      const expected =
        source.tableIndex === null
          ? section?.listItems[source.rowIndex!]
          : section?.tables[source.tableIndex]?.rows[source.rowIndex!]?.[source.columnIndex!]
      assert.equal(expected, source.rawValue)
    }
  }
  assert.equal(presentation.sections.find((section) => section.sectionNumber === '0')?.tables[0]?.mode, 'visible')
  assert.equal(presentation.sections.find((section) => section.sectionNumber === '9')?.tables[0]?.mode, 'collapsed')
  const executionPlan = presentation.sections.find((section) => section.sectionNumber === '9')
  assert.equal(executionPlan?.executionDistributions.length, 2)
  for (const distribution of executionPlan?.executionDistributions || []) {
    assert.equal(
      distribution.items.reduce((sum, item) => sum + item.value, 0),
      distribution.total
    )
    for (const item of distribution.items) {
      for (const source of item.sources) {
        assert.equal(
          model.sections
            .find((section) => section.number === source.sectionNumber)
            ?.tables[source.tableIndex!]?.rows[source.rowIndex!]?.[source.columnIndex!],
          source.rawValue
        )
      }
    }
  }

  const html = await markdownToHtmlDocument(HTML_REPORT_FIXTURE)
  const repeated = await markdownToHtmlDocument(HTML_REPORT_FIXTURE)
  assert.equal(html, repeated)
  assert.match(html, /data-report-direction="household-field-guide"/)
  assert.match(html, /先做什么，再验证什么/)
  assert.match(html, /class="story-stat-hero"/)
  assert.match(html, /class="signal-strip"/)
  assert.match(html, /class="decision-dashboard"/)
  assert.match(html, /class="chapter-index"/)
  assert.match(html, /data-source-value=/)
  assert.match(html, /data-source-cell-count=/)
  assert.match(html, /一方数据分口径对比/)
  assert.match(html, /证据如何进入经营判断/)
  assert.match(html, /用户决策顺序/)
  assert.match(html, /人群、场景与卖点匹配/)
  assert.match(html, /建议内容结构/)
  assert.match(html, /class="content-mix-dashboard"/)
  assert.match(html, /class="donut-chart"/)
  assert.match(html, /第一轮脚本组合/)
  assert.match(html, /class="donut-pair"/)
  assert.match(html, /class="execution-matrix"/)
  assert.match(html, /发布前风险护栏/)
  assert.match(html, /data-label="脚本编号"/)
  assert.match(html, /scope="col"/)
  assert.match(html, /@media \(max-width: 414px\)/)
  assert.match(html, /@media \(min-width: 769px\) and \(max-width: 1080px\)/)
  assert.match(html, /@media print/)
  assert.match(html, /@page wide/)
  assert.match(html, /class="skip-link"/)
  assert.equal(html.includes('class="mobile-toc"'), false)
  assert.match(html, /@media \(min-width: 769px\)[\s\S]*?\.chapter-index \{ display: none; \}/)
  assert.match(html, /class="evidence-disclosure"/)
  assert.match(html, /查看完整数据/)
  assert.match(html, /class="print-table-copy"/)
  assert.match(html, /\.print-table-copy \{ display: block !important; \}/)
  assert.match(html, /overflow-wrap: anywhere/)
  assert.match(html, /重复标题-2/)
  assert.equal((html.match(/class="report-section"/g) || []).length, 12)
  assert.ok(html.indexOf('0. 结论先行') < html.indexOf('11. 本次报告的限制'))
  assert.ok(html.includes('GMV 128.6万元'))
  assert.ok(html.includes('价格机制仍需品牌确认'))
  assert.equal(html.includes('<script>alert("bad")</script>'), false)
  assert.equal(html.includes('tracker.png'), false)
  assert.equal(html.includes('onerror='), false)
  assert.equal(html.includes('Product visual brief'), false)
  assert.equal(html.includes('@import'), false)
  assert.equal(html.includes('<link'), false)

  const stripped = stripProductVisualBrief(HTML_REPORT_FIXTURE)
  assert.equal(stripped.includes('Product visual brief'), false)
  assert.ok(stripped.startsWith('# 盐中甜酸菜 产品经营报告'))

  const legacy = HTML_REPORT_FIXTURE.replace(/<!-- Product visual brief[\s\S]*?-->\n?/, '')
  const legacyModel = parseHtmlReportModel(legacy)
  assert.equal(legacyModel.brief.evidenceConfidence, 'insufficient')
  assert.equal(legacyModel.brief.designDirection, 'neutral-evidence')
  const legacyHtml = await markdownToHtmlDocument(legacy)
  assert.match(legacyHtml, /data-report-direction="neutral-evidence"/)

  const invalidMix = HTML_REPORT_FIXTURE.replace('| 囤货机制 | 20% | 转化 |', '| 囤货机制 | 10% | 转化 |')
  const invalidMixHtml = await markdownToHtmlDocument(invalidMix)
  assert.equal(invalidMixHtml.includes('建议内容结构'), false)
  assert.equal(invalidMixHtml.includes('class="content-mix-dashboard"'), false)
  assert.ok(invalidMixHtml.includes('内容主线'))

  const missingMix = HTML_REPORT_FIXTURE.replace('| 囤货机制 | 20% | 转化 |', '| 囤货机制 | 需补充 | 转化 |')
  const missingMixHtml = await markdownToHtmlDocument(missingMix)
  assert.equal(missingMixHtml.includes('建议内容结构'), false)
  assert.equal(missingMixHtml.includes('class="content-mix-dashboard"'), false)

  const rangedMix = HTML_REPORT_FIXTURE
    .replace('| 家庭快餐 | 50% | 主需求 |', '| 家庭快餐 | 50%-60% | 主需求 |')
    .replace('| 囤货机制 | 20% | 转化 |', '| 囤货机制 | 20% | 转化 |')
  const rangedMixHtml = await markdownToHtmlDocument(rangedMix)
  assert.equal(rangedMixHtml.includes('建议内容结构'), false)
  assert.equal(rangedMixHtml.includes('class="content-mix-dashboard"'), false)

  const misleadingClass = HTML_REPORT_FIXTURE.replace(
    '| S01 | 家庭快餐 | 下班十分钟开饭 | 3.1 | 用户 |',
    '| S01 | 家庭快餐 | 下班十分钟开饭 | 3.10 | 用户 |'
  )
  const misleadingClassHtml = await markdownToHtmlDocument(misleadingClass)
  const classCounts = misleadingClassHtml.match(
    /<section class="donut-card">\s*<h3>视频分类<\/h3>([\s\S]*?)<\/section>/
  )?.[1]
  assert.ok(classCounts)
  assert.match(classCounts || '', /<span>3\.1<\/span>[\s\S]*?<strong>0条<\/strong>/)
  assert.match(classCounts || '', /<span>其他分类<\/span>[\s\S]*?<strong>1条<\/strong>/)

  const keywordMarkdown = `# 卖点词频测试

## 5. 产品全量卖点拆解
| 卖点维度 | 我方产品卖点 | 用户能感知的好处 |
|---|---|---|
| 原料 | 自然发酵酸菜，配料简单 | 家庭做菜能直接感知酸菜发酵风味 |
| 使用 | 酸菜分袋，快速做菜 | 家庭晚餐做菜更快速 |
| 信任 | 配料清晰，发酵过程可见 | 家庭选择酸菜时更容易核对配料 |
| 场景 | 家庭日常酸菜做法 | 快速完成一顿家庭饭菜 |`
  const keywordModel = parseHtmlReportModel(keywordMarkdown)
  const keywordPlan = buildHtmlReportPresentation(keywordModel).sections.find(
    (section) => section.sectionNumber === '5'
  )
  assert.ok(keywordPlan?.keywordCloud)
  assert.ok((keywordPlan?.keywordCloud?.items.length || 0) >= 6)
  assert.ok(keywordPlan?.keywordCloud?.items.some((item) => item.label === '家庭'))
  assert.ok(keywordPlan?.keywordCloud?.items.some((item) => item.label === '酸菜'))
  const keywordSection = keywordModel.sections.find((section) => section.number === '5')
  for (const item of keywordPlan?.keywordCloud?.items || []) {
    assert.ok(item.count >= 2)
    for (const source of item.sources) {
      assert.equal(
        keywordSection?.tables[source.tableIndex!]?.rows[source.rowIndex!]?.[source.columnIndex!],
        source.rawValue
      )
    }
  }
  const keywordHtml = await markdownToHtmlDocument(keywordMarkdown)
  assert.match(keywordHtml, /class="word-cloud"/)
  assert.match(keywordHtml, /卖点原文高频词/)
  assert.match(keywordHtml, /data-count="\d+"/)

  const sparseKeywordPlan = buildHtmlReportPresentation(
    parseHtmlReportModel(
      '# 稀疏词测试\n\n## 5. 产品全量卖点拆解\n| 卖点维度 | 我方产品卖点 |\n|---|---|\n| A | 清爽脆嫩 |\n| B | 独立小袋 |'
    )
  ).sections.find((section) => section.sectionNumber === '5')
  assert.equal(sparseKeywordPlan?.keywordCloud, null)

  const incompleteBrief = HTML_REPORT_FIXTURE.replace(
    /role: 家庭日常快速配餐/,
    'role: 需补充'
  )
  const incompleteBriefModel = parseHtmlReportModel(incompleteBrief)
  assert.equal(incompleteBriefModel.brief.evidenceConfidence, 'insufficient')
  assert.equal(incompleteBriefModel.brief.designDirection, 'neutral-evidence')

  const invalidControlledBrief = HTML_REPORT_FIXTURE
    .replace('value-signal: practicality', 'value-signal: invented')
    .replace('trust-model: visible-use', 'trust-model: invented')
  const invalidControlledBriefModel = parseHtmlReportModel(invalidControlledBrief)
  assert.equal(invalidControlledBriefModel.brief.evidenceConfidence, 'insufficient')
  assert.equal(invalidControlledBriefModel.brief.designDirection, 'neutral-evidence')

  const malformedAudience = HTML_REPORT_FIXTURE.replace(
    '| 优先级 | 成交人群 | 数据依据/特征 | 核心卖点 | 核心场景 | 内容语言 |',
    '| 优先级 | 人群备注 | 数据依据/特征 | 卖点备注 | 场景备注 | 内容语言 |'
  )
  const malformedAudienceHtml = await markdownToHtmlDocument(malformedAudience)
  assert.equal(malformedAudienceHtml.includes('人群、场景与卖点匹配'), false)

  for (const range of ['31-45 岁', '31 - 45 岁', '31—45 岁', '31~45 岁', '31～45 岁', '31至45 岁']) {
    const ageRange = await markdownToHtmlDocument(
      `# 年龄测试\n\n## 2. 产品基础信息\n| 模块 | 当前判断 |\n|---|---|\n| 核心年龄 | ${range} |`
    )
    assert.doesNotMatch(ageRange, /<strong>-?45岁<\/strong>/)
    assert.doesNotMatch(ageRange, /<strong>3145岁<\/strong>/)
  }

  const genericMaterialList = await markdownToHtmlDocument(
    '# 素材清单测试\n\n## 4. 竞品与素材打法判断\n| 素材链接 | 备注 |\n|---|---|\n| A | 示例一 |\n| B | 示例二 |'
  )
  assert.equal(genericMaterialList.includes('素材打法提炼'), false)

  const dualMaterialPlaybook = await markdownToHtmlDocument(
    '# 双来源素材测试\n\n## 4. 竞品与素材打法判断\n### 4.1 自有素材\n| 类型 | 原始 3 秒开头 | 可复用方向 |\n|---|---|---|\n| 场景钩子 | 今晚不知道吃什么 | 下饭菜场景 |\n\n### 4.2 竞品素材\n| 竞品开头 | 打法本质 | 我方可迁移方向 |\n|---|---|---|\n| 会吃的人跟时令走 | 生活方式起势 | 家庭餐桌表达 |'
  )
  assert.match(dualMaterialPlaybook, /素材打法迁移链/)
  assert.match(dualMaterialPlaybook, /data-source-tables="0,1"/)
  assert.match(dualMaterialPlaybook, /自有素材/)
  assert.match(dualMaterialPlaybook, /竞品借鉴/)

  const invalidEntity = await markdownToHtmlDocument(
    '# 极端实体 &#9999999999;\n\n## 0. 结论先行\n仍可正常导出。'
  )
  assert.ok(invalidEntity.includes('极端实体'))
  assert.ok(invalidEntity.includes('�'))

  const longUrl = `https://example.com/${'very-long-path-'.repeat(30)}`
  const longUrlHtml = await markdownToHtmlDocument(
    `# 长链接测试\n\n## 0. 结论先行\n[完整长链接](${longUrl})`
  )
  assert.ok(longUrlHtml.includes(longUrl))
  assert.match(longUrlHtml, /word-break: break-word/)

  const platformFacets = await markdownToHtmlDocument(
    '# 分平台测试\n\n## 3. 一方数据核心判断\n### 同口径人群占比\n| 平台 | 维度 | 关键数据 |\n|---|---|---|\n| 视频号 | 女性 | 60% |\n| 视频号 | 男性 | 40% |\n| 云图 | 女性 | 55% |\n| 云图 | 男性 | 45% |'
  )
  assert.match(platformFacets, /同口径人群占比 · 视频号 · 关键数据/)
  assert.match(platformFacets, /同口径人群占比 · 云图 · 关键数据/)

  const sourceFacets = await markdownToHtmlDocument(
    '# 分来源测试\n\n## 3. 一方数据核心判断\n### 同口径人群占比\n| 来源 | 维度 | 关键数据 |\n|---|---|---|\n| 视频号 | 女性 | 60% |\n| 视频号 | 男性 | 40% |\n| 云图 | 女性 | 55% |\n| 云图 | 男性 | 45% |'
  )
  assert.match(sourceFacets, /同口径人群占比 · 视频号 · 关键数据/)
  assert.match(sourceFacets, /同口径人群占比 · 云图 · 关键数据/)

  const groupedDimensions = await markdownToHtmlDocument(
    '# 分维度测试\n\n## 3. 一方数据核心判断\n### 视频号成交人群\n| 平台 | 维度 | 类别 | 关键数据 |\n|---|---|---|---|\n| 视频号 | 性别 | 女性 | 60% |\n| 视频号 | 性别 | 男性 | 40% |\n| 视频号 | 年龄 | 31-40岁 | 45% |\n| 视频号 | 年龄 | 41-50岁 | 30% |'
  )
  assert.match(groupedDimensions, /视频号成交人群 · 视频号 · 性别 · 关键数据/)
  assert.match(groupedDimensions, /视频号成交人群 · 视频号 · 年龄 · 关键数据/)
  assert.match(groupedDimensions, />女性<\/span><strong>60%<\/strong>/)
  assert.match(groupedDimensions, />31-40岁<\/span><strong>45%<\/strong>/)

  const inlineProfileMarkdown =
    '# 复合人群数据测试\n\n## 3. 一方数据核心判断\n### 3.1 抖店成交人群\n| 维度 | 关键数据 | 经营含义 |\n|---|---|---|\n| 性别 | 女性占比 78.14% | 女性决策者为主 |\n| 年龄 | 31-35岁 30.11%，36-40岁 17.02%，41-45岁 9.88% | 主力年龄 |\n| 婚育 | 已育 72.96% | 家庭场景 |\n| 人群标签 | 精致妈妈 24.95%、资深中产 23.07% | 重点标签 |\n| 地域 | 江苏 19.09%，浙江 9.68%，上海 5.87% | 华东突出 |'
  const inlineProfileModel = parseHtmlReportModel(inlineProfileMarkdown)
  const inlineProfilePlan = buildHtmlReportPresentation(inlineProfileModel).sections.find(
    (section) => section.sectionNumber === '3'
  )
  assert.equal(inlineProfilePlan?.percentFacets.length, 5)
  assert.equal(inlineProfilePlan?.percentFacets.filter((facet) => facet.mode === 'stat').length, 2)
  assert.equal(inlineProfilePlan?.percentFacets.filter((facet) => facet.mode === 'bars').length, 3)
  assert.deepEqual(inlineProfilePlan?.visualSourceTableIndexes, [0])
  const inlineProfileSection = inlineProfileModel.sections.find((section) => section.number === '3')
  for (const source of inlineProfilePlan?.visualSources || []) {
    assert.equal(
      inlineProfileSection?.tables[source.tableIndex!]?.rows[source.rowIndex!]?.[source.columnIndex!],
      source.rawValue
    )
  }
  const inlineProfileHtml = await markdownToHtmlDocument(inlineProfileMarkdown)
  assert.match(inlineProfileHtml, /class="profile-board"/)
  assert.match(inlineProfileHtml, /class="profile-kpi"/)
  assert.match(inlineProfileHtml, />31-35岁<\/span><strong>30\.11%<\/strong>/)
  assert.match(inlineProfileHtml, /单项占比用数字卡呈现/)

  const unsafeInlineProfile = await markdownToHtmlDocument(
    '# 不确定复合数据测试\n\n## 3. 一方数据核心判断\n### 3.1 抖店成交人群\n| 维度 | 关键数据 |\n|---|---|\n| 年龄 | 31-35岁约30.11%，36-40岁17.02% |\n| 地域 | 江苏 119%，浙江 9.68% |'
  )
  assert.equal(unsafeInlineProfile.includes('一方数据分口径对比'), false)

  const emptyCategories = await markdownToHtmlDocument(
    '# 空类别测试\n\n## 3. 一方数据核心判断\n### 视频号成交人群\n| 平台 | 维度 | 类别 | 关键数据 |\n|---|---|---|---|\n| 视频号 | 性别 |  | 60% |\n| 视频号 | 性别 |  | 40% |'
  )
  assert.equal(emptyCategories.includes('一方数据分口径对比'), false)

  const aliasedDimensions = await markdownToHtmlDocument(
    '# 维度别名测试\n\n## 3. 一方数据核心判断\n### 视频号成交人群\n| 平台 | 属性 | 选项 | 关键数据 |\n|---|---|---|---|\n| 视频号 | 性别 | 女性 | 60% |\n| 视频号 | 性别 | 男性 | 40% |\n| 视频号 | 年龄 | 31-40岁 | 45% |\n| 视频号 | 年龄 | 41-50岁 | 30% |'
  )
  assert.match(aliasedDimensions, /视频号成交人群 · 视频号 · 性别 · 关键数据/)
  assert.match(aliasedDimensions, /视频号成交人群 · 视频号 · 年龄 · 关键数据/)

  const compactMixedDimensions = await markdownToHtmlDocument(
    '# 紧凑混合维度测试\n\n## 3. 一方数据核心判断\n### 视频号成交人群\n| 平台 | 类别 | 关键数据 |\n|---|---|---|\n| 视频号 | 女性 | 60% |\n| 视频号 | 男性 | 40% |\n| 视频号 | 31-40岁 | 45% |\n| 视频号 | 41-50岁 | 30% |'
  )
  assert.equal(compactMixedDimensions.includes('一方数据分口径对比'), false)

  const compactSingleDimension = await markdownToHtmlDocument(
    '# 紧凑单维度测试\n\n## 3. 一方数据核心判断\n### 视频号成交人群\n| 平台 | 类别 | 关键数据 |\n|---|---|---|\n| 视频号 | 女性 | 60% |\n| 视频号 | 男性 | 40% |'
  )
  assert.match(compactSingleDimension, /视频号成交人群 · 视频号 · 关键数据/)

  const implicitMixedPlatform = await markdownToHtmlDocument(
    '# 隐式跨平台测试\n\n## 3. 一方数据核心判断\n### 综合数据\n| 维度 | 关键数据 |\n|---|---|\n| 视频号女性 | 60% |\n| 视频号男性 | 40% |\n| 云图女性 | 55% |\n| 云图男性 | 45% |'
  )
  assert.equal(implicitMixedPlatform.includes('一方数据分口径对比'), false)

  const mixedDenominator = await markdownToHtmlDocument(
    '# 混合分母测试\n\n## 3. 一方数据核心判断\n### 视频号综合指标\n| 维度 | 关键数据 |\n|---|---|\n| 女性占全部用户 | 60% |\n| 复购用户占已购用户 | 20% |'
  )
  assert.equal(mixedDenominator.includes('一方数据分口径对比'), false)

  const mixedMetricRates = await markdownToHtmlDocument(
    '# 混合指标测试\n\n## 3. 一方数据核心判断\n### 视频号综合指标\n| 维度 | 数据 |\n|---|---|\n| 女性比例 | 60% |\n| 复购率 | 20% |'
  )
  assert.equal(mixedMetricRates.includes('一方数据分口径对比'), false)

  const implicitSinglePlatform = await markdownToHtmlDocument(
    '# 单平台测试\n\n## 3. 一方数据核心判断\n### 视频号成交人群\n| 维度 | 关键数据 |\n|---|---|\n| 女性 | 60% |\n| 男性 | 40% |'
  )
  assert.match(implicitSinglePlatform, /视频号成交人群 · 关键数据/)

  const sourceDriftModel = parseHtmlReportModel(
    '# 来源绑定测试\n\n## 3. 一方数据核心判断\n### 视频号成交人群已确认\n| 维度 | 关键数据 |\n|---|---|\n| 女性 | 60% |\n| 男性 | 40% |\n\n### 视频号成交人群约数\n| 维度 | 关键数据 |\n|---|---|\n| 女性 | 约55% |\n| 男性 | 约45% |'
  )
  const sourceDriftPlan = buildHtmlReportPresentation(sourceDriftModel).sections.find(
    (section) => section.sectionNumber === '3'
  )
  assert.deepEqual(sourceDriftPlan?.visualSourceTableIndexes, [0])
  assert.equal(sourceDriftPlan?.percentFacets.length, 1)
  const sourceDriftHtml = await markdownToHtmlDocument(
    '# 来源绑定测试\n\n## 3. 一方数据核心判断\n### 视频号成交人群已确认\n| 维度 | 关键数据 |\n|---|---|\n| 女性 | 60% |\n| 男性 | 40% |\n\n### 视频号成交人群约数\n| 维度 | 关键数据 |\n|---|---|\n| 女性 | 约55% |\n| 男性 | 约45% |'
  )
  assert.match(sourceDriftHtml, /data-source-tables="0"/)
  assert.equal(sourceDriftHtml.includes('约55%</strong>'), false)

  const fallbackMixModel = parseHtmlReportModel(
    '# 内容回退测试\n\n## 8. 视频号内容主线设计\n| 方向 | 建议占比 |\n|---|---|\n| A | 60% |\n| B | 30% |\n\n| 内容主线 | 对应人群 | 选题方向 |\n|---|---|---|\n| 家庭快餐 | 家庭用户 | 十分钟开饭 |'
  )
  const fallbackMixPlan = buildHtmlReportPresentation(fallbackMixModel).sections.find(
    (section) => section.sectionNumber === '8'
  )
  assert.equal(fallbackMixPlan?.contentMix?.mode, 'mainline')
  assert.deepEqual(fallbackMixPlan?.visualSourceTableIndexes, [1])
  const fallbackMixHtml = await markdownToHtmlDocument(
    '# 内容回退测试\n\n## 8. 视频号内容主线设计\n| 方向 | 建议占比 |\n|---|---|\n| A | 60% |\n| B | 30% |\n\n| 内容主线 | 对应人群 | 选题方向 |\n|---|---|---|\n| 家庭快餐 | 家庭用户 | 十分钟开饭 |'
  )
  assert.match(fallbackMixHtml, /data-source-tables="1"/)

  const incomplete = await markdownToHtmlDocument('# 空报告\n生成日期：2026-07-27\n\n## 0. 结论先行\n需补充')
  assert.match(incomplete, /data-report-direction="neutral-evidence"/)
  assert.ok(incomplete.includes('需补充'))
  assert.equal(
    buildHtmlReportPresentation(
      parseHtmlReportModel('# 低信号报告\n\n## 2. 产品基础信息\n| 模块 | 当前判断 |\n|---|---|\n| 规格 | 3袋 |')
    ).mainMetric,
    null
  )
  assert.equal(
    buildHtmlReportPresentation(
      parseHtmlReportModel(
        '# 规格与价格测试\n\n## 2. 产品基础信息\n| 模块 | 关键数据 |\n|---|---|\n| 规格 | 10个 |\n| 价格 | 79元 |'
      )
    ).mainMetric,
    null
  )
  for (const range of ['19.9~25.9元', '19.9～25.9元', '10~20个']) {
    const rangePresentation = buildHtmlReportPresentation(
      parseHtmlReportModel(
        `# 区间测试\n\n## 3. 一方数据核心判断\n| 指标 | 关键数据 |\n|---|---|\n| 价格区间 | ${range} |`
      )
    )
    assert.equal(rangePresentation.mainMetric, null)
    assert.equal(rangePresentation.supportingSignals.length, 0)
  }

  const sanitized = sanitizeHtmlFragment(
    '<p class="ok" onclick="bad()">安全</p><iframe src="x">坏</iframe><a href="javascript:bad()">链接</a>'
  )
  assert.equal(sanitized.includes('onclick'), false)
  assert.equal(sanitized.includes('iframe'), false)
  assert.equal(sanitized.includes('javascript:'), false)
  assert.ok(sanitized.includes('安全'))

  assert.equal(
    friendlyError(new Error('EPERM: operation not permitted, rename report.html')),
    '文件可能正在被占用，或保存位置没有权限。请关闭同名文件，或改存到桌面后重试。'
  )
  assert.equal(
    friendlyError(new Error('ENOSPC: no space left on device')),
    '磁盘空间不足，无法保存文件。请清理空间或改存到其他磁盘后重试。'
  )
  assert.equal(
    friendlyError(new Error('EBUSY: resource busy or locked')),
    '文件正在被其他程序占用。请关闭同名的 Word 或浏览器文件后重试。'
  )

  const bundledRules = readBundledSopRules([join(process.cwd(), 'assets', 'skill', 'SKILL.md')])
  assert.match(bundledRules, /内置 HTML 视觉规范/)
  assert.match(bundledRules, /Product visual brief/)
}

async function run(): Promise<void> {
  console.log('Regression: project persistence')
  await testProjectRevisionAndBackup()
  console.log('Regression: activation and settings backup')
  await testActivationAndSettingsBackup()
  console.log('Regression: server activation, offline grace and idempotent credits')
  await testServerActivationAndCredits()
  console.log('Regression: update version comparison')
  testUpdateVersionComparison()
  console.log('Regression: update config and SHA256 guard')
  await testUpdateConfigAndChecksum()
  console.log('Regression: managed model secret isolation')
  testManagedModelIsolation()
  console.log('Regression: source invalidation')
  await testSourceInvalidation()
  console.log('Regression: reset save rollback')
  await testResetRollbackOnSaveFailure()
  console.log('Regression: new and restore previous analysis')
  await testNewAndRestorePreviousAnalysis()
  console.log('Regression: ZIP reset isolation')
  await testZipCannotReturnAfterReset()
  console.log('Regression: idle goal and late session isolation')
  await testIdleGoalAndLateSessionIsolation()
  console.log('Regression: report rollback')
  await testReportRollbackAndExportGuard()
  console.log('Regression: double export guard')
  await testDoubleExportGuard()
  console.log('Regression: feedback arriving during revision')
  await testFeedbackArrivingDuringRevision()
  console.log('Regression: strict model completion')
  await testStrictModelCompletion()
  console.log('Regression: CSV and ZIP guards')
  await testCsvAndArchiveGuards()
  console.log('Regression: file count guard')
  await testFileCountGuard()
  console.log('Regression: ZIP expansion global count guard')
  await testZipExpansionGlobalCountGuard()
  console.log('Regression: privacy endpoint guard')
  await testPrivacyMustMatchEndpoint()
  console.log('Regression: image header guards')
  await testImageHeaderGuards()
  console.log('Regression: bulk attribution and export open')
  await testBulkAttributionAndExportOpen()
  console.log('Regression: original export button contract')
  testExportButtonContract()
  console.log('Regression: adaptive workbench topbar')
  await testWorkbenchTopbarContract()
  console.log('Regression: adaptive HTML report renderer')
  await testHtmlReportRenderer()
  console.log('Regression checks passed: persistence, restore, reset/session isolation, export guard, strict model completion, CSV/TXT encoding, ZIP, image and file limits, adaptive offline HTML rendering.')
}

void app.whenReady().then(async () => {
  let exitCode = 0
  try {
    await run()
  } catch (error) {
    console.error(error)
    exitCode = 1
  } finally {
    if (topbarAuditWindow && !topbarAuditWindow.isDestroyed()) {
      topbarAuditWindow.destroy()
    }
    topbarAuditWindow = null
    for (let attempt = 0; attempt < 12 && existsSync(tempUserData); attempt++) {
      try {
        rmSync(tempUserData, { recursive: true, force: true })
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            /(?:EBUSY|EPERM|resource busy|operation not permitted)/i.test(error.message)
          )
        ) {
          console.error(error)
          exitCode = 1
          break
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 100))
      }
    }
    if (existsSync(tempUserData)) {
      console.error(`Regression cleanup failed: ${tempUserData}`)
      exitCode = 1
    }
  }
  app.exit(exitCode)
})
