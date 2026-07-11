import * as XLSX from 'xlsx'
import Papa from 'papaparse'
import mammoth from 'mammoth'
import JSZip from 'jszip'
import type { ArchiveItem, ParsedFile } from '../shared/types'

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif']
const DOC_TABLE_EXTS = ['xlsx', 'xls', 'csv', 'pdf', 'docx', 'doc', 'pptx', 'ppt', 'md', 'markdown', 'txt']
const MAX_PARSE_BYTES = 80 * 1024 * 1024
const MAX_ARCHIVE_BYTES = 120 * 1024 * 1024
const MAX_ARCHIVE_ENTRIES = 120
const MAX_ARCHIVE_ITEM_BYTES = 80 * 1024 * 1024
const MAX_ARCHIVE_IMAGE_BYTES = 25 * 1024 * 1024

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)}MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`
  return `${bytes}B`
}

function imageMime(e: string): string {
  if (e === 'png') return 'image/png'
  if (e === 'gif') return 'image/gif'
  if (e === 'webp') return 'image/webp'
  return 'image/jpeg'
}

function isJunkPath(path: string): boolean {
  const base = path.split('/').pop() || path
  return base.startsWith('.') || base.startsWith('~$') || base === 'Thumbs.db' || path.includes('__MACOSX')
}

// pdfjs v4 在 Node 20 上需要 Promise.withResolvers（Node 22+ 才内置），这里补丁
function ensureWithResolvers(): void {
  const P = Promise as unknown as { withResolvers?: () => unknown }
  if (typeof P.withResolvers !== 'function') {
    P.withResolvers = function <T>() {
      let resolve!: (v: T | PromiseLike<T>) => void
      let reject!: (e?: unknown) => void
      const promise = new Promise<T>((res, rej) => {
        resolve = res
        reject = rej
      })
      return { promise, resolve, reject }
    }
  }
}

function ext(name: string): string {
  return name.toLowerCase().split('.').pop() || ''
}

function parseXlsx(buf: Buffer): string {
  const wb = XLSX.read(buf, { type: 'buffer' })
  const parts: string[] = []
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName]
    const csv = XLSX.utils.sheet_to_csv(ws, { blankrows: false })
    if (csv.trim()) parts.push(`### 工作表：${sheetName}\n${csv.trim()}`)
  }
  return parts.join('\n\n')
}

function parseCsv(buf: Buffer): string {
  const text = buf.toString('utf8')
  // 用 papaparse 规范化一遍，去除空行
  const res = Papa.parse<string[]>(text, { skipEmptyLines: true })
  return (res.data as string[][]).map((row) => row.join(',')).join('\n')
}

async function parsePdf(buf: Buffer): Promise<string> {
  ensureWithResolvers()
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buf),
    useSystemFonts: true,
    isEvalSupported: false
  })
  const pdf = await loadingTask.promise
  const pages: string[] = []
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const content = await page.getTextContent()
    const strings = content.items
      .map((it) => ('str' in it ? (it as { str: string }).str : ''))
      .join(' ')
    pages.push(`--- 第 ${i} 页 ---\n${strings.trim()}`)
  }
  await pdf.cleanup()
  return pages.join('\n\n')
}

async function parseDocx(buf: Buffer): Promise<string> {
  const { value } = await mammoth.extractRawText({ buffer: buf })
  return value.trim()
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function slideNum(name: string): number {
  const m = name.match(/(\d+)\.xml$/)
  return m ? parseInt(m[1], 10) : 0
}

// PPTX 是 zip 包，逐页幻灯片(ppt/slides/slideN.xml)抽 <a:t> 文本，并附演讲者备注
async function parsePptx(buf: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf)
  const names = Object.keys(zip.files)
  const slideNames = names
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => slideNum(a) - slideNum(b))

  const parts: string[] = []
  for (const name of slideNames) {
    const xml = await zip.files[name].async('string')
    const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXml(m[1]))
    const body = texts.join(' ').replace(/\s+/g, ' ').trim()

    // 同序号的演讲者备注
    const n = slideNum(name)
    const noteName = `ppt/notesSlides/notesSlide${n}.xml`
    let note = ''
    if (zip.files[noteName]) {
      const nxml = await zip.files[noteName].async('string')
      note = [...nxml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
        .map((m) => decodeXml(m[1]))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
    }

    let block = `--- 第 ${n} 页 ---\n${body}`
    if (note) block += `\n[备注] ${note}`
    parts.push(block)
  }
  return parts.join('\n\n')
}

