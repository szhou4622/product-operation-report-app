import { dialog } from 'electron'
import { rename, rm, writeFile } from 'fs/promises'
import type { ExportResult } from '../shared/types'

async function writeExportAtomically(filePath: string, content: string | Uint8Array): Promise<void> {
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`
  try {
    await writeFile(temp, content)
    await rename(temp, filePath)
  } finally {
    await rm(temp, { force: true }).catch(() => undefined)
  }
}

export async function exportMarkdown(content: string, defaultName: string): Promise<ExportResult> {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: '导出 Markdown',
    defaultPath: defaultName.endsWith('.md') ? defaultName : `${defaultName}.md`,
    filters: [{ name: 'Markdown', extensions: ['md'] }]
  })
  if (canceled || !filePath) return { ok: false, canceled: true }
  try {
    await writeExportAtomically(filePath, Buffer.from(content, 'utf8'))
    return { ok: true, path: filePath }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function exportDocx(content: string, defaultName: string): Promise<ExportResult> {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: '导出 Word',
    defaultPath: defaultName.endsWith('.docx') ? defaultName : `${defaultName}.docx`,
    filters: [{ name: 'Word', extensions: ['docx'] }]
  })
  if (canceled || !filePath) return { ok: false, canceled: true }
  try {
    const buffer = await markdownToDocxBuffer(content)
    await writeExportAtomically(filePath, buffer)
    return { ok: true, path: filePath }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function exportHtml(content: string, defaultName: string): Promise<ExportResult> {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: '导出 HTML',
    defaultPath: defaultName.endsWith('.html') ? defaultName : `${defaultName}.html`,
    filters: [{ name: 'HTML', extensions: ['html'] }]
  })
  if (canceled || !filePath) return { ok: false, canceled: true }
  try {
    const html = await markdownToHtmlDocument(content)
    await writeExportAtomically(filePath, Buffer.from(html, 'utf8'))
    return { ok: true, path: filePath }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// 去掉行内 Markdown 标记，导出为纯文本（Word 里用样式表达层级/表格）
function stripInline(s: string): string {
  return (s || '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/`(.*?)`/g, '$1')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .trim()
}

function extractTitle(md: string): string {
  const h1 = md.match(/^#\s+(.+)$/m)?.[1]
  return stripInline(h1 || '产品经营报告')
}

function extractHeadings(md: string): { level: number; text: string; id: string }[] {
  const used = new Map<string, number>()
  return md
    .split('\n')
    .map((line) => line.match(/^(#{2,3})\s+(.+)$/))
    .filter((m): m is RegExpMatchArray => Boolean(m))
    .map((m) => {
      const text = stripInline(m[2])
      const base =
        text
          .toLowerCase()
          .replace(/[^\p{L}\p{N}]+/gu, '-')
          .replace(/^-+|-+$/g, '') || 'section'
      const n = used.get(base) || 0
      used.set(base, n + 1)
      return { level: m[1].length, text, id: n ? `${base}-${n + 1}` : base }
    })
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&#(\d+);?/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);?/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&colon;/gi, ':')
    .replace(/&tab;/gi, '\t')
    .replace(/&newline;/gi, '\n')
}

const BLOCKED_HTML_TAGS = new Set([
  'script',
  'iframe',
  'object',
  'embed',
  'link',
  'meta',
  'base',
  'form',
  'input',
  'button',
  'style'
])

const ALLOWED_HTML_TAGS = new Set([
  'a',
  'blockquote',
  'br',
  'code',
  'del',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'img',
  'li',
  'ol',
  'p',
  'pre',
  's',
  'strong',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul'
])

const GLOBAL_SAFE_ATTRS = new Set(['id', 'class', 'title'])
const SAFE_ATTRS_BY_TAG: Record<string, Set<string>> = {
  a: new Set(['href', 'title']),
  img: new Set(['src', 'alt', 'title']),
  td: new Set(['align', 'colspan', 'rowspan']),
  th: new Set(['align', 'colspan', 'rowspan'])
}

function isDangerousUrl(value: string): boolean {
  const normalized = decodeHtmlEntities(value).replace(/[\u0000-\u001f\u007f\s]+/g, '').toLowerCase()
  return /^(javascript|data|vbscript):/.test(normalized)
}

function isRemoteUrl(value: string): boolean {
  const normalized = decodeHtmlEntities(value).trim().toLowerCase()
  return /^(https?:)?\/\//.test(normalized)
}

function sanitizeAttributes(tag: string, rawAttrs = ''): string | null {
  const attrs: string[] = []
  const attrPattern = /([^\s=\/>"'`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
  let match: RegExpExecArray | null

  while ((match = attrPattern.exec(rawAttrs))) {
    const name = match[1].toLowerCase()
    const value = match[2] ?? match[3] ?? match[4] ?? ''
    const tagSafeAttrs = SAFE_ATTRS_BY_TAG[tag]

    if (name.startsWith('on') || name === 'style') continue
    if (!GLOBAL_SAFE_ATTRS.has(name) && !tagSafeAttrs?.has(name)) continue
    if ((name === 'href' || name === 'src') && isDangerousUrl(value)) continue
    if (tag === 'img' && name === 'src' && isRemoteUrl(value)) return null
    if ((name === 'colspan' || name === 'rowspan') && !/^\d{1,2}$/.test(value)) continue
    if (name === 'align' && !/^(left|center|right)$/i.test(value)) continue

    attrs.push(`${name}="${escapeHtml(value)}"`)
  }

  return attrs.length ? ` ${attrs.join(' ')}` : ''
}

