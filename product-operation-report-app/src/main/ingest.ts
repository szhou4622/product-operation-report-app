import * as XLSX from 'xlsx'
import Papa from 'papaparse'
import mammoth from 'mammoth'
import JSZip from 'jszip'
import iconv from 'iconv-lite'
import type { ArchiveItem, ParsedFile } from '../shared/types'

const IMAGE_EXTS = ['png', 'jpg', 'jpeg']
const CONVERTIBLE_IMAGE_EXTS = ['webp', 'gif', 'tif', 'tiff', 'avif', 'heic', 'heif']
const DOC_TABLE_EXTS = [
  'xlsx', 'xls', 'xlsm', 'xlsb', 'ods', 'csv', 'tsv',
  'pdf', 'doc', 'docx', 'pptx',
  ...CONVERTIBLE_IMAGE_EXTS,
  'md', 'markdown', 'txt', 'log', 'yaml', 'yml', 'rtf',
  'json', 'jsonl', 'ndjson', 'html', 'htm', 'xml'
]
const MAX_PARSE_BYTES = 40 * 1024 * 1024
const MAX_ARCHIVE_BYTES = 120 * 1024 * 1024
const MAX_ARCHIVE_ENTRIES = 120
const MAX_ARCHIVE_ITEM_BYTES = 40 * 1024 * 1024
const MAX_ARCHIVE_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_ARCHIVE_TOTAL_BYTES = 120 * 1024 * 1024
const MAX_ARCHIVE_COMPRESSION_RATIO = 300
const MAX_OFFICE_ARCHIVE_ENTRIES = 1000
// 动态清洗会把长内容按安全大小完整分批，因此不再用原来的 100 万字符硬门槛。
// 仍保留 400 万字符的稳定性上限，避免单个恶意 Office/XML 解压后占满内存。
const MAX_EXTRACTED_TEXT_CHARS = 4_000_000
const MAX_PDF_PAGES = 500
const MAX_OFFICE_PAGES = 500
const MAX_XLSX_CELLS = 2_000_000
const MAX_OFFICE_EMBEDDED_IMAGES = 50
const MAX_OFFICE_EMBEDDED_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_OFFICE_EMBEDDED_TOTAL_BYTES = 40 * 1024 * 1024
const MAX_CONVERTED_IMAGE_PAGES = 50
const MAX_CONVERTED_IMAGE_SIDE = 4096
const MAX_CONVERTED_IMAGE_PIXELS = 20_000_000
const MAX_PDF_RENDER_PAGES = 50
const MAX_PDF_RENDER_TOTAL_PIXELS = 80_000_000

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

interface ConvertedImageResult {
  attachments: ArchiveItem[]
  omittedPages: number
}

async function convertRasterToPng(
  bytes: Buffer | Uint8Array,
  parentName: string,
  maxPages = MAX_CONVERTED_IMAGE_PAGES
): Promise<ConvertedImageResult> {
  const sharp = (await import('sharp')).default
  const input = Buffer.from(bytes)
  const metadata = await sharp(input, {
    animated: true,
    failOn: 'error',
    limitInputPixels: MAX_CONVERTED_IMAGE_PIXELS
  }).metadata()
  const pageCount = Math.max(1, metadata.pages || 1)
  const allowedPages = Math.min(pageCount, Math.max(0, maxPages))
  const attachments: ArchiveItem[] = []
  let totalBytes = 0
  for (let page = 0; page < allowedPages; page++) {
    const output = await sharp(input, {
      page,
      pages: 1,
      failOn: 'error',
      limitInputPixels: MAX_CONVERTED_IMAGE_PIXELS
    })
      .rotate()
      .resize({
        width: MAX_CONVERTED_IMAGE_SIDE,
        height: MAX_CONVERTED_IMAGE_SIDE,
        fit: 'inside',
        withoutEnlargement: true
      })
      .png({ compressionLevel: 9 })
      .toBuffer()
    if (
      output.byteLength > MAX_OFFICE_EMBEDDED_IMAGE_BYTES ||
      totalBytes + output.byteLength > MAX_OFFICE_EMBEDDED_TOTAL_BYTES
    ) {
      return { attachments, omittedPages: pageCount - attachments.length }
    }
    totalBytes += output.byteLength
    attachments.push({
      name: `${parentName}/自动转换/${pageCount > 1 ? `第${page + 1}页.png` : '转换图片.png'}`,
      kind: 'image',
      size: output.byteLength,
      dataUrl: `data:image/png;base64,${output.toString('base64')}`,
      ok: true
    })
  }
  return { attachments, omittedPages: pageCount - allowedPages }
}

interface OfficeImageExtraction {
  attachments: ArchiveItem[]
  totalImages: number
  omittedImages: number
}

