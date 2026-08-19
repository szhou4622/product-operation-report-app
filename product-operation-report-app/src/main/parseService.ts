import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { join } from 'path'
import { app, utilityProcess, type UtilityProcess } from 'electron'
import type { ArchiveItem, ParsedFile } from '../shared/types'

type ParseOperation = 'file' | 'archive'
type ParseResult = ParsedFile | ArchiveItem[]

interface QueueItem<T extends ParseResult = ParseResult> {
  id: string
  ownerId: number
  op: ParseOperation
  name: string
  data: ArrayBuffer | null
  byteLength: number
  generation: number | null
  settled: boolean
  timer: ReturnType<typeof setTimeout> | null
  resolve: (value: T) => void
  reject: (error: Error) => void
}

interface UtilityState {
  process: UtilityProcess
  generation: number
  ready: Promise<void>
  resolveReady: () => void
  rejectReady: (error: Error) => void
  readySettled: boolean
  readyTimer: ReturnType<typeof setTimeout>
}

const MAX_FILE_BYTES = 40 * 1024 * 1024
const MAX_ARCHIVE_BYTES = 120 * 1024 * 1024
const MAX_PENDING_TASKS = 8
const MAX_PENDING_BYTES = 200 * 1024 * 1024
const MAX_UTILITY_WORKERS = 2
const READY_TIMEOUT_MS = 5_000
const FILE_TIMEOUT_MS = 180_000
const ARCHIVE_TIMEOUT_MS = 600_000

const utilityStates = new Map<number, UtilityState>()
let generation = 0
const currentByGeneration = new Map<number, QueueItem>()
let queue: QueueItem[] = []
let pendingBytes = 0
let disposed = false
let serviceBlockedError: Error | null = null

function asError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(String(value || fallback))
}

function clearItemTimer(item: QueueItem): void {
  if (item.timer) clearTimeout(item.timer)
  item.timer = null
}

function settleItem(item: QueueItem, error?: Error, result?: ParseResult): void {
  if (item.settled) return
  item.settled = true
  clearItemTimer(item)
  pendingBytes = Math.max(0, pendingBytes - item.byteLength)
  item.data = null
  if (item.generation !== null && currentByGeneration.get(item.generation) === item) {
    currentByGeneration.delete(item.generation)
  }
  if (error) item.reject(error)
  else item.resolve(result as ParseResult)
}

function settleReady(state: UtilityState, error?: Error): void {
  if (state.readySettled) return
  state.readySettled = true
  clearTimeout(state.readyTimer)
  if (error) state.rejectReady(error)
  else state.resolveReady()
}

function stopUtility(state: UtilityState): void {
  if (utilityStates.get(state.generation) !== state) return
  utilityStates.delete(state.generation)
  settleReady(state, new Error('文件解析辅助进程已停止。'))
  let finished = false
  const finish = (): void => {
    if (finished) return
    finished = true
    clearTimeout(watchdog)
    queueMicrotask(pump)
  }
  const watchdog = setTimeout(() => {
    if (finished) return
    const pid = state.process.pid
    if (pid === undefined) {
      finish()
      return
    }
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // The application-level hard-exit watchdog remains the final fallback.
    }
    serviceBlockedError = new Error(
      '文件解析组件未能安全停止。请先保存当前工作，重启软件后再上传文件。'
    )
    const waiting = queue
    queue = []
    for (const item of waiting) settleItem(item, serviceBlockedError)
    finish()
  }, 3_000)
  watchdog.unref?.()
  state.process.once('exit', finish)
  try {
    const killed = state.process.kill()
    if (!killed && state.process.pid === undefined) finish()
  } catch {
    if (state.process.pid === undefined) finish()
  }
}

function failCurrentAndRestart(state: UtilityState, error: Error): void {
  if (utilityStates.get(state.generation) !== state) return
  const item = currentByGeneration.get(state.generation)
  if (item) settleItem(item, error)
  stopUtility(state)
  queueMicrotask(pump)
}

function isReadyMessage(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && (value as { type?: unknown }).type === 'ready')
}

function handleUtilityMessage(state: UtilityState, value: unknown): void {
  if (utilityStates.get(state.generation) !== state) return
  if (isReadyMessage(value)) {
    settleReady(state)
    return
  }
  const item = currentByGeneration.get(state.generation)
  if (!item) return
  if (!value || typeof value !== 'object') {
    failCurrentAndRestart(state, new Error('文件解析服务返回异常，已自动恢复，请重试该文件。'))
    return
  }
  const response = value as {
    id?: string
    ok?: boolean
    result?: ParseResult
    error?: string
  }
  if (response.id !== item.id || typeof response.ok !== 'boolean') {
    failCurrentAndRestart(state, new Error('文件解析服务返回异常，已自动恢复，请重试该文件。'))
    return
  }
  if (response.ok && !isValidResult(item.op, response.result)) {
    failCurrentAndRestart(state, new Error('文件解析服务返回异常，已自动恢复，请重试该文件。'))
    return
  }
  if (response.ok) settleItem(item, undefined, response.result as ParseResult)
  else settleItem(item, new Error(response.error || '文件解析失败，请重试。'))
  queueMicrotask(pump)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object')
}

