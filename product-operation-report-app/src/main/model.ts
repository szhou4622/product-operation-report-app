import type {
  ChatMessage,
  ChatStreamEvent,
  ContentPart,
  ModelListResult,
  ModelProfile,
  ModelTokenUsage,
  SearchEvidence,
  SearchVerificationStatus,
  TestModelOptions,
  TestModelResult
} from '../shared/types'

const SETTINGS_REQUEST_TIMEOUT_MS = 20_000
const STREAM_FIRST_BYTE_TIMEOUT_MS = 180_000
const STREAM_IDLE_TIMEOUT_MS = 90_000
const STREAM_ABSOLUTE_TIMEOUT_MS = 15 * 60_000
const MAX_SETTINGS_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_ERROR_RESPONSE_BYTES = 16 * 1024
const MAX_MODEL_OUTPUT_CHARS = 2_000_000
const MAX_MODEL_LIST_ITEMS = 500
const MAX_SSE_EVENT_CHARS = 2_000_000

type ProviderUsage = Record<string, unknown>

function tokenNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value))
    : 0
}

function nestedTokenNumber(value: unknown, key: string): number {
  return value && typeof value === 'object'
    ? tokenNumber((value as Record<string, unknown>)[key])
    : 0
}

/** 兼容 OpenAI/CCG 常见 usage 字段，只接受服务端真实返回的非负整数。 */
export function normalizeProviderUsage(raw: unknown, fallbackModel: string): ModelTokenUsage | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const usage = raw as ProviderUsage
  const inputTokens = tokenNumber(usage.prompt_tokens ?? usage.input_tokens)
  const outputTokens = tokenNumber(usage.completion_tokens ?? usage.output_tokens)
  const reasoningTokens = Math.min(
    outputTokens,
    Math.max(
      nestedTokenNumber(usage.completion_tokens_details, 'reasoning_tokens'),
      nestedTokenNumber(usage.output_tokens_details, 'reasoning_tokens'),
      tokenNumber(usage.reasoning_tokens)
    )
  )
  const cachedInputTokens = Math.max(
    nestedTokenNumber(usage.prompt_tokens_details, 'cached_tokens'),
    nestedTokenNumber(usage.input_tokens_details, 'cached_tokens'),
    tokenNumber(usage.cache_read_input_tokens)
  )
  const cacheCreationInputTokens = Math.max(
    tokenNumber(usage.cache_creation_input_tokens),
    nestedTokenNumber(usage.prompt_tokens_details, 'cache_creation_tokens'),
    nestedTokenNumber(usage.input_tokens_details, 'cache_creation_input_tokens')
  )
  const declaredTotal = tokenNumber(usage.total_tokens)
  if (cachedInputTokens + cacheCreationInputTokens > inputTokens) return undefined
  if (declaredTotal && declaredTotal < inputTokens + outputTokens) return undefined
  return {
    source: 'provider',
    inputTokens,
    outputTokens,
    reasoningTokens,
    cachedInputTokens,
    cacheCreationInputTokens,
    totalTokens: declaredTotal || inputTokens + outputTokens,
    model: fallbackModel.slice(0, 200)
  }
}

function missingUsage(model: string): ModelTokenUsage {
  return {
    source: 'missing',
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    totalTokens: 0,
    model: model.slice(0, 200)
  }
}

function safePublicSearchUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || value.length > 4096) return undefined
  try {
    const parsed = new URL(value)
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return undefined
    const host = parsed.hostname.replace(/^\[|\]$/gu, '').replace(/\.$/u, '').toLowerCase()
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return undefined
    const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u)?.slice(1).map(Number)
    if (ipv4 && (
      ipv4.some((part) => part > 255) || ipv4[0] === 0 || ipv4[0] === 10 || ipv4[0] === 127 ||
      (ipv4[0] === 169 && ipv4[1] === 254) || (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31) ||
      (ipv4[0] === 192 && ipv4[1] === 168) || ipv4[0] >= 224
    )) return undefined
    if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) return undefined
    return value
  } catch {
    return undefined
  }
}