function sanitizeHtmlFragment(html: string): string {
  const blocked = Array.from(BLOCKED_HTML_TAGS).join('|')
  const withoutBlockedBlocks = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(new RegExp(`<\\s*(${blocked})\\b[^>]*>[\\s\\S]*?<\\s*\\/\\s*\\1\\s*>`, 'gi'), '')
    .replace(new RegExp(`<\\s*(${blocked})\\b[^>]*\\/?>`, 'gi'), '')
    .replace(new RegExp(`<\\s*\\/\\s*(${blocked})\\s*>`, 'gi'), '')

  return withoutBlockedBlocks
    .replace(/<\s*([a-zA-Z][\w:-]*)(\s[^<>]*)?>/g, (full, rawTag: string, rawAttrs = '') => {
      const tag = rawTag.toLowerCase()
      if (!ALLOWED_HTML_TAGS.has(tag)) return ''
      const attrs = sanitizeAttributes(tag, rawAttrs)
      if (attrs === null) return ''
      return `<${tag}${attrs}>`
    })
    .replace(/<\s*\/\s*([a-zA-Z][\w:-]*)\s*>/g, (full, rawTag: string) => {
      const tag = rawTag.toLowerCase()
      return ALLOWED_HTML_TAGS.has(tag) ? `</${tag}>` : ''
    })
}

