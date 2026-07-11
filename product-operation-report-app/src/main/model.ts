import type {
  ChatMessage,
  ChatStreamEvent,
  ContentPart,
  ModelListResult,
  ModelProfile,
  TestModelOptions,
  TestModelResult
} from '../shared/types'

/** 拉取 OpenAI 兼容端点的可用模型列表（GET {baseURL}/models） */
export async function listModels(profile: ModelProfile): Promise<ModelListResult> {
  try {
    const base = profile.baseURL.replace(/\/+$/, '')
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${profile.apiKey}` }
    })
    const raw = await res.text()
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
      .filter((x): x is string => !!x)
      .sort()
    return { ok: true, models }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
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
      })
    })

    const raw = await res.text()

    if (!res.ok) {
      return {
        ok: false,
        message: `HTTP ${res.status} ${res.statusText} ${raw.slice(0, 300)}`,
        latencyMs: Date.now() - started
      }
    }

    let data: { choices?: { message?: { content?: string } }[] }
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
    const reply = data.choices?.[0]?.message?.content?.trim() || '(无内容)'
    return { ok: true, message: reply, latencyMs: Date.now() - started }
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : String(e),
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
      signal
    })

    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => '')
      onEvent({ type: 'error', message: `HTTP ${res.status} ${res.statusText} ${errText.slice(0, 300)}` })
      return
    }

    const contentType = res.headers.get('content-type') || ''
    if (contentType.includes('text/html')) {
      const html = await res.text().catch(() => '')
      onEvent({
        type: 'error',
        message: `端点返回的是网页(HTML)而非流式数据，通常是 Base URL 路径不对——试试在末尾加 /v1。${html.slice(0, 120)}`
      })
      return
    }

    const decoder = new TextDecoder()
    let buffer = ''
    // Node fetch 的 body 是异步可迭代的字节流
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const payload = trimmed.slice(5).trim()
        if (payload === '[DONE]') {
          onEvent({ type: 'done', full })
          return
        }
        try {
          const json = JSON.parse(payload) as {
            choices?: { delta?: { content?: string } }[]
          }
          const delta = json.choices?.[0]?.delta?.content
          if (delta) {
            full += delta
            onEvent({ type: 'chunk', delta })
          }
        } catch {
          // 忽略无法解析的行（心跳/注释）
        }
      }
    }
    onEvent({ type: 'done', full })
  } catch (e) {
    if (signal?.aborted) {
      onEvent({ type: 'done', full })
      return
    }
    const msg = e instanceof Error ? e.message : String(e)
    const hint = /fetch failed|ECONNRESET|socket|terminated|network/i.test(msg)
      ? '（连接中断，常见原因是请求过大——截图太多/太大。截图已自动压缩，可减少截图数量或重试；也可能是中转端点不稳定。）'
      : ''
    onEvent({ type: 'error', message: msg + hint })
  }
}