async function extractOfficeImages(
  zip: JSZip,
  mediaPrefix: RegExp,
  parentName: string,
  pageMap?: Map<string, number[]>
): Promise<OfficeImageExtraction> {
  const mediaNames = Object.keys(zip.files)
    .filter((name) => mediaPrefix.test(name) && !zip.files[name].dir)
    .sort((left, right) => left.localeCompare(right, 'zh'))
  const attachments: ArchiveItem[] = []
  let totalBytes = 0
  let omittedImages = 0
  for (const name of mediaNames) {
    const mediaBaseName = name.split('/').pop() || name
    const relatedPages = pageMap?.get(mediaBaseName) || []
    const mediaParent = `${parentName}/${relatedPages.length ? `第${relatedPages.join('、')}页/` : ''}内嵌图片`
    const e = ext(name)
    if ((!IMAGE_EXTS.includes(e) && !CONVERTIBLE_IMAGE_EXTS.includes(e)) || attachments.length >= MAX_OFFICE_EMBEDDED_IMAGES) {
      omittedImages++
      continue
    }
    const declaredSize = (zip.files[name] as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0
    if (declaredSize > MAX_OFFICE_EMBEDDED_IMAGE_BYTES || totalBytes + declaredSize > MAX_OFFICE_EMBEDDED_TOTAL_BYTES) {
      omittedImages++
      continue
    }
    const bytes = await zip.files[name].async('uint8array')
    if (
      bytes.byteLength > MAX_OFFICE_EMBEDDED_IMAGE_BYTES ||
      totalBytes + bytes.byteLength > MAX_OFFICE_EMBEDDED_TOTAL_BYTES
    ) {
      omittedImages++
      continue
    }
    totalBytes += bytes.byteLength
    if (CONVERTIBLE_IMAGE_EXTS.includes(e)) {
      try {
        const converted = await convertRasterToPng(
          bytes,
          `${mediaParent}/${mediaBaseName}`,
          MAX_OFFICE_EMBEDDED_IMAGES - attachments.length
        )
        const convertedBytes = converted.attachments.reduce((sum, item) => sum + (item.size || 0), 0)
        if (totalBytes + convertedBytes > MAX_OFFICE_EMBEDDED_TOTAL_BYTES) {
          omittedImages += converted.attachments.length + converted.omittedPages
          continue
        }
        totalBytes += convertedBytes
        attachments.push(...converted.attachments)
        omittedImages += converted.omittedPages
      } catch {
        omittedImages++
      }
      continue
    }
    attachments.push({
      name: `${mediaParent}/${mediaBaseName}`,
      kind: 'image',
      size: bytes.byteLength,
      dataUrl: `data:${imageMime(e)};base64,${Buffer.from(bytes).toString('base64')}`,
      ok: true
    })
  }
  return { attachments, totalImages: mediaNames.length, omittedImages }
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
  if (normalized.length > MAX_EXTRACTED_TEXT_CHARS) {
    return {
      name,
      kind,
      text: '',
      ok: false,
      error: `文件解析后超过 ${MAX_EXTRACTED_TEXT_CHARS.toLocaleString()} 个字符。为避免遗漏后部数据，本次未做截断清洗；请按工作表或日期拆成多个文件后上传。`
    }
  }
  return normalized
    ? { name, kind, text: normalized, ok: true }
    : { name, kind, text: '', ok: false, error: emptyError }
}

function meaningfulSheetAddresses(ws: XLSX.WorkSheet): string[] {
  return Object.keys(ws).filter((address) => {
    if (address.startsWith('!')) return false
    const cell = ws[address]
    if (!cell) return false
    if (typeof cell.f === 'string' && cell.f.trim()) return true
    return cell.v !== undefined && cell.v !== null && String(cell.v).trim() !== ''
  })
}

function safeSheetRef(addresses: string[]): string | undefined {
  if (!addresses.length) return undefined
  let minRow = Number.POSITIVE_INFINITY
  let minColumn = Number.POSITIVE_INFINITY
  let maxRow = 0
  let maxColumn = 0
  for (const address of addresses) {
    const cell = XLSX.utils.decode_cell(address)
    minRow = Math.min(minRow, cell.r)
    minColumn = Math.min(minColumn, cell.c)
    maxRow = Math.max(maxRow, cell.r)
    maxColumn = Math.max(maxColumn, cell.c)
  }
  return XLSX.utils.encode_range({ s: { r: minRow, c: minColumn }, e: { r: maxRow, c: maxColumn } })
}

function sheetCellDisplay(cell: XLSX.CellObject): string {
  const value = cell.w ?? cell.v ?? ''
  const extras = [
    typeof cell.f === 'string' && cell.f.trim() ? `公式=${cell.f}` : '',
    cell.l?.Target ? `超链接=${cell.l.Target}` : '',
    ...(cell.c || []).map((comment) => `批注${comment.a ? `(${comment.a})` : ''}=${comment.t || ''}`)
  ].filter(Boolean)
  return [String(value), ...extras].filter(Boolean).join('；')
}

function sheetSupplementalRows(ws: XLSX.WorkSheet, addresses: string[]): string[][] {
  const rows: string[][] = []
  for (const address of addresses) {
    const cell = ws[address]
    if (!cell) continue
    if (typeof cell.f === 'string' && cell.f.trim()) rows.push([address, '公式', cell.f])
    if (cell.l?.Target) rows.push([address, '超链接', cell.l.Target])
    for (const comment of cell.c || []) {
      const text = String(comment.t || '').trim()
      if (text) rows.push([address, comment.a ? `批注（${comment.a}）` : '批注', text])
    }
  }
  return rows
}

function parseXlsx(buf: Buffer): string {
  const wb = XLSX.read(buf, { type: 'buffer' })
  if (wb.SheetNames.length > 100) throw new Error('表格工作表超过 100 个，请只保留本次分析需要的工作表。')
  const parts: string[] = []
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName]
    const addresses = meaningfulSheetAddresses(ws)
    if (addresses.length > MAX_XLSX_CELLS) {
      throw new Error(`工作表“${sheetName}”实际有数据的单元格超过 ${MAX_XLSX_CELLS.toLocaleString()} 个，请拆分后重试。`)
    }
    if (!addresses.length) continue
    // 很多平台导出的 Excel 会把格式刷到几十万行，!ref 因而非常大，但真正有值的格子很少。
    // 只按实际有值/公式的区域导出，既不丢数据，也不会把纯格式空白误判成超大文件。
    const ref = safeSheetRef(addresses)
    if (!ref) continue
    const range = XLSX.utils.decode_range(ref)
    const rectangleCells = (range.e.r - range.s.r + 1) * (range.e.c - range.s.c + 1)
    if (rectangleCells > MAX_XLSX_CELLS) {
      // 极少量单元格散落在很远的行/列时，按常规矩形导出会生成海量空白。
      // 改为坐标清单仍保留每个实际值和公式，让文件继续进入清洗而不是整份失败。
      const sparseRows = [
        ['原单元格位置', '内容'],
        ...addresses
          .slice()
          .sort((left, right) => {
            const a = XLSX.utils.decode_cell(left)
            const b = XLSX.utils.decode_cell(right)
            return a.r - b.r || a.c - b.c
          })
          .map((address) => [address, sheetCellDisplay(ws[address])])
      ]
      parts.push(`### 工作表：${sheetName}（稀疏布局，已保留全部 ${addresses.length} 个有值单元格）\n${Papa.unparse(sparseRows, { newline: '\n' })}`)
      continue
    }
    const safeWs = { ...ws, '!ref': ref }
    const csv = XLSX.utils.sheet_to_csv(safeWs, { blankrows: false })
    if (csv.trim()) {
      const supplemental = sheetSupplementalRows(ws, addresses)
      parts.push([
        `### 工作表：${sheetName}`,
        csv.trim(),
        supplemental.length
          ? `#### 单元格补充证据（公式/超链接/批注）\n${Papa.unparse([['单元格位置', '类型', '内容'], ...supplemental], { newline: '\n' })}`
          : ''
      ].filter(Boolean).join('\n\n'))
    }
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

function parseDelimited(buf: Buffer, forcedDelimiter?: string): CsvParseResult {
  const text = decodeTextBuffer(buf)
  // 用 papaparse 规范化一遍，去除空行；再由 unparse 恢复必要引号，避免含逗号/换行的单元格错列
  const res = Papa.parse<string[]>(text, {
    skipEmptyLines: true,
    ...(forcedDelimiter ? { delimiter: forcedDelimiter } : {})
  })
  const seriousErrors = res.errors.filter((error) => error.code !== 'UndetectableDelimiter')
  if (seriousErrors.length) {
    const first = seriousErrors[0]
    // 不规则导出、未闭合引号、备注中裸换行等情况不应让整份资料退出清洗。
    // 保留完整原文交给后续“通用文本分批”处理；只告知用户结构未标准化。
    return {
      text,
      warning: `表格分隔结构在第 ${(first.row ?? 0) + 1} 行附近不规则，软件已保留完整原文继续清洗；请在资料确认页重点核对该文件。`
    }
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

function parseJsonLike(buf: Buffer, lineDelimited: boolean): CsvParseResult {
  const text = decodeTextBuffer(buf).trim()
  if (!text) return { text: '' }
  try {
    if (lineDelimited) {
      const lines = text.split(/\r?\n/u).filter((line) => line.trim())
      const normalized = lines.map((line) => JSON.stringify(JSON.parse(line))).join('\n')
      return { text: normalized }
    }
    return { text: JSON.stringify(JSON.parse(text), null, 2) }
  } catch {
    return {
      text,
      warning: 'JSON 结构不完全标准，软件已保留完整原文继续清洗；不会因为格式错误丢弃资料。'
    }
  }
}

function parseRtfText(buf: Buffer): string {
  const raw = buf.toString('latin1')
  const codePage = raw.match(/\\ansicpg(\d+)/iu)?.[1]
  const encoding = codePage === '936'
    ? 'gb18030'
    : codePage === '950'
      ? 'big5'
      : codePage === '65001'
        ? 'utf8'
        : 'windows-1252'
  return raw
    // RTF 常把非 ASCII 文本写成连续的 \'hh 字节；必须按文档代码页整段解码，不能逐字节猜测。
    .replace(/(?:\\'[0-9a-f]{2})+/giu, (sequence) => {
      const bytes = [...sequence.matchAll(/\\'([0-9a-f]{2})/giu)].map((match) => Number.parseInt(match[1], 16))
      return iconv.decode(Buffer.from(bytes), encoding)
    })
    .replace(/\\u(-?\d+)\??/giu, (_match, rawPoint) => {
      const signed = Number(rawPoint)
      const point = signed < 0 ? signed + 65_536 : signed
      return Number.isInteger(point) && point >= 0 && point <= 0xffff ? String.fromCharCode(point) : ''
    })
    .replace(/\\(?:par[d]?|line)\b\s?/giu, '\n')
    .replace(/\\tab\b\s?/giu, '\t')
    .replace(/\\([{}\\])/gu, '$1')
    .replace(/\\[a-z]+-?\d*\s?/giu, '')
    .replace(/[{}]/gu, '')
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '
  }
  return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/giu, (match, decimal, hex, name) => {
    if (decimal || hex) {
      const point = decimal ? Number(decimal) : Number.parseInt(hex, 16)
      return Number.isSafeInteger(point) && point >= 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
        ? String.fromCodePoint(point)
        : match
    }
    return named[String(name).toLowerCase()] ?? match
  })
}

function parseHtmlText(buf: Buffer): CsvParseResult {
  const html = decodeTextBuffer(buf)
  const visible = decodeHtmlEntities(
    html
      .replace(/<(?:script|style|noscript|template)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript|template)>/giu, ' ')
      .replace(/<\/(?:td|th)>/giu, '\t')
      .replace(/<\/(?:tr|p|div|li|h[1-6]|section|article)>|<br\s*\/?>/giu, '\n')
      .replace(/<[^>]*>/gu, ' ')
  )
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n[ \t]+/gu, '\n')
    .replace(/[ \t]{2,}/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
  return {
    text: visible,
    warning: visible ? '网页导出文件已提取可见文字和表格文本；外部链接、脚本及远程图片不会执行。' : undefined
  }
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

interface PdfTextResult {
  text: string
  emptyTextPages: number[]
  pageCount: number
  images: ArchiveItem[]
  omittedVisualPages: number[]
}

async function parsePdf(buf: Buffer): Promise<PdfTextResult> {
  ensureWithResolvers()
  const [pdfjs, pdfWorker, canvasApi] = await Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('pdfjs-dist/legacy/build/pdf.worker.mjs'),
    import('@napi-rs/canvas')
  ])
  const canvasGlobals = globalThis as unknown as Record<string, unknown>
  canvasGlobals.DOMMatrix ??= canvasApi.DOMMatrix
  canvasGlobals.ImageData ??= canvasApi.ImageData
  canvasGlobals.Path2D ??= canvasApi.Path2D
  class NapiCanvasFactory {
    create(width: number, height: number) {
      const canvas = canvasApi.createCanvas(width, height)
      return { canvas, context: canvas.getContext('2d') }
    }

    reset(target: { canvas: { width: number; height: number } }, width: number, height: number): void {
      target.canvas.width = width
      target.canvas.height = height
    }

    destroy(target: { canvas: { width: number; height: number } | null; context: unknown }): void {
      if (target.canvas) {
        target.canvas.width = 0
        target.canvas.height = 0
      }
      target.canvas = null
      target.context = null
    }
  }
  ;(
    globalThis as typeof globalThis & {
      pdfjsWorker?: typeof pdfWorker
    }
  ).pdfjsWorker ??= pdfWorker
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buf),
    useSystemFonts: false,
    disableFontFace: true,
    isEvalSupported: false,
    CanvasFactory: NapiCanvasFactory
  } as unknown as Parameters<typeof pdfjs.getDocument>[0])
  const pdf = await loadingTask.promise
  const pageCount = pdf.numPages
  if (pageCount > MAX_PDF_PAGES) {
    await pdf.destroy()
    throw new Error(`PDF 共 ${pageCount} 页，超过 ${MAX_PDF_PAGES} 页上限。请只保留关键页面后重试。`)
  }
  const pages: string[] = []
  const emptyTextPages: number[] = []
  const images: ArchiveItem[] = []
  const omittedVisualPages: number[] = []
  let renderedPixels = 0
  let renderedBytes = 0
  try {
    for (let i = 1; i <= pageCount; i++) {
      const page = await pdf.getPage(i)
      const content = await page.getTextContent()
      const lines: string[] = []
      let current = ''
      let currentY: number | undefined
      for (const item of content.items) {
        if (!('str' in item)) continue
        const textItem = item as { str: string; hasEOL?: boolean; transform?: number[] }
        const y = Array.isArray(textItem.transform) && Number.isFinite(textItem.transform[5])
          ? Number(textItem.transform[5])
          : undefined
        if (current.trim() && y !== undefined && currentY !== undefined && Math.abs(y - currentY) > 2) {
          lines.push(current.trim())
          current = ''
        }
        current += `${current && textItem.str ? ' ' : ''}${textItem.str}`
        if (y !== undefined) currentY = y
        if (textItem.hasEOL) {
          lines.push(current.trim())
          current = ''
          currentY = undefined
        }
      }
      if (current.trim()) lines.push(current.trim())
      const pageText = lines.filter(Boolean).join('\n').trim()
      if (!pageText) emptyTextPages.push(i)
      pages.push(`--- 第 ${i} 页 ---\n${pageText}`)

      const operatorList = await page.getOperatorList()
      const imageOps = new Set([
        pdfjs.OPS.paintImageXObject,
        pdfjs.OPS.paintInlineImageXObject,
        pdfjs.OPS.paintImageMaskXObject,
        pdfjs.OPS.paintSolidColorImageMask
      ].filter((value): value is number => typeof value === 'number'))
      const needsVisualPage = !pageText || operatorList.fnArray.some((operation) => imageOps.has(operation))
      if (needsVisualPage) {
        if (images.length >= MAX_PDF_RENDER_PAGES) {
          omittedVisualPages.push(i)
          continue
        }
        const naturalViewport = page.getViewport({ scale: 1 })
        const maxSideScale = Math.min(
          MAX_CONVERTED_IMAGE_SIDE / Math.max(1, naturalViewport.width),
          MAX_CONVERTED_IMAGE_SIDE / Math.max(1, naturalViewport.height)
        )
        const scale = Math.max(0.5, Math.min(1.5, maxSideScale))
        const viewport = page.getViewport({ scale })
        const width = Math.max(1, Math.ceil(viewport.width))
        const height = Math.max(1, Math.ceil(viewport.height))
        const pixels = width * height
        if (pixels > MAX_CONVERTED_IMAGE_PIXELS || renderedPixels + pixels > MAX_PDF_RENDER_TOTAL_PIXELS) {
          omittedVisualPages.push(i)
          continue
        }
        const canvas = canvasApi.createCanvas(width, height)
        const context = canvas.getContext('2d')
        await page.render({
          canvasContext: context as unknown as CanvasRenderingContext2D,
          viewport
        }).promise
        const output = canvas.toBuffer('image/png')
        if (
          output.byteLength > MAX_OFFICE_EMBEDDED_IMAGE_BYTES ||
          renderedBytes + output.byteLength > MAX_OFFICE_EMBEDDED_TOTAL_BYTES
        ) {
          omittedVisualPages.push(i)
          continue
        }
        renderedPixels += pixels
        renderedBytes += output.byteLength
        images.push({
          name: `PDF页面/第${i}页.png`,
          kind: 'doc',
          size: output.byteLength,
          dataUrl: `data:image/png;base64,${output.toString('base64')}`,
          ok: true
        })
      }
    }
  } finally {
    await pdf.cleanup()
    await pdf.destroy()
  }
  return { text: pages.join('\n\n'), emptyTextPages, pageCount, images, omittedVisualPages }
}