function normalizeSearchEvidence(raw: unknown): SearchEvidence | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const row = raw as Record<string, unknown>
  const url = safePublicSearchUrl(row.url)
  const callId = typeof row.callId === 'string' ? row.callId.slice(0, 200) : ''
  const retrievedAt = typeof row.retrievedAt === 'string' && Number.isFinite(Date.parse(row.retrievedAt))
    ? row.retrievedAt
    : ''
  const allowedPlatforms = new Set<SearchEvidence['platform']>(['天猫', '抖音', '视频号', '小红书', '其他'])
  const platform = typeof row.platform === 'string' && allowedPlatforms.has(row.platform as SearchEvidence['platform'])
    ? row.platform as SearchEvidence['platform']
    : '其他'
  if (!url || !callId || !retrievedAt) return undefined
  return {
    callId,
    url,
    platform,
    ...(typeof row.query === 'string' && row.query ? { query: row.query.slice(0, 500) } : {}),
    ...(typeof row.title === 'string' && row.title ? { title: row.title.slice(0, 300) } : {}),
    retrievedAt
  }
}

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

function modelRequestError(error: unknown, timeoutMs = SETTINGS_REQUEST_TIMEOUT_MS): string {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return `请求超过 ${timeoutMs / 1000} 秒未响应，请检查 Base URL 或网络后重试。`
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
function toOpenAIMessages(
  messages: ChatMessage[],
  supportsVision: boolean,
  model = '',
  enablePromptCache = false
): unknown[] {
  const explicitCacheControl = enablePromptCache && /claude/i.test(model)
  return messages.map((m) => {
    if (typeof m.content === 'string') {
      if (explicitCacheControl && m.role === 'system') {
        return {
          role: m.role,
          content: [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }]
        }
      }
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

function readableHttpError(status: number, statusText: string, raw: string, retryAfter?: number): string {
  let serverMessage = ''
  try {
    const parsed = JSON.parse(raw) as { message?: unknown; error?: unknown }
    if (typeof parsed.message === 'string') serverMessage = parsed.message.trim()
    else if (typeof parsed.error === 'string') serverMessage = parsed.error.trim()
    else if (parsed.error && typeof parsed.error === 'object') {
      const nested = parsed.error as { message?: unknown }
      if (typeof nested.message === 'string') serverMessage = nested.message.trim()
    }
  } catch {
    serverMessage = raw.trim().replace(/\s+/g, ' ').slice(0, 240)
  }
  const fallback = status === 402
    ? '积分不足，本次任务没有扣费。请充值后重试。'
    : `服务请求失败（HTTP ${status}${statusText ? ` ${statusText}` : ''}）。`
  return `HTTP ${status}：${serverMessage || fallback}${retryAfter ? `；建议等待 ${retryAfter} 秒后重试` : ''}`
}

/** 非流式：测试连通性 */
export async function testModel(opts: TestModelOptions): Promise<TestModelResult> {
  const { profile, withImageDataUrl } = opts
  const timeoutMs = Math.min(60_000, Math.max(1_000, opts.timeoutMs ?? SETTINGS_REQUEST_TIMEOUT_MS))
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
        messages: toOpenAIMessages(messages, profile.supportsVision && !!withImageDataUrl, profile.model),
        ...(profile.temperature === undefined ? {} : { temperature: profile.temperature }),
        stream: false
      }),
      signal: AbortSignal.timeout(timeoutMs)
    })

    const raw = await readLimitedText(res, MAX_SETTINGS_RESPONSE_BYTES)

    if (!res.ok) {
      return {
        ok: false,
        message: readableHttpError(res.status, res.statusText, raw),
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
      message: modelRequestError(e, timeoutMs),
      latencyMs: Date.now() - started
    }
  }
}

