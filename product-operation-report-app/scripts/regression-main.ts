import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import JSZip from 'jszip'
import Papa from 'papaparse'
import iconv from 'iconv-lite'
import type { SavedProject } from '../src/shared/types'
import { parseArchive, parseFile } from '../src/main/ingest'
import { chatStream, listModels, testModel } from '../src/main/model'
import { loadLastProject, saveLastProject } from '../src/main/project'
import { getActivationStatus } from '../src/main/activation'
import { ACTIVATION_CODE_HASHES } from '../src/main/activationCodes'
import { loadSettings, saveSettings } from '../src/main/settings'
import {
  buildProjectSnapshot,
  inspectImageHeader,
  MAX_CLEANING_CONCURRENCY,
  useStore
} from '../src/renderer/src/store'
import type { ChatStreamEvent, ModelProfile } from '../src/shared/types'

const tempUserData = mkdtempSync(join(tmpdir(), 'por-regression-'))
app.setPath('userData', tempUserData)

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
  assert.equal(getActivationStatus().activated, true)

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

async function run(): Promise<void> {
  console.log('Regression: project persistence')
  await testProjectRevisionAndBackup()
  console.log('Regression: activation and settings backup')
  await testActivationAndSettingsBackup()
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
  console.log('Regression checks passed: persistence, restore, reset/session isolation, export guard, strict model completion, CSV/TXT encoding, ZIP, image and file limits.')
}

void app.whenReady().then(async () => {
  try {
    await run()
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  } finally {
    rmSync(tempUserData, { recursive: true, force: true })
  }
})
