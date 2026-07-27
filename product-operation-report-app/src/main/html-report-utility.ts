import { markdownToHtmlDocument } from './htmlReport'

interface HtmlReportRequest {
  id: string
  markdown: string
}

const MAX_REPORT_CHARACTERS = 5_000_000
const port = process.parentPort

if (!port) throw new Error('HTML 报告辅助进程启动失败。')

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error || ''))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)
}

function validateRequest(value: unknown): HtmlReportRequest {
  if (!value || typeof value !== 'object') throw new Error('HTML 报告请求无效，请重试。')
  const request = value as Partial<HtmlReportRequest>
  if (typeof request.id !== 'string' || !request.id || request.id.length > 100) {
    throw new Error('HTML 报告请求编号无效，请重试。')
  }
  if (typeof request.markdown !== 'string' || !request.markdown.trim()) {
    throw new Error('报告内容为空，无法导出。')
  }
  if (request.markdown.length > MAX_REPORT_CHARACTERS) {
    throw new Error('报告内容过长，无法导出。')
  }
  return request as HtmlReportRequest
}

port.on('message', async (event) => {
  let id = ''
  try {
    const request = validateRequest(event.data)
    id = request.id
    const html = await markdownToHtmlDocument(request.markdown)
    port.postMessage({ id, ok: true, html })
  } catch (error) {
    port.postMessage({ id, ok: false, error: safeError(error) || 'HTML 报告生成失败，请重试。' })
  }
})

port.postMessage({ type: 'ready' })