/** 流式：发送对话，逐块回调 */
export async function chatStream(
  profile: ModelProfile,
  messages: ChatMessage[],
  onEvent: (ev: ChatStreamEvent) => void,
  signal?: AbortSignal,
  policy?: { reasoningEffort?: 'low'; requestHeaders?: Record<string, string>; promptCacheKey?: string }
): Promise<void> {
  let full = ''
  let latestUsage: ModelTokenUsage | undefined
  const seenSearchEvidence = new Set<string>()
  let timeoutReason: 'first-byte' | 'idle' | 'absolute' | undefined
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let receivedBodyChunk = false
  const requestController = new AbortController()
  const armIdleTimeout = (): void => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      timeoutReason = receivedBodyChunk ? 'idle' : 'first-byte'
      requestController.abort()
    }, receivedBodyChunk ? STREAM_IDLE_TIMEOUT_MS : STREAM_FIRST_BYTE_TIMEOUT_MS)
  }
  const absoluteTimer = setTimeout(() => {
    timeoutReason = 'absolute'
    requestController.abort()
  }, STREAM_ABSOLUTE_TIMEOUT_MS)
  const abortFromCaller = (): void => requestController.abort(signal?.reason)
  if (signal?.aborted) abortFromCaller()
  else signal?.addEventListener('abort', abortFromCaller, { once: true })
  armIdleTimeout()
  const finalUsage = (): ModelTokenUsage => latestUsage || missingUsage(profile.model)
  const emitUsage = (raw: unknown, responseModel?: unknown): void => {
    const model = typeof responseModel === 'string' && responseModel ? responseModel : profile.model
    const normalized = normalizeProviderUsage(raw, model)
    if (!normalized) return
    latestUsage = normalized
    onEvent({ type: 'usage', usage: normalized })
  }
  const emitError = (message: string): void => onEvent({ type: 'error', message, usage: finalUsage() })
  const emitDone = (): void => onEvent({ type: 'done', full, usage: finalUsage() })
  try {
    const request = (withReasoningEffort: boolean, withPromptCache: boolean): Promise<Response> => fetch(endpoint(profile.baseURL), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${profile.apiKey}`,
        ...(policy?.requestHeaders || {})
      },
      body: JSON.stringify({
        model: profile.model,
        messages: toOpenAIMessages(messages, profile.supportsVision, profile.model, withPromptCache),
        ...(profile.temperature === undefined ? {} : { temperature: profile.temperature }),
        stream: true,
        stream_options: { include_usage: true },
        ...(withPromptCache && policy?.promptCacheKey ? { prompt_cache_key: policy.promptCacheKey } : {}),
        ...(withReasoningEffort && policy?.reasoningEffort
          ? { reasoning_effort: policy.reasoningEffort }
          : {})
      }),
      signal: requestController.signal
    })
    let res = await request(Boolean(policy?.reasoningEffort), Boolean(policy?.promptCacheKey))
    armIdleTimeout()
    if (!res.ok && (policy?.reasoningEffort || policy?.promptCacheKey) && (res.status === 400 || res.status === 422)) {
      await readLimitedText(res, MAX_ERROR_RESPONSE_BYTES).catch(() => '')
      armIdleTimeout()
      res = await request(false, false)
      armIdleTimeout()
    }

    if (!res.ok) {
      const errText = await readLimitedText(res, MAX_ERROR_RESPONSE_BYTES).catch(() => '')
      const wait = res.status === 429 ? retryAfterSeconds(res) : undefined
      emitError(readableHttpError(res.status, res.statusText, errText, wait))
      return
    }
    if (!res.body) {
      emitError('模型服务没有返回可读取的内容。')
      return
    }

    const contentType = res.headers.get('content-type') || ''
    if (contentType.includes('text/html')) {
      const html = await readLimitedText(res, MAX_ERROR_RESPONSE_BYTES).catch(() => '')
      emitError(`端点返回的是网页(HTML)而非流式数据，通常是 Base URL 路径不对——试试在末尾加 /v1。${html.slice(0, 120)}`)
      return
    }

    if (contentType.includes('application/json')) {
      const raw = await readLimitedText(res, MAX_SETTINGS_RESPONSE_BYTES)
      try {
        const json = JSON.parse(raw) as {
          error?: { message?: string } | string
          choices?: { message?: { content?: string }; finish_reason?: string | null }[]
          usage?: unknown
          model?: unknown
        }
        emitUsage(json.usage, json.model)
        if (json.error) {
          const message = typeof json.error === 'string' ? json.error : json.error.message || '模型返回错误'
          emitError(message)
          return
        }
        const choice = json.choices?.[0]
        const finishError = finishReasonError(choice?.finish_reason)
        if (finishError) {
          emitError(finishError)
          return
        }
        const content = choice?.message?.content?.trim() || ''
        if (!content) {
          emitError('模型返回了空内容，请检查模型兼容性或稍后重试。')
          return
        }
        if (content.length > MAX_MODEL_OUTPUT_CHARS) {
          emitError('模型返回内容异常过长，本次结果未保存。请缩小资料范围后重试。')
          return
        }
        full = content
        onEvent({ type: 'chunk', delta: content })
        emitDone()
        return
      } catch {
        emitError(`模型返回了无法解析的 JSON：${raw.slice(0, 200)}`)
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
          emitError(finishError)
          return 'error'
        }
        if (!full.trim()) {
          emitError('模型流已结束，但没有返回任何内容。')
          return 'error'
        }
        emitDone()
        return 'done'
      }
      try {
        const json = JSON.parse(payload) as {
          type?: string
          status?: SearchVerificationStatus
          search_calls?: number
          evidence_count?: number
          evidence?: unknown
          error?: { message?: string } | string
          choices?: {
            delta?: { content?: string }
            message?: { content?: string }
            finish_reason?: string | null
          }[]
          usage?: unknown
          model?: unknown
        }
        if (json.type === 'por.search_status') {
          if (json.status === 'verified' || json.status === 'attempted' || json.status === 'unavailable') {
            onEvent({
              type: 'search_status',
              status: json.status,
              searchCalls: tokenNumber(json.search_calls),
              evidenceCount: tokenNumber(json.evidence_count)
            })
          }
          return 'continue'
        }
        if (json.type === 'por.search_evidence') {
          const evidence = normalizeSearchEvidence(json.evidence)
          if (evidence && !seenSearchEvidence.has(evidence.url)) {
            seenSearchEvidence.add(evidence.url)
            onEvent({ type: 'search_evidence', evidence })
          }
          return 'continue'
        }
        emitUsage(json.usage, json.model)
        if (json.error) {
          const message = typeof json.error === 'string' ? json.error : json.error.message || '模型返回错误'
          emitError(message)
          return 'error'
        }
        const choice = json.choices?.[0]
        if (choice && choice.finish_reason !== undefined) finishReason = choice.finish_reason
        const finishError = finishReasonError(finishReason)
        if (finishError) {
          emitError(finishError)
          return 'error'
        }
        const delta = choice?.delta?.content ?? choice?.message?.content
        if (delta) {
          if (full.length + delta.length > MAX_MODEL_OUTPUT_CHARS) {
            emitError('模型返回内容异常过长，本次结果未保存。请缩小资料范围后重试。')
            return 'error'
          }
          full += delta
          onEvent({ type: 'chunk', delta })
        }
      } catch {
        emitError('模型返回了损坏的流式数据，本次结果未保存。请重试。')
        return 'error'
      }
      return 'continue'
    }
    // Node fetch 的 body 是异步可迭代的字节流
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      receivedBodyChunk = true
      armIdleTimeout()
      buffer += decoder.decode(chunk, { stream: true })
      if (buffer.length > MAX_SSE_EVENT_CHARS) {
        emitError('模型返回的单段数据异常过长，本次结果未保存。请重试。')
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
    const eofFinishError = finishReasonError(finishReason)
    if (eofFinishError) {
      emitError(eofFinishError)
      return
    }
    // Some OpenAI-compatible gateways close a valid SSE response immediately
    // after finish_reason=stop and omit the optional [DONE] sentinel. The
    // provider has already declared a normal terminal state, so accepting it
    // avoids discarding a complete, already-billed result.
    if (finishReason === 'stop' && full.trim()) {
      emitDone()
      return
    }
    emitError(
      full.trim()
        ? '模型连接提前结束，本次内容可能不完整，已保留上一份完整结果。请重试。'
        : '模型连接已结束，但没有收到有效的流式内容。'
    )
  } catch (e) {
    if (signal?.aborted) {
      emitDone()
      return
    }
    const msg = e instanceof Error ? e.message : String(e)
    if (timeoutReason || (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError'))) {
      emitError(timeoutReason === 'absolute'
        ? '本次模型任务已运行超过15分钟，为保护资料和费用已自动停止。请重试未完成的步骤。'
        : timeoutReason === 'first-byte'
          ? '模型准备本批资料超过180秒仍未开始返回，已自动停止。软件会保留其他已完成内容，请稍后重试本批。'
          : '模型已开始处理，但连续180秒没有返回新数据，已自动停止。请检查网络后重试。')
      return
    }
    const hint = /fetch failed|ECONNRESET|socket|terminated|network/i.test(msg)
      ? '（连接中断，常见原因是请求过大——截图太多/太大。截图已自动压缩，可减少截图数量或重试；也可能是中转端点不稳定。）'
      : ''
    emitError(msg + hint)
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
    clearTimeout(absoluteTimer)
    signal?.removeEventListener('abort', abortFromCaller)
  }
}

export const modelStreamTimeouts = {
  firstByteMs: STREAM_FIRST_BYTE_TIMEOUT_MS,
  idleMs: STREAM_IDLE_TIMEOUT_MS,
  absoluteMs: STREAM_ABSOLUTE_TIMEOUT_MS
}