interface DocxTextResult {
  text: string
  images: OfficeImageExtraction
}

async function parseLegacyDoc(buf: Buffer): Promise<string> {
  const { default: WordExtractor } = await import('word-extractor')
  const document = await new WordExtractor().extract(buf)
  const sections = [
    ['正文', document.getBody()],
    ['页眉', document.getHeaders()],
    ['页脚', document.getFooters()],
    ['批注', document.getAnnotations()],
    ['文本框', document.getTextboxes()]
  ] as const
  return sections
    .map(([label, value]) => {
      const normalized = String(value || '').replace(/\u0000/gu, '').trim()
      return normalized ? `--- ${label} ---\n${normalized}` : ''
    })
    .filter(Boolean)
    .join('\n\n')
}

function wordXmlText(xml: string): string {
  return decodeXml(
    xml
      .replace(/<w:tab\b[^>]*\/>/giu, '\t')
      .replace(/<w:br\b[^>]*\/>/giu, '\n')
      .replace(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/giu, '$1')
      .replace(/<\/w:tc>/giu, '\t')
      .replace(/<\/(?:w:tr|w:p)>/giu, '\n')
      .replace(/<[^>]+>/gu, '')
  )
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

async function parseDocx(buf: Buffer): Promise<DocxTextResult> {
  const { value } = await mammoth.extractRawText({ buffer: buf })
  const zip = await JSZip.loadAsync(buf)
  const supplementalNames = Object.keys(zip.files)
    .filter((name) => /^word\/(?:header\d+|footer\d+|footnotes|endnotes|comments)\.xml$/u.test(name))
    .sort((left, right) => left.localeCompare(right, 'zh'))
  const supplemental: string[] = []
  for (const name of supplementalNames) {
    const text = wordXmlText(await zip.files[name].async('string'))
    if (text) supplemental.push(`--- ${name.replace(/^word\//u, '')} ---\n${text}`)
  }
  const images = await extractOfficeImages(zip, /^word\/media\//u, '当前 Word')
  return {
    text: [value.trim(), ...supplemental].filter(Boolean).join('\n\n'),
    images
  }
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

function drawingXmlText(xml: string): string {
  return decodeXml(
    xml
      .replace(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/giu, '$1')
      .replace(/<\/a:tc>/giu, '\t')
      .replace(/<\/(?:a:tr|a:p)>/giu, '\n')
      .replace(/<[^>]+>/gu, '')
  )
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/[ \t]{2,}/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

function relationshipTargets(xml: string, kind: 'media' | 'charts'): string[] {
  const pattern = kind === 'media'
    ? /Target="(?:\.\.\/)?media\/([^"#?]+)"/giu
    : /Target="(?:\.\.\/)?charts\/([^"#?]+)"/giu
  return [...xml.matchAll(pattern)].map((match) => match[1])
}

function chartXmlText(xml: string): string {
  const values = [...xml.matchAll(/<(?:c:v|c:f|a:t)(?:\s[^>]*)?>([\s\S]*?)<\/(?:c:v|c:f|a:t)>/giu)]
    .map((match) => decodeXml(match[1]).trim())
    .filter(Boolean)
  return values.length ? [...new Set(values)].join(' | ') : ''
}

interface PptxTextResult {
  text: string
  images: OfficeImageExtraction
  emptyTextSlides: number[]
  slideCount: number
}

// PPTX 是 zip 包，逐页幻灯片抽取段落/表格文本，并附演讲者备注。
async function parsePptx(buf: Buffer): Promise<PptxTextResult> {
  const zip = await JSZip.loadAsync(buf)
  const names = Object.keys(zip.files)
  const slideNames = names
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => slideNum(a) - slideNum(b))
  if (slideNames.length > MAX_OFFICE_PAGES) {
    throw new Error(`PPTX 共 ${slideNames.length} 页，超过 ${MAX_OFFICE_PAGES} 页上限。请只保留关键页面后重试。`)
  }

  const parts: string[] = []
  const emptyTextSlides: number[] = []
  const mediaPages = new Map<string, number[]>()
  for (const name of slideNames) {
    const xml = await zip.files[name].async('string')
    const body = drawingXmlText(xml)

    // 同序号的演讲者备注
    const n = slideNum(name)
    const relationName = `ppt/slides/_rels/slide${n}.xml.rels`
    let relationXml = ''
    if (zip.files[relationName]) relationXml = await zip.files[relationName].async('string')
    for (const mediaName of relationshipTargets(relationXml, 'media')) {
      const pages = mediaPages.get(mediaName) || []
      if (!pages.includes(n)) pages.push(n)
      mediaPages.set(mediaName, pages)
    }
    const chartTexts: string[] = []
    for (const chartName of relationshipTargets(relationXml, 'charts')) {
      const chartPath = `ppt/charts/${chartName}`
      if (!zip.files[chartPath]) continue
      const chartText = chartXmlText(await zip.files[chartPath].async('string'))
      if (chartText) chartTexts.push(`${chartName}：${chartText}`)
    }
    const noteName = `ppt/notesSlides/notesSlide${n}.xml`
    let note = ''
    if (zip.files[noteName]) {
      const nxml = await zip.files[noteName].async('string')
      note = drawingXmlText(nxml)
    }

    if (!body && !note) emptyTextSlides.push(n)
    let block = `--- 第 ${n} 页 ---\n${body}`
    if (chartTexts.length) block += `\n[图表数据] ${chartTexts.join('\n')}`
    if (note) block += `\n[备注] ${note}`
    parts.push(block)
  }
  return {
    text: parts.join('\n\n'),
    images: await extractOfficeImages(zip, /^ppt\/media\//u, '当前 PPT', mediaPages),
    emptyTextSlides,
    slideCount: slideNames.length
  }
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

  const allEntries = Object.values(zip.files)
    .filter((f) => !f.dir && !isJunkPath(f.name))
    .sort((a, b) => {
      const aExt = ext(a.name.split('/').pop() || a.name)
      const bExt = ext(b.name.split('/').pop() || b.name)
      const aSupported = IMAGE_EXTS.includes(aExt) || DOC_TABLE_EXTS.includes(aExt)
      const bSupported = IMAGE_EXTS.includes(bExt) || DOC_TABLE_EXTS.includes(bExt)
      return Number(bSupported) - Number(aSupported) || a.name.localeCompare(b.name, 'zh')
    })
  // 派生条目有独立安全上限，不占用户的50份顶层文件名额；超过上限必须明确阻止生成，
  // 不能静默保留前若干条后继续分析。
  let overflowEntries = Math.max(0, allEntries.length - MAX_ARCHIVE_ENTRIES)
  const entries = allEntries.slice(0, MAX_ARCHIVE_ENTRIES)

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
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
    if (items.length >= MAX_ARCHIVE_ENTRIES - 1) {
      overflowEntries += entries.length - entryIndex
      break
    }
    const f = entries[entryIndex]
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
          error: `压缩包内文件 ${formatBytes(size)} 超过单条目安全上限 ${formatBytes(MAX_ARCHIVE_ITEM_BYTES)}。为避免漏资料，请拆分或压缩该文件后重新上传。`
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
            error: `压缩包内图片 ${formatBytes(size)} 超过安全上限 ${formatBytes(MAX_ARCHIVE_IMAGE_BYTES)}。为避免漏资料，请压缩该图片后重新上传。`
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
        const derivedItems: ArchiveItem[] = [
          ...(parsed.text || !parsed.ok
            ? [{
                name: entryName,
                kind: parsed.kind,
                size: content.byteLength,
                text: parsed.text,
                ok: parsed.ok,
                error: parsed.error,
                warning: parsed.warning
              } satisfies ArchiveItem]
            : []),
          ...(parsed.attachments || []).map((attachment, attachmentIndex) => ({
            ...attachment,
            name: attachment.name.replace(base, entryName),
            warning: attachmentIndex === 0 && !parsed.text ? parsed.warning : attachment.warning
          }))
        ]
        const remainingSlots = Math.max(0, MAX_ARCHIVE_ENTRIES - 1 - items.length)
        items.push(...derivedItems.slice(0, remainingSlots))
        overflowEntries += Math.max(0, derivedItems.length - remainingSlots)
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

  if (overflowEntries) {
    items.push({
      name: `${name}：压缩包数量提示`,
      kind: 'other',
      ok: false,
      error: `压缩包及其 Office 内嵌内容展开后超过 ${MAX_ARCHIVE_ENTRIES} 个派生条目，仍有 ${overflowEntries} 个内容未进入解析。为避免漏资料，本次不能继续生成，请把这个压缩包拆成两份后重新上传。`
    })
  }

  if (items.length === 0) {
    return [
      {
        name,
        kind: 'other',
        ok: false,
        error: '压缩包里没有可识别的文件（支持图片、Excel/ODS/CSV/TSV、PDF、DOCX、PPTX、Markdown/TXT/RTF、JSON/YAML、网页导出文件）。'
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
    if (e === 'xlsx' || e === 'xls' || e === 'xlsm' || e === 'xlsb' || e === 'ods') {
      if (e !== 'xls') {
        const archiveError = await validateOfficeArchive(name, buf)
        if (archiveError) return { name, kind: 'table', text: '', ok: false, error: archiveError }
      }
      const result = textResult(name, 'table', parseXlsx(buf), '表格中没有可读取的数据。')
      if (e === 'xls') {
        return result.ok
          ? { ...result, warning: '旧版 XLS 已读取全部有值单元格；该格式中的截图、图表和嵌入对象无法可靠提取，如包含关键信息请另存为截图一起上传。' }
          : result
      }
      const zip = await JSZip.loadAsync(buf)
      const images = await extractOfficeImages(zip, e === 'ods' ? /^Pictures\//u : /^xl\/media\//u, '当前表格')
      const extracted = images.attachments.map((item) => ({
        ...item,
        name: item.name.replace('当前表格', name)
      }))
      if (!result.ok && !extracted.length) return result
      const warnings = [
        extracted.length ? `已自动提取 ${extracted.length} 张内嵌图片，软件将把它们归并到原文件中读图` : '',
        images.omittedImages ? `另有 ${images.omittedImages} 张为不支持的格式或超过安全上限，请把关键图片另存为 PNG/JPG 后上传` : ''
      ].filter(Boolean)
      if (images.omittedImages) {
        return {
          ...result,
          text: result.ok ? result.text : '',
          ok: false,
          error: `表格中有 ${images.omittedImages} 张内嵌图片因格式或安全上限未能解析。为避免漏资料，请把关键图片另存为 PNG/JPG 后与表格一起上传。`,
          attachments: extracted
        }
      }
      return {
        ...result,
        text: result.ok ? result.text : '',
        ok: true,
        error: undefined,
        attachments: extracted,
        warning: warnings.length ? `表格的全部有值单元格已读取；${warnings.join('；')}。` : undefined
      }
    }
    if (e === 'csv' || e === 'tsv') {
      const csv = parseDelimited(buf, e === 'tsv' ? '\t' : undefined)
      const result = textResult(name, 'table', csv.text, 'CSV 中没有可读取的数据。')
      return result.ok && csv.warning ? { ...result, warning: csv.warning } : result
    }
    if (e === 'pdf') {
      const parsed = await parsePdf(buf)
      if (parsed.omittedVisualPages.length) {
        return {
          name,
          kind: 'doc',
          text: '',
          ok: false,
          error: `PDF 中第 ${parsed.omittedVisualPages.slice(0, 20).join('、')}${parsed.omittedVisualPages.length > 20 ? '等' : ''} 页需要读图，但自动转换后会超过安全上限。为避免漏页，本次没有继续分析；请把 PDF 按每份不超过 ${MAX_PDF_RENDER_PAGES} 页拆分后重新上传。`
        }
      }
      const hasText = Boolean(parsed.text.replace(/--- 第 \d+ 页 ---/g, '').trim())
      if (!hasText && !parsed.images.length) {
        return { name, kind: 'doc', text: '', ok: false, error: 'PDF 中没有可读取的文字或页面内容。' }
      }
      const result = textResult(name, 'doc', parsed.text, 'PDF 中没有可提取的文字。')
      const warnings = [
        parsed.images.length ? `已自动把 ${parsed.images.length} 个含图片或无文本层的页面转换为图片继续识别` : '',
        parsed.emptyTextPages.length ? `其中第 ${parsed.emptyTextPages.slice(0, 20).join('、')}${parsed.emptyTextPages.length > 20 ? '等' : ''} 页没有文本层，已改走读图` : ''
      ].filter(Boolean)
      return {
        ...result,
        text: result.ok ? result.text : '',
        ok: true,
        error: undefined,
        attachments: parsed.images.map((item) => ({ ...item, name: `${name}/${item.name}` })),
        warning: warnings.length ? `PDF 共 ${parsed.pageCount} 页；${warnings.join('；')}。` : undefined
      }
    }
    if (e === 'docx') {
      const archiveError = await validateOfficeArchive(name, buf)
      if (archiveError) return { name, kind: 'doc', text: '', ok: false, error: archiveError }
      const parsed = await parseDocx(buf)
      const result = textResult(name, 'doc', parsed.text, 'Word 文档中没有可提取的文字。')
      const extracted = parsed.images.attachments.map((item) => ({
        ...item,
        name: item.name.replace('当前 Word', name)
      }))
      if (!result.ok && !extracted.length) return result
      const warnings = [
        extracted.length ? `已自动提取 ${extracted.length} 张内嵌图片，软件将把它们归并到原文件中读图` : '',
        parsed.images.omittedImages ? `另有 ${parsed.images.omittedImages} 张为不支持的格式或超过安全上限，请把关键图片另存为 PNG/JPG 后上传` : ''
      ].filter(Boolean)
      if (parsed.images.omittedImages) {
        return {
          ...result,
          text: result.ok ? result.text : '',
          ok: false,
          error: `Word 文档中有 ${parsed.images.omittedImages} 张内嵌图片未能解析。为避免漏资料，请把关键图片另存为 PNG/JPG 后与文档一起上传。`,
          attachments: extracted
        }
      }
      return {
        ...result,
        text: result.ok ? result.text : '',
        ok: true,
        error: undefined,
        attachments: extracted,
        warning: `Word 文档的文字、表格、页眉页脚及脚注已读取${result.ok ? '' : '（本文档没有可提取的正文文字）'}${warnings.length ? `；${warnings.join('；')}` : ''}。`
      }
    }
    if (e === 'doc') {
      const result = textResult(name, 'doc', await parseLegacyDoc(buf), '旧版 Word 文档中没有可提取的文字。')
      return result.ok
        ? { ...result, warning: '旧版 DOC 已在软件内自动读取正文、页眉页脚、批注和文本框；图片及复杂嵌入对象无法可靠恢复，如有关键图片请同时上传原图。' }
        : result
    }
    if (e === 'pptx') {
      const archiveError = await validateOfficeArchive(name, buf)
      if (archiveError) return { name, kind: 'doc', text: '', ok: false, error: archiveError }
      const parsed = await parsePptx(buf)
      const hasVisibleText = Boolean(parsed.text.replace(/--- 第 \d+ 页 ---/g, '').trim())
      if (!hasVisibleText && !parsed.images.attachments.length) {
        return {
          name,
          kind: 'doc',
          text: '',
          ok: false,
          error: 'PPTX 没有可提取的文字（可能整页是图片）。可把关键页截图上传走读图。'
        }
      }
      const result: ParsedFile = hasVisibleText
        ? textResult(name, 'doc', parsed.text, 'PPTX 中没有可提取的文字。')
        : { name, kind: 'doc', text: '', ok: true }
      const extracted = parsed.images.attachments.map((item) => ({
        ...item,
        name: item.name.replace('当前 PPT', name)
      }))
      const warnings = [
        parsed.emptyTextSlides.length
          ? `第 ${parsed.emptyTextSlides.slice(0, 20).join('、')}${parsed.emptyTextSlides.length > 20 ? '等' : ''} 页没有可提取文字`
          : '',
        extracted.length ? `已自动提取 ${extracted.length} 张内嵌图片，软件将把它们归并到原文件中读图` : '',
        parsed.images.omittedImages ? `另有 ${parsed.images.omittedImages} 张为不支持的格式或超过安全上限` : ''
      ].filter(Boolean)
      if (parsed.images.omittedImages) {
        return {
          ...result,
          text: result.ok ? result.text : '',
          ok: false,
          error: `PPTX 中有 ${parsed.images.omittedImages} 张内嵌图片未能解析。为避免漏资料，请拆分演示文稿，或把关键页面导出为 PNG 后重新上传。`,
          attachments: extracted
        }
      }
      return {
        ...result,
        text: result.ok ? result.text : '',
        ok: true,
        error: undefined,
        attachments: extracted,
        warning: warnings.length
          ? `PPTX 共 ${parsed.slideCount} 页，文字、表格和演讲者备注已读取；${warnings.join('，')}。${parsed.images.omittedImages ? '请把被忽略的关键图片另存为 PNG/JPG 后上传。' : ''}`
          : undefined
      }
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
    if (CONVERTIBLE_IMAGE_EXTS.includes(e)) {
      let converted: ConvertedImageResult
      try {
        converted = await convertRasterToPng(buf, name)
      } catch (error) {
        return {
          name,
          kind: 'doc',
          text: '',
          ok: false,
          error: `软件已尝试自动转换 .${e} 图片，但该文件的编码无法读取${error instanceof Error && error.message ? `：${error.message}` : '。'}。请重新导出为 PNG/JPG。`
        }
      }
      if (!converted.attachments.length || converted.omittedPages) {
        return {
          name,
          kind: 'doc',
          text: '',
          ok: false,
          error: converted.omittedPages
            ? `图片包含多个页面，自动转换后仍有 ${converted.omittedPages} 页会超过安全上限。为避免漏页，请拆分后重新上传。`
            : '图片自动转换后没有可读取的页面。'
        }
      }
      return {
        name,
        kind: 'doc',
        text: '',
        ok: true,
        attachments: converted.attachments,
        warning: `已在软件内自动把 .${e} 转换为 ${converted.attachments.length} 张 PNG 图片继续识别。`
      }
    }
    if (e === 'rtf') {
      return textResult(name, 'doc', parseRtfText(buf), 'RTF 文档中没有可提取的文字。')
    }
    if (e === 'md' || e === 'markdown' || e === 'txt' || e === 'log' || e === 'yaml' || e === 'yml') {
      return textResult(name, 'doc', decodeTextBuffer(buf), '文本文件为空。')
    }
    if (e === 'json' || e === 'jsonl' || e === 'ndjson') {
      const parsed = parseJsonLike(buf, e !== 'json')
      const result = textResult(name, 'doc', parsed.text, 'JSON 文件为空。')
      return result.ok && parsed.warning ? { ...result, warning: parsed.warning } : result
    }
    if (e === 'html' || e === 'htm') {
      const parsed = parseHtmlText(buf)
      const result = textResult(name, 'doc', parsed.text, '网页导出文件中没有可读取的文字。')
      return result.ok && parsed.warning ? { ...result, warning: parsed.warning } : result
    }
    if (e === 'xml') {
      return textResult(name, 'doc', decodeTextBuffer(buf), 'XML 文件为空。')
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
