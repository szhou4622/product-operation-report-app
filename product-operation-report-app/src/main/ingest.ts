import * as XLSX from 'xlsx'
import Papa from 'papaparse'
import mammoth from 'mammoth'
import JSZip from 'jszip'
import iconv from 'iconv-lite'
import type { ArchiveItem, ParsedFile } from '../shared/types'

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif']
const DOC_TABLE_EXTS = ['xlsx', 'xls', 'csv', 'pdf', 'docx', 'pptx', 'md', 'markdown', 'txt']
const MAX_PARSE_BYTES = 40 * 1024 * 1024
const MAX_ARCHIVE_BYTES = 120 * 1024 * 1024
const MAX_ARCHIVE_ENTRIES = 120
const MAX_ARCHIVE_ITEM_BYTES = 40 * 1024 * 1024
const MAX_ARCHIVE_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_ARCHIVE_TOTAL_BYTES = 120 * 1024 * 1024
const MAX_ARCHIVE_COMPRESSION_RATIO = 300
const MAX_OFFICE_ARCHIVE_ENTRIES = 1000
const MAX_EXTRACTED_TEXT_CHARS = 1_000_000
const MAX_PDF_PAGES = 500
const MAX_OFFICE_PAGES = 500
const MAX_XLSX_CELLS = 2_000_000

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

function textResult(
  name: string,
  kind: ParsedFile['kind'],
  text: string,
  emptyError: string
): ParsedFile {
  const normalized = text.trim()
  const bounded =
    normalized.length > MAX_EXTRACTED_TEXT_CHARS
      ? `${normalized.slice(0, MAX_EXTRACTED_TEXT_CHARS)}\n\n[内容过长，已保留前 ${MAX_EXTRACTED_TEXT_CHARS.toLocaleString()} 个字符。建议拆分文件后分批分析。]`
      : normalized
  return bounded
    ? { name, kind, text: bounded, ok: true }
    : { name, kind, text: '', ok: false, error: emptyError }
}

function parseXlsx(buf: Buffer): string {
  const wb = XLSX.read(buf, { type: 'buffer' })
  if (wb.SheetNames.length > 100) throw new Error('表格工作表超过 100 个，请只保留本次分析需要的工作表。')
  const parts: string[] = []
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName]
    if (ws['!ref']) {
      const range = XLSX.utils.decode_range(ws['!ref'])
      const cells = (range.e.r - range.s.r + 1) * (range.e.c - range.s.c + 1)
      if (cells > MAX_XLSX_CELLS) {
        throw new Error(`工作表“${sheetName}”范围过大，请删除空白行列或拆分后重试。`)
      }
    }
    const csv = XLSX.utils.sheet_to_csv(ws, { blankrows: false })
    if (csv.trim()) parts.push(`### 工作表：${sheetName}\n${csv.trim()}`)
  }
  return parts.join('\n\n')
}

function decodeTextBuffer(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return iconv.decode(buf.subarray(2), 'utf16-le')
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return iconv.decode(buf.subarray(2), 'utf16-be')
  }
  const sampleLength = Math.min(buf.length - (buf.length % 2), 8192)
  let evenZeros = 0
  let oddZeros = 0
  for (let index = 0; index < sampleLength; index += 2) {
    if (buf[index] === 0) evenZeros++
    if (buf[index + 1] === 0) oddZeros++
  }
  if (oddZeros >= 4 && oddZeros > evenZeros * 3) {
    return iconv.decode(buf, 'utf16-le')
  }
  if (evenZeros >= 4 && evenZeros > oddZeros * 3) {
    return iconv.decode(buf, 'utf16-be')
  }
  let utf8: string
  try {
    utf8 = new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    utf8 = ''
  }
  const hasUtf8Bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
  const cjkCount = (value: string): number => (value.match(/[\u3400-\u9fff]/g) || []).length
  const suspiciousCount = (value: string): number => (value.match(/[\u0370-\u052f]/g) || []).length
  // UTF-8 是 Markdown 的默认编码。只有 UTF-8 严格解码失败，或出现典型的中文编码误判特征时，
  // 才加载 GB18030 结果；不再依赖不同 Electron/Node 版本对 TextDecoder('gb18030') 的支持情况。
  let text = utf8
  if (!utf8) {
    text = iconv.decode(buf, 'gb18030')
  } else if (!hasUtf8Bom && suspiciousCount(utf8) > 0) {
    const gb18030 = iconv.decode(buf, 'gb18030')
    if (cjkCount(gb18030) > cjkCount(utf8)) text = gb18030
  }
  return text.replace(/^\uFEFF/, '')
}

interface CsvParseResult {
  text: string
  warning?: string
}

