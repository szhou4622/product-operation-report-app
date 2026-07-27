import type {
  ChatMessage,
  ChatStreamEvent,
  ContentPart,
  ModelListResult,
  ModelProfile,
  TestModelOptions,
  TestModelResult
} from '../shared/types'

const SETTINGS_REQUEST_TIMEOUT_MS = 20_000
const STREAM_REQUEST_TIMEOUT_MS = 180_000
const MAX_SETTINGS_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_ERROR_RESPONSE_BYTES = 16 * 1024
const MAX_MODEL_OUTPUT_CHARS = 2_000_000
const MAX_MODEL_LIST_ITEMS = 500
const MAX_SSE_EVENT_CHARS = 2_000_000

async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') || 0)
  if (declared > maxBytes) throw new Error('服务返回内容异常过大，已停止读取。')
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let text = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new Error('服务返回内容异常过大，已停止读取。')
      }
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

function finishReasonError(reason: unknown): string | undefined {
  if (typeof reason !== 'string' || !reason || reason === 'stop') return undefined
  if (reason === 'length') return '模型输出达到长度上限，本次内容不完整。请减少资料后重试。'
  if (reason === 'content_filter') return '模型因内容安全限制提前停止，本次内容不完整。请调整资料或要求后重试。'
  return `模型提前停止（${reason}），本次内容未作为完整结果保存。`
}

function modelRequestError(error: unknown): string {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return `请求超过 ${SETTINGS_REQUEST_TIMEOUT_MS / 1000} 秒未响应，请检查 Base URL 或网络后重试。`
  }
  return error instanceof Error ? error.message : String(error)
}

function retryAfterSeconds(response: Response): number | undefined {
  const value = response.headers.get('retry-after')?.trim()
  if (!value) return undefined
  const numeric = Number(value)
  if (Number.isFinite(numeric) && numeric >= 0) return Math.min(60, Math.ceil(numeric))
  const at = Date.parse(value)
  if (!Number.isFinite(at)) return undefined
  return Math.min(60, Math.max(1, Math.ceil((at - Date.now()) / 1000)))
}

/** 拉取 OpenAI 兼容端点的可用模型列表（GET {baseURL}/models） */
export async function listModels(profile: ModelProfile): Promise<ModelListResult> {
  try {
    const base = profile.baseURL.replace(/\/+$/, '')
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${profile.apiKey}` },
      signal: AbortSignal.timeout(SETTINGS_REQUEST_TIMEOUT_MS)
    })
    const raw = await readLimitedText(res, MAX_SETTINGS_RESPONSE_BYTES)
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} ${raw.slice(0, 200)}` }
    let json: { data?: unknown[]; models?: unknown[] }
    try {
      json = JSON.parse(raw)
    } catch {
      return {
        ok: false,
        error: raw.trimStart().startsWith('<')
          ? '端点返回网页而非 JSON，Base URL 可能要加 /v1'
          : '返回不是合法 JSON'
      }
    }
    const list = (json.data || json.models || []) as unknown[]
    const models = list
      .map((m) => (typeof m === 'string' ? m : (m as { id?: string }).id))
      .filter((x): x is string => Boolean(x && x.length <= 200))
      .sort()
      .slice(0, MAX_MODEL_LIST_ITEMS)
    return { ok: true, models }
  } catch (e) {
    return { ok: false, error: modelRequestError(e) }
  }
}

// 把内部消息格式转换成 OpenAI 兼容的 messages
function toOpenAIMessages(messages: ChatMessage[], supportsVision: boolean): unknown[] {
  return messages.map((m) => {
    if (typeof m.content === 'string') {
      return { role: m.role, content: m.content }
    }
    // 多部分内容
    if (!supportsVision) {
      // 模型不支持读图：丢弃图片，仅保留文本，并提示有图被忽略
      const text = (m.content as ContentPart[])
        .map((p) => (p.type === 'text' ? p.text : '[图片已忽略：当前模型未开启读图]'))
        .join('\n')
      return { role: m.role, content: text }
    }
    const parts = (m.content as ContentPart[]).map((p) =>
      p.type === 'text'
        ? { type: 'text', text: p.text }
        : { type: 'image_url', image_url: { url: p.dataUrl } }
    )
    return { role: m.role, content: parts }
  })
}

function endpoint(baseURL: string): string {
  const base = baseURL.replace(/\/+$/, '')
  return `${base}/chat/completions`
}