function isValidParsedFile(value: unknown): value is ParsedFile {
  if (!isRecord(value)) return false
  return (
    typeof value.name === 'string' &&
    value.name.length <= 512 &&
    (value.kind === 'table' || value.kind === 'doc' || value.kind === 'other') &&
    typeof value.text === 'string' &&
    typeof value.ok === 'boolean' &&
    (value.attachments === undefined ||
      (Array.isArray(value.attachments) && value.attachments.length <= 50 && value.attachments.every(isValidArchiveItem))) &&
    (value.error === undefined || typeof value.error === 'string') &&
    (value.warning === undefined || typeof value.warning === 'string')
  )
}

function isValidArchiveItem(value: unknown): value is ArchiveItem {
  if (!isRecord(value)) return false
  return (
    typeof value.name === 'string' &&
    value.name.length <= 1024 &&
    (value.kind === 'image' || value.kind === 'doc' || value.kind === 'table' || value.kind === 'other') &&
    typeof value.ok === 'boolean' &&
    (value.size === undefined || (typeof value.size === 'number' && value.size >= 0)) &&
    (value.text === undefined || typeof value.text === 'string') &&
    (value.dataUrl === undefined ||
      (typeof value.dataUrl === 'string' &&
        value.dataUrl.length <= 14_000_000 &&
        /^data:image\/(?:png|jpeg|webp|gif);base64,/u.test(value.dataUrl))) &&
    (value.error === undefined || typeof value.error === 'string') &&
    (value.warning === undefined || typeof value.warning === 'string')
  )
}

function isValidResult(op: ParseOperation, value: unknown): value is ParseResult {
  if (op === 'file') return isValidParsedFile(value)
  return Array.isArray(value) && value.length <= 120 && value.every(isValidArchiveItem)
}

function createUtility(): UtilityState {
  if (disposed) throw new Error('软件正在关闭，已停止文件解析。')
  if (serviceBlockedError) throw serviceBlockedError
  const candidates = [join(__dirname, 'parse-utility.js')]
  if (!app.isPackaged) candidates.push(join(process.cwd(), 'out', 'main', 'parse-utility.js'))
  const modulePath = candidates.find((candidate) => existsSync(candidate))
  if (!modulePath) throw new Error('文件解析组件缺失，请重新安装软件。')

  const child = utilityProcess.fork(modulePath, [], {
    serviceName: '产品经营报告-文件解析',
    stdio: 'ignore'
  })
  const nextGeneration = ++generation
  let resolveReady!: () => void
  let rejectReady!: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const state = {
    process: child,
    generation: nextGeneration,
    ready,
    resolveReady,
    rejectReady,
    readySettled: false,
    readyTimer: setTimeout(() => undefined, READY_TIMEOUT_MS)
  } satisfies UtilityState
  utilityStates.set(state.generation, state)
  clearTimeout(state.readyTimer)
  state.readyTimer = setTimeout(() => {
    if (utilityStates.get(state.generation) !== state) return
    settleReady(state, new Error('文件解析组件启动超时，请重试。'))
    stopUtility(state)
  }, READY_TIMEOUT_MS)

  child.on('message', (message) => handleUtilityMessage(state, message))
  child.on('exit', (code) => {
    if (utilityStates.get(state.generation) !== state) return
    utilityStates.delete(state.generation)
    const error = new Error(
      code === 0
        ? '文件解析组件已结束，请重试该文件。'
        : '这个文件导致解析组件异常，已自动隔离；请转换格式或拆分后重试。'
    )
    settleReady(state, error)
    const item = currentByGeneration.get(state.generation)
    if (item) settleItem(item, error)
    queueMicrotask(pump)
  })
  return state
}

function idleUtility(): UtilityState | null {
  for (const state of utilityStates.values()) {
    if (!currentByGeneration.has(state.generation)) return state
  }
  return utilityStates.size < MAX_UTILITY_WORKERS ? createUtility() : null
}