function parseCsv(buf: Buffer): CsvParseResult {
  const text = decodeTextBuffer(buf)
  // 用 papaparse 规范化一遍，去除空行；再由 unparse 恢复必要引号，避免含逗号/换行的单元格错列
  const res = Papa.parse<string[]>(text, { skipEmptyLines: true })
  const seriousErrors = res.errors.filter((error) => error.code !== 'UndetectableDelimiter')
  if (seriousErrors.length) {
    const first = seriousErrors[0]
    throw new Error(`CSV 格式不完整（第 ${(first.row ?? 0) + 1} 行附近），请用 Excel 重新另存为 CSV 后再上传。`)
  }
  const rows = res.data as string[][]
  if (!rows.length) return { text: '' }

  // 经营平台导出的 CSV 经常只有少数行缺列、多一个尾逗号或备注中带未转义逗号。
  // 这些情况不应让整份资料失败：以最常见列数为基准，安全补齐尾部空值、删除多余尾空列；
  // 对无法判断位置的额外非空字段则完整保留，不擅自合并或丢数据。
  const widthCounts = new Map<number, number>()
  for (const row of rows) widthCounts.set(row.length, (widthCounts.get(row.length) || 0) + 1)
  let expectedColumns = rows[0]?.length ?? 0
  let expectedCount = widthCounts.get(expectedColumns) || 0
  for (const [width, count] of widthCounts) {
    if (count > expectedCount) {
      expectedColumns = width
      expectedCount = count
    }
  }

  const mismatchedRows: number[] = []
  let preservedExtraRows = 0
  const normalizedRows = rows.map((row, index) => {
    if (row.length === expectedColumns) return row
    mismatchedRows.push(index + 1)
    if (row.length < expectedColumns) {
      return [...row, ...Array.from({ length: expectedColumns - row.length }, () => '')]
    }
    const extra = row.slice(expectedColumns)
    if (extra.every((cell) => !String(cell ?? '').trim())) return row.slice(0, expectedColumns)
    preservedExtraRows++
    return row
  })

  const warning = mismatchedRows.length
    ? `检测到 ${mismatchedRows.length} 行的列数不一致（最早在第 ${mismatchedRows[0]} 行），软件已自动兼容并继续分析。${preservedExtraRows ? `其中 ${preservedExtraRows} 行含额外内容，已完整保留，未删除数据。` : '缺少的尾部空值已自动补齐。'}`
    : undefined
  return { text: Papa.unparse(normalizedRows, { newline: '\n' }), warning }
}

async function validateOfficeArchive(name: string, buf: Buffer): Promise<string | undefined> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(buf)
  } catch {
    return `${name} 文件结构损坏或不是有效的 Office 文件。`
  }
  const entries = Object.values(zip.files).filter((entry) => !entry.dir)
  if (entries.length > MAX_OFFICE_ARCHIVE_ENTRIES) {
    return `${name} 内部文件数量异常，已停止解析以保护软件稳定性。`
  }
  let total = 0
  for (const entry of entries) {
    const meta = (entry as unknown as {
      _data?: { uncompressedSize?: number; compressedSize?: number }
    })._data
    const uncompressedSize = meta?.uncompressedSize ?? 0
    const compressedSize = meta?.compressedSize ?? 0
    total += uncompressedSize
    if (uncompressedSize > MAX_ARCHIVE_ITEM_BYTES) {
      return `${name} 内部单个文件解压后超过 ${formatBytes(MAX_ARCHIVE_ITEM_BYTES)}，请精简后重试。`
    }
    if (
      compressedSize > 0 &&
      uncompressedSize > 1024 * 1024 &&
      uncompressedSize / compressedSize > MAX_ARCHIVE_COMPRESSION_RATIO
    ) {
      return `${name} 的内部压缩比例异常，已停止解析以保护软件稳定性。`
    }
  }
  if (total > MAX_ARCHIVE_TOTAL_BYTES) {
    return `${name} 解压后的预计体积超过 ${formatBytes(MAX_ARCHIVE_TOTAL_BYTES)}，请精简后重试。`
  }
  return undefined
}

