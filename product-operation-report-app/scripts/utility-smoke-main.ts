import { strict as assert } from 'node:assert'
import { app } from 'electron'
import JSZip from 'jszip'
import {
  disposeParseService,
  parseArchiveInUtility,
  parseFileInUtility
} from '../src/main/parseService'

function makePdf(): Uint8Array {
  const content = 'BT /F1 12 Tf 72 720 Td (Hello PDF) Tj ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (let index = 0; index < objects.length; index++) {
    offsets.push(pdf.length)
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`
  }
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (let index = 1; index < offsets.length; index++) {
    pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(pdf)
}

function makeScannedPdf(): Uint8Array {
  const imageData = 'FF0000>'
  const content = 'q 120 0 0 120 72 600 cm /Im1 Do Q'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>',
    `<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length ${imageData.length} >>\nstream\n${imageData}\nendstream`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (let index = 0; index < objects.length; index++) {
    offsets.push(pdf.length)
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`
  }
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (let index = 1; index < offsets.length; index++) {
    pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(pdf)
}

function makePng(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 13)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

async function run(): Promise<void> {
  const csv = new TextEncoder().encode('name,value\nalpha,1\nbeta,2')
  const first = parseFileInUtility(1, 'first.csv', csv.buffer.slice(0))
  const second = parseFileInUtility(1, 'second.csv', csv.buffer.slice(0))
  const [firstResult, secondResult] = await Promise.all([first, second])
  assert.equal(firstResult.ok, true)
  assert.match(firstResult.text || '', /alpha/)
  assert.equal(secondResult.ok, true)
  assert.match(secondResult.text || '', /beta/)

  const markdown = new TextEncoder().encode('# 产品手卡\n\n- 核心卖点：中文 Markdown 可解析')
  const markdownResult = await parseFileInUtility(
    1,
    '产品手卡.MD',
    markdown.buffer.slice(markdown.byteOffset, markdown.byteOffset + markdown.byteLength) as ArrayBuffer
  )
  assert.equal(markdownResult.ok, true, JSON.stringify(markdownResult))
  assert.match(markdownResult.text || '', /中文 Markdown 可解析/)

  const tsv = new TextEncoder().encode('字段\t数值\n成交金额\t1234')
  const tsvResult = await parseFileInUtility(1, '经营数据.tsv', tsv.buffer.slice(0))
  assert.equal(tsvResult.ok, true, JSON.stringify(tsvResult))
  assert.match(tsvResult.text || '', /成交金额,1234/)

  const json = new TextEncoder().encode('{"产品":"酸菜","成交金额":1234}')
  const jsonResult = await parseFileInUtility(1, '经营数据.json', json.buffer.slice(0))
  assert.equal(jsonResult.ok, true, JSON.stringify(jsonResult))
  assert.match(jsonResult.text || '', /"成交金额": 1234/)

  const yaml = new TextEncoder().encode('产品: 酸菜\n成交金额: 1234')
  const yamlResult = await parseFileInUtility(1, '经营数据.yaml', yaml.buffer.slice(0))
  assert.equal(yamlResult.ok, true, JSON.stringify(yamlResult))
  assert.match(yamlResult.text || '', /成交金额: 1234/)

  const rtf = new TextEncoder().encode('{\\rtf1\\ansi Product benefit\\par GMV 1234}')
  const rtfResult = await parseFileInUtility(1, '产品说明.rtf', rtf.buffer.slice(0))
  assert.equal(rtfResult.ok, true, JSON.stringify(rtfResult))
  assert.match(rtfResult.text || '', /Product benefit[\s\S]*GMV 1234/)
  assert.doesNotMatch(rtfResult.text || '', /\\rtf1|\\par/)

  const html = new TextEncoder().encode('<h1>经营摘要</h1><p>成交金额 1234</p><script>bad()</script>')
  const htmlResult = await parseFileInUtility(1, '网页导出.html', html.buffer.slice(0))
  assert.equal(htmlResult.ok, true, JSON.stringify(htmlResult))
  assert.match(htmlResult.text || '', /经营摘要[\s\S]*成交金额 1234/)
  assert.doesNotMatch(htmlResult.text || '', /bad\(\)/)

  const invalidArchive = new TextEncoder().encode('not a zip')
  const archiveResult = await parseArchiveInUtility(1, 'broken.zip', invalidArchive.buffer.slice(0))
  assert.equal(archiveResult.length, 1)
  assert.equal(archiveResult[0]?.ok, false)
  assert.match(archiveResult[0]?.error || '', /压缩包|ZIP|zip/i)

  const third = await parseFileInUtility(1, 'after-error.csv', csv.buffer.slice(0))
  assert.equal(third.ok, true)
  assert.match(third.text || '', /alpha/)

  const pdf = makePdf()
  const pdfResult = await parseFileInUtility(
    1,
    'sample.pdf',
    pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) as ArrayBuffer
  )
  assert.equal(pdfResult.ok, true, JSON.stringify(pdfResult))
  assert.match(pdfResult.text || '', /Hello PDF/)

  const scannedPdf = makeScannedPdf()
  const scannedPdfResult = await parseFileInUtility(
    1,
    '扫描件.pdf',
    scannedPdf.buffer.slice(scannedPdf.byteOffset, scannedPdf.byteOffset + scannedPdf.byteLength) as ArrayBuffer
  )
  assert.equal(scannedPdfResult.ok, true, JSON.stringify(scannedPdfResult))
  assert.equal(scannedPdfResult.attachments?.length, 1)
  assert.match(scannedPdfResult.attachments?.[0]?.dataUrl || '', /^data:image\/png;base64,/u)

  const pptx = new JSZip()
  pptx.file('[Content_Types].xml', '<Types/>')
  pptx.file('ppt/slides/slide1.xml', '<p:sld xmlns:p="p" xmlns:a="a"><a:t>产品图片说明</a:t></p:sld>')
  pptx.file('ppt/media/image1.png', makePng(10, 10))
  const pptxBytes = await pptx.generateAsync({ type: 'arraybuffer' })
  const pptxResult = await parseFileInUtility(1, '产品手卡.pptx', pptxBytes)
  assert.equal(pptxResult.ok, true, JSON.stringify(pptxResult))
  assert.match(pptxResult.text || '', /产品图片说明/u)
  assert.equal(pptxResult.attachments?.length, 1)
  assert.match(pptxResult.attachments?.[0]?.dataUrl || '', /^data:image\/png;base64,/u)
}

void app.whenReady().then(async () => {
  try {
    await run()
    console.log('Utility-process smoke checks passed: two-worker parsing, Markdown, TSV, JSON, YAML, RTF, HTML, PDF text and scan conversion, Office embedded images, bad archive isolation, recovery.')
    disposeParseService()
    app.exit(0)
  } catch (error) {
    console.error(error)
    disposeParseService()
    app.exit(1)
  }
})