async function dispatch(state: UtilityState, item: QueueItem): Promise<void> {
  try {
    await state.ready
    if (
      disposed || item.settled || currentByGeneration.get(state.generation) !== item ||
      utilityStates.get(state.generation) !== state
    ) return
    const data = item.data
    if (!data) throw new Error('文件内容已释放，请重新选择文件。')
    const timeoutMs = item.op === 'archive' ? ARCHIVE_TIMEOUT_MS : FILE_TIMEOUT_MS
    item.timer = setTimeout(() => {
      if (currentByGeneration.get(state.generation) !== item || utilityStates.get(state.generation) !== state) return
      settleItem(
        item,
        new Error(
          item.op === 'archive'
            ? '压缩包处理时间过长，已自动停止。请拆分后重试。'
            : '文件处理时间过长，已自动停止。请只保留关键页面或拆分后重试。'
        )
      )
      stopUtility(state)
      queueMicrotask(pump)
    }, timeoutMs)
    state.process.postMessage({ id: item.id, op: item.op, name: item.name, data })
    item.data = null
  } catch (error) {
    if (currentByGeneration.get(state.generation) === item && !item.settled) {
      settleItem(item, asError(error, '文件解析组件无法启动，请重试。'))
    }
    queueMicrotask(pump)
  }
}

function pump(): void {
  if (disposed || !queue.length) return
  if (serviceBlockedError) {
    const waiting = queue
    queue = []
    for (const item of waiting) settleItem(item, serviceBlockedError)
    return
  }
  while (queue.length) {
    const state = idleUtility()
    if (!state) break
    const item = queue.shift()
    if (!item) break
    item.generation = state.generation
    currentByGeneration.set(state.generation, item)
    void dispatch(state, item)
  }
}

function enqueue<T extends ParseResult>(
  ownerId: number,
  op: ParseOperation,
  name: string,
  data: ArrayBuffer
): Promise<T> {
  if (disposed) return Promise.reject(new Error('软件正在关闭，已停止文件解析。'))
  if (serviceBlockedError) return Promise.reject(serviceBlockedError)
  if (!Number.isSafeInteger(ownerId) || ownerId < 0) {
    return Promise.reject(new Error('文件解析窗口无效，请重新打开软件。'))
  }
  if (typeof name !== 'string' || !name.trim() || name.length > 512) {
    return Promise.reject(new Error('文件名无效，请重新选择文件。'))
  }
  if (!(data instanceof ArrayBuffer) || !data.byteLength) {
    return Promise.reject(new Error('文件是空的，请重新选择。'))
  }
  const maxBytes = op === 'archive' ? MAX_ARCHIVE_BYTES : MAX_FILE_BYTES
  if (data.byteLength > maxBytes) {
    return Promise.reject(
      new Error(
        op === 'archive'
          ? '压缩包超过 120MB，请拆分后重新上传。'
          : '单个文件超过 40MB，请压缩或拆分后重新上传。'
      )
    )
  }
  if (queue.length + currentByGeneration.size >= MAX_PENDING_TASKS) {
    return Promise.reject(new Error('待处理文件过多，请等待当前文件完成后再上传。'))
  }
  if (pendingBytes + data.byteLength > MAX_PENDING_BYTES) {
    return Promise.reject(new Error('待处理文件总量过大，请分批上传。'))
  }

  pendingBytes += data.byteLength
  return new Promise<T>((resolve, reject) => {
    queue.push({
      id: randomUUID(),
      ownerId,
      op,
      name,
      data,
      byteLength: data.byteLength,
      generation: null,
      settled: false,
      timer: null,
      resolve: resolve as (value: ParseResult) => void,
      reject
    })
    void pump()
  })
}

export function parseFileInUtility(
  ownerId: number,
  name: string,
  data: ArrayBuffer
): Promise<ParsedFile> {
  return enqueue<ParsedFile>(ownerId, 'file', name, data)
}

export function parseArchiveInUtility(
  ownerId: number,
  name: string,
  data: ArrayBuffer
): Promise<ArchiveItem[]> {
  return enqueue<ArchiveItem[]>(ownerId, 'archive', name, data)
}

export function cancelParsingForOwner(ownerId: number, reason = '已取消文件解析。'): void {
  const error = new Error(reason)
  const waiting = queue
  queue = []
  for (const item of waiting) {
    if (item.ownerId === ownerId) settleItem(item, error)
    else queue.push(item)
  }
  for (const [workerGeneration, item] of [...currentByGeneration.entries()]) {
    if (item.ownerId !== ownerId) continue
    settleItem(item, error)
    const state = utilityStates.get(workerGeneration)
    if (state) stopUtility(state)
  }
  queueMicrotask(pump)
}

export function hasParsingForOwner(ownerId: number): boolean {
  return [...currentByGeneration.values()].some((item) => item.ownerId === ownerId) ||
    queue.some((item) => item.ownerId === ownerId)
}

export function disposeParseService(): void {
  if (disposed) return
  disposed = true
  const error = new Error('软件正在关闭，已停止文件解析。')
  for (const item of [...currentByGeneration.values()]) settleItem(item, error)
  const waiting = queue
  queue = []
  for (const item of waiting) settleItem(item, error)
  for (const state of [...utilityStates.values()]) stopUtility(state)
}