async function parsePdf(buf: Buffer): Promise<string> {
  ensureWithResolvers()
  const [pdfjs, pdfWorker] = await Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('pdfjs-dist/legacy/build/pdf.worker.mjs')
  ])
  ;(
    globalThis as typeof globalThis & {
      pdfjsWorker?: typeof pdfWorker
    }
  ).pdfjsWorker ??= pdfWorker
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buf),
    useSystemFonts: true,
    isEvalSupported: false
  })
  const pdf = await loadingTask.promise
  if (pdf.numPages > MAX_PDF_PAGES) {
    await pdf.destroy()
    throw new Error(`PDF 共 ${pdf.numPages} 页，超过 ${MAX_PDF_PAGES} 页上限。请只保留关键页面后重试。`)
  }
  const pages: string[] = []
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i)
      const content = await page.getTextContent()
      const strings = content.items
        .map((it) => ('str' in it ? (it as { str: string }).str : ''))
        .join(' ')
      pages.push(`--- 第 ${i} 页 ---\n${strings.trim()}`)
    }
  } finally {
    await pdf.cleanup()
    await pdf.destroy()
  }
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
  if (slideNames.length > MAX_OFFICE_PAGES) {
    throw new Error(`PPTX 共 ${slideNames.length} 页，超过 ${MAX_OFFICE_PAGES} 页上限。请只保留关键页面后重试。`)
  }

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
      size: buf.length,
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

  let declaredTotal = 0
  for (const entry of entries) {
    const meta = (entry as unknown as {
      _data?: { uncompressedSize?: number; compressedSize?: number }
    })._data
    const uncompressedSize = meta?.uncompressedSize ?? 0
    const compressedSize = meta?.compressedSize ?? 0
    declaredTotal += uncompressedSize
    if (
      compressedSize > 0 &&
      uncompressedSize > 1024 * 1024 &&
      uncompressedSize / compressedSize > MAX_ARCHIVE_COMPRESSION_RATIO
    ) {
      return [{
        name,
        kind: 'other',
        ok: false,
        error: `压缩包内文件「${entry.name}」压缩比异常，已停止解压以保护软件稳定性。`
      }]
    }
  }
  if (declaredTotal > MAX_ARCHIVE_TOTAL_BYTES) {
    return [{
      name,
      kind: 'other',
      ok: false,
      error: `压缩包解压后预计 ${formatBytes(declaredTotal)}，超过总上限 ${formatBytes(MAX_ARCHIVE_TOTAL_BYTES)}，请拆分后上传。`
    }]
  }

  const items: ArchiveItem[] = []
  let actualTotal = 0
  for (const f of entries) {
    const base = f.name.split('/').pop() || f.name
    const entryName = f.name.replace(/^\/+/, '')
    const fe = ext(base)
    const size = (f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0
    try {
      if (size > MAX_ARCHIVE_ITEM_BYTES) {
        items.push({
          name: entryName,
          kind: 'other',
          size,
          ok: false,
          error: `已忽略：压缩包内文件 ${formatBytes(size)} 超过上限 ${formatBytes(MAX_ARCHIVE_ITEM_BYTES)}。`
        })
        continue
      }
      if (IMAGE_EXTS.includes(fe)) {
        if (size > MAX_ARCHIVE_IMAGE_BYTES) {
          items.push({
            name: entryName,
            kind: 'other',
            size,
            ok: false,
            error: `已忽略：图片 ${formatBytes(size)} 过大，请压缩到 ${formatBytes(MAX_ARCHIVE_IMAGE_BYTES)} 以内。`
          })
          continue
        }
        const bytes = await f.async('uint8array')
        actualTotal += bytes.byteLength
        if (actualTotal > MAX_ARCHIVE_TOTAL_BYTES) {
          return [{ name, kind: 'other', ok: false, error: `压缩包实际解压量超过 ${formatBytes(MAX_ARCHIVE_TOTAL_BYTES)}，已停止处理。` }]
        }
        const b64 = Buffer.from(bytes).toString('base64')
        items.push({ name: entryName, kind: 'image', size: bytes.byteLength, dataUrl: `data:${imageMime(fe)};base64,${b64}`, ok: true })
      } else if (DOC_TABLE_EXTS.includes(fe)) {
        const content = await f.async('arraybuffer')
        actualTotal += content.byteLength
        if (actualTotal > MAX_ARCHIVE_TOTAL_BYTES) {
          return [{ name, kind: 'other', ok: false, error: `压缩包实际解压量超过 ${formatBytes(MAX_ARCHIVE_TOTAL_BYTES)}，已停止处理。` }]
        }
        const parsed = await parseFile(base, content)
        items.push({
          name: entryName,
          kind: parsed.kind,
          size: content.byteLength,
          text: parsed.text,
          ok: parsed.ok,
          error: parsed.error,
          warning: parsed.warning
        })
      } else {
        items.push({
          name: entryName,
          kind: 'other',
          size,
          ok: false,
          error: `已忽略：暂不支持 .${fe || '未知'} 文件。`
        })
      }
    } catch (err) {
      items.push({
        name: entryName,
        kind: 'other',
        size,
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      })
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
      if (e === 'xlsx') {
        const archiveError = await validateOfficeArchive(name, buf)
        if (archiveError) return { name, kind: 'table', text: '', ok: false, error: archiveError }
      }
      return textResult(name, 'table', parseXlsx(buf), '表格中没有可读取的数据。')
    }
    if (e === 'csv') {
      const csv = parseCsv(buf)
      const result = textResult(name, 'table', csv.text, 'CSV 中没有可读取的数据。')
      return result.ok && csv.warning ? { ...result, warning: csv.warning } : result
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
      const archiveError = await validateOfficeArchive(name, buf)
      if (archiveError) return { name, kind: 'doc', text: '', ok: false, error: archiveError }
      return textResult(name, 'doc', await parseDocx(buf), 'Word 文档中没有可提取的文字。')
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
      const archiveError = await validateOfficeArchive(name, buf)
      if (archiveError) return { name, kind: 'doc', text: '', ok: false, error: archiveError }
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
      return textResult(name, 'doc', decodeTextBuffer(buf), '文本文件为空。')
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