/** 非流式：测试连通性 */
export async function testModel(opts: TestModelOptions): Promise<TestModelResult> {
  const { profile, withImageDataUrl } = opts
  const started = Date.now()
  try {
    const userContent: ChatMessage['content'] = withImageDataUrl
      ? [
          { type: 'text', text: '用一句话描述这张图片里的主要内容。' },
          { type: 'image', dataUrl: withImageDataUrl }
        ]
      : '请只回复两个字：可用'

    const messages: ChatMessage[] = [
      { role: 'system', content: '你是连通性测试助手，请简短回复。' },
      { role: 'user', content: userContent }
    ]

    const res = await fetch(endpoint(profile.baseURL), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${profile.apiKey}`
      },
      body: JSON.stringify({
        model: profile.model,
        messages: toOpenAIMessages(messages, profile.supportsVision && !!withImageDataUrl),
        temperature: profile.temperature ?? 0.3,
        stream: false
      }),
      signal: AbortSignal.timeout(SETTINGS_REQUEST_TIMEOUT_MS)
    })

    const raw = await readLimitedText(res, MAX_SETTINGS_RESPONSE_BYTES)

    if (!res.ok) {
      return {
        ok: false,
        message: `HTTP ${res.status} ${res.statusText} ${raw.slice(0, 300)}`,
        latencyMs: Date.now() - started
      }
    }

    let data: { choices?: { message?: { content?: string }; finish_reason?: string | null }[] }
    try {
      data = JSON.parse(raw)
    } catch {
      const looksHtml = raw.trimStart().startsWith('<')
      return {
        ok: false,
        message: looksHtml
          ? `端点返回的是网页(HTML)而非 JSON，通常是 Base URL 路径不对——试试在末尾加 /v1。当前：${profile.baseURL}`
          : `返回内容不是合法 JSON：${raw.slice(0, 200)}`,
        latencyMs: Date.now() - started
      }
    }
    const choice = data.choices?.[0]
    const finishError = finishReasonError(choice?.finish_reason)
    if (finishError) return { ok: false, message: finishError, latencyMs: Date.now() - started }
    const reply = choice?.message?.content?.trim() || ''
    if (!reply) {
      return { ok: false, message: '模型已连接，但没有返回文字。请检查模型名称后重试。', latencyMs: Date.now() - started }
    }
    return { ok: true, message: reply, latencyMs: Date.now() - started }
  } catch (e) {
    return {
      ok: false,
      message: modelRequestError(e),
      latencyMs: Date.now() - started
    }
  }
}

/** 流式：发送对话，逐块回调 */
export async function chatStream(
  profile: ModelProfile,
  messages: ChatMessage[],
  onEvent: (ev: ChatStreamEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  let full = ''
  try {
    const timeoutSignal = AbortSignal.timeout(STREAM_REQUEST_TIMEOUT_MS)
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
    const res = await fetch(endpoint(profile.baseURL), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${profile.apiKey}`
      },
      body: JSON.stringify({
        model: profile.model,
        messages: toOpenAIMessages(messages, profile.supportsVision),
        temperature: profile.temperature ?? 0.3,
        stream: true
      }),
      signal: requestSignal
    })

    if (!res.ok) {
      const errText = await readLimitedText(res, MAX_ERROR_RESPONSE_BYTES).catch(() => '')
      const wait = res.status === 429 ? retryAfterSeconds(res) : undefined
      onEvent({
        type: 'error',
        message: `HTTP ${res.status} ${res.statusText} ${errText.slice(0, 300)}${wait ? `；建议等待 ${wait} 秒后重试` : ''}`
      })
      return
    }
    if (!res.body) {
      onEvent({ type: 'error', message: '模型服务没有返回可读取的内容。' })
      return
    }

    const contentType = res.headers.get('content-type') || ''
    if (contentType.includes('text/html')) {
      const html = await readLimitedText(res, MAX_ERROR_RESPONSE_BYTES).catch(() => '')
      onEvent({
        type: 'error',
        message: `端点返回的是网页(HTML)而非流式数据，通常是 Base URL 路径不对——试试在末尾加 /v1。${html.slice(0, 120)}`
      })
      return
    }

    if (contentType.includes('application/json')) {
      const raw = await readLimitedText(res, MAX_SETTINGS_RESPONSE_BYTES)
      try {
        const json = JSON.parse(raw) as {
          error?: { message?: string } | string
          choices?: { message?: { content?: string }; finish_reason?: string | null }[]
        }
        if (json.error) {
          const message = typeof json.error === 'string' ? json.error : json.error.message || '模型返回错误'
          onEvent({ type: 'error', message })
          return
        }
        const choice = json.choices?.[0]
        const finishError = finishReasonError(choice?.finish_reason)
        if (finishError) {
          onEvent({ type: 'error', message: finishError })
          return
        }
        const content = choice?.message?.content?.trim() || ''
        if (!content) {
          onEvent({ type: 'error', message: '模型返回了空内容，请检查模型兼容性或稍后重试。' })
          return
        }
        if (content.length > MAX_MODEL_OUTPUT_CHARS) {
          onEvent({ type: 'error', message: '模型返回内容异常过长，本次结果未保存。请缩小资料范围后重试。' })
          return
        }
        onEvent({ type: 'chunk', delta: content })
        onEvent({ type: 'done', full: content })
        return
      } catch {
        onEvent({ type: 'error', message: `模型返回了无法解析的 JSON：${raw.slice(0, 200)}` })
        return
      }
    }

    const decoder = new TextDecoder()
    let buffer = ''
    let finishReason: string | null | undefined
    const processLine = (line: string): 'continue' | 'done' | 'error' => {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) return 'continue'
      const payload = trimmed.slice(5).trim()
      if (!payload) return 'continue'
      if (payload === '[DONE]') {
        const finishError = finishReasonError(finishReason)
        if (finishError) {
          onEvent({ type: 'error', message: finishError })
          return 'error'
        }
        if (!full.trim()) {
          onEvent({ type: 'error', message: '模型流已结束，但没有返回任何内容。' })
          return 'error'
        }
        onEvent({ type: 'done', full })
        return 'done'
      }
      try {
        const json = JSON.parse(payload) as {
          error?: { message?: string } | string
          choices?: {
            delta?: { content?: string }
            message?: { content?: string }
            finish_reason?: string | null
          }[]
        }
        if (json.error) {
          const message = typeof json.error === 'string' ? json.error : json.error.message || '模型返回错误'
          onEvent({ type: 'error', message })
          return 'error'
        }
        const choice = json.choices?.[0]
        if (choice && choice.finish_reason !== undefined) finishReason = choice.finish_reason
        const finishError = finishReasonError(finishReason)
        if (finishError) {
          onEvent({ type: 'error', message: finishError })
          return 'error'
        }
        const delta = choice?.delta?.content ?? choice?.message?.content
        if (delta) {
          if (full.length + delta.length > MAX_MODEL_OUTPUT_CHARS) {
            onEvent({ type: 'error', message: '模型返回内容异常过长，本次结果未保存。请缩小资料范围后重试。' })
            return 'error'
          }
          full += delta
          onEvent({ type: 'chunk', delta })
        }
      } catch {
        onEvent({ type: 'error', message: '模型返回了损坏的流式数据，本次结果未保存。请重试。' })
        return 'error'
      }
      return 'continue'
    }
    // Node fetch 的 body 是异步可迭代的字节流
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true })
      if (buffer.length > MAX_SSE_EVENT_CHARS) {
        onEvent({ type: 'error', message: '模型返回的单段数据异常过长，本次结果未保存。请重试。' })
        return
      }
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const result = processLine(line)
        if (result !== 'continue') return
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) {
      const result = processLine(buffer)
      if (result !== 'continue') return
    }
    onEvent({
      type: 'error',
      message: full.trim()
        ? '模型连接提前结束，本次内容可能不完整，已保留上一份完整结果。请重试。'
        : '模型连接已结束，但没有收到有效的流式内容。'
    })
  } catch (e) {
    if (signal?.aborted) {
      onEvent({ type: 'done', full })
      return
    }
    const msg = e instanceof Error ? e.message : String(e)
    if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      onEvent({ type: 'error', message: '模型长时间没有响应，已自动停止。请检查网络后重试。' })
      return
    }
    const hint = /fetch failed|ECONNRESET|socket|terminated|network/i.test(msg)
      ? '（连接中断，常见原因是请求过大——截图太多/太大。截图已自动压缩，可减少截图数量或重试；也可能是中转端点不稳定。）'
      : ''
    onEvent({ type: 'error', message: msg + hint })
  }
}
