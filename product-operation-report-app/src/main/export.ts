import { dialog } from 'electron'
import { rename, rm, writeFile } from 'fs/promises'
import type { ExportResult } from '../shared/types'
import { reportMarkdownForDisplay } from '../shared/reportDisplay'
import { markdownToHtmlDocument, stripProductVisualBrief } from './htmlReport'

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
    await writeExportAtomically(
      filePath,
      Buffer.from(stripProductVisualBrief(reportMarkdownForDisplay(content)), 'utf8')
    )
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

  const tokens = marked.lexer(stripProductVisualBrief(reportMarkdownForDisplay(md))) as any[]
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
