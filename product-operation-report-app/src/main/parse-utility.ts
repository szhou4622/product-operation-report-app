import type { ArchiveItem, ParsedFile } from '../shared/types'
import { parseArchive, parseFile } from './ingest'

type ParseOperation = 'file' | 'archive'

interface ParseRequest {
  id: string
  op: ParseOperation
  name: string
  data: ArrayBuffer
}

type ParseResponse =
  | { id: string; ok: true; result: ParsedFile | ArchiveItem[] }
  | { id: string; ok: false; error: string }

const MAX_FILE_BYTES = 40 * 1024 * 1024
const MAX_ARCHIVE_BYTES = 120 * 1024 * 1024
const port = process.parentPort

if (!port) throw new Error('文件解析辅助进程启动失败。')

let busy = false

function safeError(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error || ''))
    .replace(/\s+/g, ' ')
    .trim()
  return message.slice(0, 300) || '文件解析失败，请检查文件后重试。'
}

function validateRequest(value: unknown): ParseRequest {
  if (!value || typeof value !== 'object') throw new Error('文件解析请求无效，请重试。')
  const request = value as Partial<ParseRequest>
  if (typeof request.id !== 'string' || !request.id || request.id.length > 100) {
    throw new Error('文件解析请求编号无效，请重试。')
  }
  if (request.op !== 'file' && request.op !== 'archive') {
    throw new Error('文件解析类型无效，请重试。')
  }
  if (typeof request.name !== 'string' || !request.name.trim() || request.name.length > 512) {
    throw new Error('文件名无效，请重新选择文件。')
  }
  if (!(request.data instanceof ArrayBuffer)) {
    throw new Error('文件内容无效，请重新选择文件。')
  }
  const maxBytes = request.op === 'archive' ? MAX_ARCHIVE_BYTES : MAX_FILE_BYTES
  if (!request.data.byteLength) throw new Error('文件是空的，请重新选择。')
  if (request.data.byteLength > maxBytes) {
    throw new Error(
      request.op === 'archive'
        ? '压缩包超过 120MB，请拆分后重新上传。'
        : '单个文件超过 40MB，请压缩或拆分后重新上传。'
    )
  }
  return request as ParseRequest
}

port.on('message', async (event) => {
  let id = ''
  let acquired = false
  let response: ParseResponse
  try {
    const request = validateRequest(event.data)
    id = request.id
    if (busy) throw new Error('文件正在排队处理，请稍后重试。')
    busy = true
    acquired = true
    const result =
      request.op === 'archive'
        ? await parseArchive(request.name, request.data)
        : await parseFile(request.name, request.data)
    response = { id, ok: true, result }
  } catch (error) {
    response = { id, ok: false, error: safeError(error) }
  } finally {
    if (acquired) busy = false
  }
  port.postMessage(response)
})

port.postMessage({ type: 'ready' })