// 解压 zip，逐个解析里面支持的文件，展开成多个条目
export async function parseArchive(name: string, data: ArrayBuffer): Promise<ArchiveItem[]> {
  const buf = Buffer.from(data)
  if (buf.length > MAX_ARCHIVE_BYTES) {
    return [{
      name,
      kind: 'other',
      ok: false,
      error: `压缩包 ${formatBytes(buf.length)} 超过上限 ${formatBytes(MAX_ARCHIVE_BYTES)}，请拆分后上传。`
    }]
  }
  if (ext(name) !== 'zip') {
    return [{ name, kind: 'other', ok: false, error: `不是 zip 压缩包：.${ext(name)}` }]
  }
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(buf)
  } catch (err) {
    return [{ name, kind: 'other', ok: false, error: '压缩包无法解析：' + (err instanceof Error ? err.message : String(err)) }]
  }

  const entries = Object.values(zip.files)
    .filter((f) => !f.dir && !isJunkPath(f.name))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'))

  if (entries.length > MAX_ARCHIVE_ENTRIES) {
    return [{
      name,
      kind: 'other',
      ok: false,
      error: `压缩包内文件数 ${entries.length} 超过上限 ${MAX_ARCHIVE_ENTRIES}，请只保留本次分析需要的资料。`
    }]
  }

  const items: ArchiveItem[] = []
  for (const f of entries) {
    const base = f.name.split('/').pop() || f.name
    const fe = ext(base)
    const size = (f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0
    try {
      if (size > MAX_ARCHIVE_ITEM_BYTES) {
        items.push({
          name: base,
          kind: 'other',
          ok: false,
          error: `已忽略：压缩包内文件 ${formatBytes(size)} 超过上限 ${formatBytes(MAX_ARCHIVE_ITEM_BYTES)}。`
        })
        continue
      }
      if (IMAGE_EXTS.includes(fe)) {
        if (size > MAX_ARCHIVE_IMAGE_BYTES) {
          items.push({
            name: base,
            kind: 'other',
            ok: false,
            error: `已忽略：图片 ${formatBytes(size)} 过大，请压缩到 ${formatBytes(MAX_ARCHIVE_IMAGE_BYTES)} 以内。`
          })
          continue
        }
        const b64 = await f.async('base64')
        items.push({ name: base, kind: 'image', dataUrl: `data:${imageMime(fe)};base64,${b64}`, ok: true })
      } else if (DOC_TABLE_EXTS.includes(fe)) {
        const content = await f.async('arraybuffer')
        const parsed = await parseFile(base, content)
        items.push({ name: base, kind: parsed.kind, text: parsed.text, ok: parsed.ok, error: parsed.error })
      } else {
        items.push({
          name: base,
          kind: 'other',
          ok: false,
          error: `已忽略：暂不支持 .${fe || '未知'} 文件。`
        })
      }
    } catch (err) {
      items.push({ name: base, kind: 'other', ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }

  if (items.length === 0) {
    return [
      {
        name,
        kind: 'other',
        ok: false,
        error: '压缩包里没有可识别的文件（支持截图/CSV/XLSX/PDF/Word/PPT/Markdown）。'
      }
    ]
  }
  return items
}

export async function parseFile(name: string, data: ArrayBuffer): Promise<ParsedFile> {
  const buf = Buffer.from(data)
  const e = ext(name)
  if (buf.length > MAX_PARSE_BYTES) {
    return {
      name,
      kind: 'other',
      text: '',
      ok: false,
      error: `文件 ${formatBytes(buf.length)} 超过上限 ${formatBytes(MAX_PARSE_BYTES)}，请拆分或只上传关键内容。`
    }
  }
  try {
    if (e === 'xlsx' || e === 'xls') {
      return { name, kind: 'table', text: parseXlsx(buf), ok: true }
    }
    if (e === 'csv') {
      return { name, kind: 'table', text: parseCsv(buf), ok: true }
    }
    if (e === 'pdf') {
      const text = await parsePdf(buf)
      if (!text.replace(/--- 第 \d+ 页 ---/g, '').trim()) {
        return {
          name,
          kind: 'doc',
          text: '',
          ok: false,
          error: 'PDF 没有可提取的文本层（可能是扫描件）。可改为截图上传走读图，或二期接 OCR。'
        }
      }
      return { name, kind: 'doc', text, ok: true }
    }
    if (e === 'docx') {
      return { name, kind: 'doc', text: await parseDocx(buf), ok: true }
    }
    if (e === 'doc') {
      return {
        name,
        kind: 'doc',
        text: '',
        ok: false,
        error: '暂不支持旧版 .doc，请在 Word 里另存为 .docx 后再上传。'
      }
    }
    if (e === 'pptx') {
      const text = await parsePptx(buf)
      if (!text.replace(/--- 第 \d+ 页 ---/g, '').trim()) {
        return {
          name,
          kind: 'doc',
          text: '',
          ok: false,
          error: 'PPTX 没有可提取的文字（可能整页是图片）。可把关键页截图上传走读图。'
        }
      }
      return { name, kind: 'doc', text, ok: true }
    }
    if (e === 'ppt') {
      return {
        name,
        kind: 'doc',
        text: '',
        ok: false,
        error: '暂不支持旧版 .ppt，请在 PowerPoint 里另存为 .pptx 后再上传。'
      }
    }
    if (e === 'md' || e === 'markdown' || e === 'txt') {
      return { name, kind: 'doc', text: buf.toString('utf8').trim(), ok: true }
    }
    return { name, kind: 'other', text: '', ok: false, error: `暂不支持的文件类型：.${e}` }
  } catch (err) {
    return {
      name,
      kind: 'other',
      text: '',
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}
