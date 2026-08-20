import type { ChatMessage, ModelTaskContext } from '../shared/types'

const REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const IMAGE_DATA_URL_RE = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=\s]+)$/i
const MAX_MESSAGES = 64
const MAX_PARTS_PER_MESSAGE = 128
const MAX_TEXT_CHARS = 2_000_000
const MAX_IMAGE_BYTES = 16 * 1024 * 1024
const MAX_REQUEST_BYTES = 96 * 1024 * 1024

export interface ValidatedChatStartPayload {
  id: string
  messages: ChatMessage[]
  context: ModelTaskContext
}

function requireObject(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message)
  return value as Record<string, unknown>
}

function imageBytes(dataUrl: string): number {
  const match = dataUrl.match(IMAGE_DATA_URL_RE)
  if (!match) throw new Error('图片格式无效，只允许软件生成的 PNG、JPEG 或 WebP 图片。')
  const compact = match[2].replace(/\s+/g, '')
  if (compact.length % 4 !== 0) throw new Error('图片内容损坏，请重新上传。')
  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0
  const bytes = (compact.length / 4) * 3 - padding
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_IMAGE_BYTES) {
    throw new Error('单张图片过大，请压缩后重新上传。')
  }
  return bytes
}

export function validateChatStartPayload(payload: unknown): ValidatedChatStartPayload {
  const input = requireObject(payload, '模型请求格式无效，请重新开始本次分析。')
  const id = typeof input.id === 'string' ? input.id.trim() : ''
  if (!REQUEST_ID_RE.test(id)) throw new Error('模型请求标识无效，请重新开始本次分析。')
  if (!Array.isArray(input.messages) || !input.messages.length || input.messages.length > MAX_MESSAGES) {
    throw new Error('模型消息数量异常，请减少资料后重试。')
  }

  let requestBytes = 0
  const messages: ChatMessage[] = input.messages.map((rawMessage) => {
    const message = requireObject(rawMessage, '模型消息格式无效。')
    if (message.role !== 'system' && message.role !== 'user' && message.role !== 'assistant') {
      throw new Error('模型消息角色无效。')
    }
    if (typeof message.content === 'string') {
      if (message.content.length > MAX_TEXT_CHARS) throw new Error('模型输入内容过大，请减少资料后重试。')
      requestBytes += Buffer.byteLength(message.content, 'utf8')
      return { role: message.role, content: message.content }
    }
    if (!Array.isArray(message.content) || !message.content.length || message.content.length > MAX_PARTS_PER_MESSAGE) {
      throw new Error('模型消息内容格式无效。')
    }
    const content = message.content.map((rawPart) => {
      const part = requireObject(rawPart, '模型消息内容格式无效。')
      if (part.type === 'text' && typeof part.text === 'string') {
        if (part.text.length > MAX_TEXT_CHARS) throw new Error('模型输入内容过大，请减少资料后重试。')
        requestBytes += Buffer.byteLength(part.text, 'utf8')
        return { type: 'text' as const, text: part.text }
      }
      if (part.type === 'image' && typeof part.dataUrl === 'string') {
        requestBytes += imageBytes(part.dataUrl)
        return { type: 'image' as const, dataUrl: part.dataUrl }
      }
      throw new Error('模型消息内容格式无效。')
    })
    return { role: message.role, content }
  })
  if (requestBytes > MAX_REQUEST_BYTES) throw new Error('本次模型输入总量过大，请减少资料后重试。')

  return {
    id,
    messages,
    context: requireObject(input.context, '模型任务标识无效。') as unknown as ModelTaskContext
  }
}

interface OwnedRequest {
  ownerId: number
  controller: AbortController
}

export class ChatRequestRegistry {
  private readonly entries = new Map<string, OwnedRequest>()

  constructor(private readonly maxPerOwner = 4) {}

  claim(id: string, ownerId: number, controller: AbortController): void {
    if (this.entries.has(id)) throw new Error('检测到重复模型请求，已阻止重复扣费。')
    let active = 0
    for (const entry of this.entries.values()) if (entry.ownerId === ownerId) active += 1
    if (active >= this.maxPerOwner) throw new Error('同时处理的模型任务过多，请等待当前任务完成后再试。')
    this.entries.set(id, { ownerId, controller })
  }

  abort(id: string, ownerId: number): boolean {
    const entry = this.entries.get(id)
    if (!entry || entry.ownerId !== ownerId) return false
    entry.controller.abort()
    return true
  }

  release(id: string, ownerId: number, controller: AbortController): boolean {
    const entry = this.entries.get(id)
    if (!entry || entry.ownerId !== ownerId || entry.controller !== controller) return false
    return this.entries.delete(id)
  }

  abortOwner(ownerId: number): void {
    for (const [id, entry] of this.entries) {
      if (entry.ownerId !== ownerId) continue
      entry.controller.abort()
      this.entries.delete(id)
    }
  }

  abortAll(): void {
    for (const entry of this.entries.values()) entry.controller.abort()
    this.entries.clear()
  }

  hasOwner(ownerId: number): boolean {
    for (const entry of this.entries.values()) {
      if (entry.ownerId === ownerId) return true
    }
    return false
  }

  get size(): number {
    return this.entries.size
  }
}

export const chatAdmissionLimits = {
  maxMessages: MAX_MESSAGES,
  maxTextChars: MAX_TEXT_CHARS,
  maxImageBytes: MAX_IMAGE_BYTES,
  maxRequestBytes: MAX_REQUEST_BYTES
}