async function markdownToHtmlDocument(md: string): Promise<string> {
  const { marked } = await import('marked')
  const title = extractTitle(md)
  const headings = extractHeadings(md)
  const rendered = String(await marked.parse(md, {
    gfm: true,
    breaks: false
  }))
  let headingIndex = 0
  const body = rendered.replace(/<h([23])>(.*?)<\/h\1>/g, (full, level: string, inner: string) => {
    const hit = headings[headingIndex]
    if (hit && hit.level === Number(level)) {
      headingIndex++
      return `<h${level} id="${escapeHtml(hit.id)}">${inner}</h${level}>`
    }
    return full
  })

  const toc = headings.length
    ? `<nav class="toc"><div class="toc-title">目录</div>${headings
        .map((h) => `<a class="level-${h.level}" href="#${escapeHtml(h.id)}">${escapeHtml(h.text)}</a>`)
        .join('')}</nav>`
    : ''

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; font-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #182033;
      --muted: #647084;
      --line: #dbe3ef;
      --soft: #f5f8fc;
      --accent: #2563eb;
      --accent-soft: #eaf1ff;
      --table-head: #eef4ff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--ink);
      background: #edf2f8;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      line-height: 1.72;
    }
    .shell {
      display: grid;
      grid-template-columns: minmax(180px, 250px) minmax(0, 1fr);
      gap: 24px;
      width: min(1380px, calc(100vw - 48px));
      margin: 24px auto;
      align-items: start;
    }
    .toc {
      position: sticky;
      top: 24px;
      max-height: calc(100vh - 48px);
      overflow: auto;
      padding: 16px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
    }
    .toc-title {
      margin-bottom: 10px;
      color: var(--muted);
      font-size: 13px;
      font-weight: 700;
    }
    .toc a {
      display: block;
      padding: 7px 8px;
      border-radius: 6px;
      color: #31415a;
      text-decoration: none;
      font-size: 13px;
    }
    .toc a:hover { background: var(--accent-soft); color: var(--accent); }
    .toc .level-3 { padding-left: 22px; color: var(--muted); }
    .report {
      min-width: 0;
      padding: 38px 46px 54px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
      box-shadow: 0 16px 40px rgba(41, 54, 78, 0.08);
    }
    h1, h2, h3, h4 { line-height: 1.35; letter-spacing: 0; }
    h1 {
      margin: 0 0 20px;
      padding-bottom: 18px;
      border-bottom: 2px solid var(--accent);
      font-size: 30px;
    }
    h2 {
      margin: 38px 0 14px;
      padding: 10px 12px;
      border-left: 4px solid var(--accent);
      background: var(--accent-soft);
      font-size: 22px;
    }
    h3 { margin: 28px 0 12px; font-size: 18px; }
    p { margin: 10px 0; }
    strong { color: #111827; }
    table {
      width: 100%;
      margin: 14px 0 22px;
      border-collapse: collapse;
      table-layout: auto;
      overflow-wrap: anywhere;
      font-size: 14px;
    }
    th, td {
      padding: 10px 12px;
      border: 1px solid var(--line);
      vertical-align: top;
    }
    th {
      background: var(--table-head);
      text-align: left;
      font-weight: 700;
    }
    tr:nth-child(even) td { background: #fafcff; }
    blockquote {
      margin: 16px 0;
      padding: 12px 16px;
      border-left: 4px solid #94a3b8;
      background: var(--soft);
      color: #42526a;
    }
    code {
      padding: 2px 5px;
      border-radius: 5px;
      background: #f1f5f9;
      font-family: "SFMono-Regular", Consolas, monospace;
      font-size: 0.92em;
    }
    pre {
      overflow: auto;
      padding: 14px;
      border-radius: 8px;
      background: #0f172a;
      color: #e2e8f0;
    }
    a { color: var(--accent); }
    hr { border: 0; border-top: 1px solid var(--line); margin: 28px 0; }
    ul, ol { padding-left: 24px; }
    @media (max-width: 900px) {
      .shell { display: block; width: min(100% - 24px, 760px); margin: 12px auto; }
      .toc { position: static; margin-bottom: 12px; max-height: none; }
      .report { padding: 24px 18px 36px; }
      h1 { font-size: 24px; }
      h2 { font-size: 19px; }
      table { display: block; overflow-x: auto; white-space: normal; }
    }
    @media print {
      body { background: #fff; }
      .shell { display: block; width: auto; margin: 0; }
      .toc { display: none; }
      .report { border: 0; box-shadow: none; padding: 0; }
      h2 { break-after: avoid; }
      table { break-inside: avoid; }
    }
  </style>
</head>
<body>
  <main class="shell">
    ${toc}
    <article class="report">
      ${sanitizeHtmlFragment(body)}
    </article>
  </main>
</body>
</html>
`
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function markdownToDocxBuffer(md: string): Promise<Buffer> {
  const { marked } = await import('marked')
  const docx: any = await import('docx')
  const {
    Document,
    Packer,
    Paragraph,
    TextRun,
    HeadingLevel,
    Table,
    TableRow,
    TableCell,
    WidthType
  } = docx

  const headingMap: Record<number, unknown> = {
    1: HeadingLevel.HEADING_1,
    2: HeadingLevel.HEADING_2,
    3: HeadingLevel.HEADING_3,
    4: HeadingLevel.HEADING_4,
    5: HeadingLevel.HEADING_5,
    6: HeadingLevel.HEADING_6
  }

  const tokens = marked.lexer(md) as any[]
  const children: any[] = [
    new Paragraph({
      heading: HeadingLevel.TITLE,
      children: [new TextRun({ text: '产品经营报告', bold: true })]
    })
  ]

  const buildTable = (t: any): any => {
    const headerCells = (t.header || []).map(
      (c: any) =>
        new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: stripInline(c.text), bold: true })] })]
        })
    )
    const rows: any[] = [new TableRow({ children: headerCells, tableHeader: true })]
    for (const r of t.rows || []) {
      rows.push(
        new TableRow({
          children: r.map(
            (c: any) =>
              new TableCell({
                children: [new Paragraph({ children: [new TextRun({ text: stripInline(c.text) })] })]
              })
          )
        })
      )
    }
    return new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } })
  }

  for (const t of tokens) {
    if (t.type === 'heading') {
      children.push(
        new Paragraph({
          heading: (headingMap[t.depth] as any) || HeadingLevel.HEADING_3,
          children: [new TextRun({ text: stripInline(t.text), bold: true })]
        })
      )
    } else if (t.type === 'paragraph') {
      children.push(new Paragraph({ children: [new TextRun(stripInline(t.text))] }))
    } else if (t.type === 'table') {
      children.push(buildTable(t))
      children.push(new Paragraph({ text: '' }))
    } else if (t.type === 'list') {
      for (const item of t.items || []) {
        children.push(new Paragraph({ text: stripInline(item.text), bullet: { level: 0 } }))
      }
    } else if (t.type === 'code') {
      children.push(new Paragraph({ children: [new TextRun({ text: t.text, font: 'Courier New' })] }))
    } else if (t.type === 'blockquote') {
      children.push(new Paragraph({ children: [new TextRun({ text: stripInline(t.text), italics: true })] }))
    } else if (t.type !== 'space' && t.type !== 'hr' && 'text' in t && t.text) {
      children.push(new Paragraph({ children: [new TextRun(stripInline(String(t.text)))] }))
    }
  }

  const doc = new Document({ sections: [{ children }] })
  return (await Packer.toBuffer(doc)) as Buffer
}
