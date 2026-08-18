import { strict as assert } from 'node:assert'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, utilityProcess, type UtilityProcess } from 'electron'
import JSZip from 'jszip'
import * as XLSX from 'xlsx'

function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

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

async function waitForReady(child: UtilityProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Packaged parse utility ready timeout')), 8_000)
    child.on('message', (message) => {
      if (message?.type !== 'ready') return
      clearTimeout(timer)
      resolve()
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`Packaged parse utility exited before ready: ${code}`))
    })
  })
}

async function request(
  child: UtilityProcess,
  id: string,
  op: 'file' | 'archive',
  name: string,
  data: ArrayBuffer
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Packaged parse timeout: ${name}`)), 30_000)
    const onMessage = (message: any): void => {
      if (message?.id !== id) return
      clearTimeout(timer)
      child.off('message', onMessage)
      resolve(message)
    }
    child.on('message', onMessage)
    child.postMessage({ id, op, name, data })
  })
}

async function run(): Promise<void> {
  const parseModulePath = process.argv[2]
  const htmlModulePath = process.argv[3]
  const skillPath = process.argv[4]
  const packagedPackagePath = process.argv[5]
  const expectedVersion = process.argv[6]
  assert.ok(parseModulePath, 'Missing packaged parse utility module path')
  assert.ok(htmlModulePath, 'Missing packaged HTML utility module path')
  assert.ok(skillPath, 'Missing packaged Skill path')
  assert.ok(packagedPackagePath, 'Missing packaged package.json path')
  assert.ok(expectedVersion, 'Missing expected package version')
  const packagedPackage = JSON.parse(readFileSync(packagedPackagePath, 'utf8')) as {
    version?: unknown
  }
  assert.equal(
    packagedPackage.version,
    expectedVersion,
    `安装版版本不匹配：当前源码是 ${expectedVersion}，dist 中是 ${String(packagedPackage.version)}。请先重新生成安装版。`
  )
  const child = utilityProcess.fork(parseModulePath, [], {
    serviceName: '产品经营报告-安装包解析测试',
    stdio: 'pipe'
  })
  child.stderr?.on('data', (chunk) => console.error(`[packaged-parse] ${String(chunk).trim()}`))
  await waitForReady(child)

  const csv = new TextEncoder().encode('name,value\nalpha,1')
  const csvResult = await request(child, 'csv', 'file', 'sample.csv', exactBuffer(csv))
  assert.equal(csvResult.ok, true, JSON.stringify(csvResult))
  assert.equal(csvResult.result?.ok, true, JSON.stringify(csvResult))
  assert.match(csvResult.result?.text || '', /alpha/)

  const markdown = new TextEncoder().encode('# 产品手卡\n\n- 核心卖点：安装版 Markdown 可解析')
  const markdownResult = await request(child, 'markdown', 'file', '产品手卡.MD', exactBuffer(markdown))
  assert.equal(markdownResult.result?.ok, true, JSON.stringify(markdownResult))
  assert.match(markdownResult.result?.text || '', /安装版 Markdown 可解析/)

  const tsv = new TextEncoder().encode('字段\t数值\n成交金额\t1234')
  const tsvResult = await request(child, 'tsv', 'file', '经营数据.tsv', exactBuffer(tsv))
  assert.equal(tsvResult.result?.ok, true, JSON.stringify(tsvResult))
  assert.match(tsvResult.result?.text || '', /成交金额,1234/)

  const json = new TextEncoder().encode('{"产品":"酸菜","成交金额":1234}')
  const jsonResult = await request(child, 'json', 'file', '经营数据.json', exactBuffer(json))
  assert.equal(jsonResult.result?.ok, true, JSON.stringify(jsonResult))
  assert.match(jsonResult.result?.text || '', /"成交金额": 1234/)

  const yaml = new TextEncoder().encode('产品: 酸菜\n成交金额: 1234')
  const yamlResult = await request(child, 'yaml', 'file', '经营数据.yaml', exactBuffer(yaml))
  assert.equal(yamlResult.result?.ok, true, JSON.stringify(yamlResult))
  assert.match(yamlResult.result?.text || '', /成交金额: 1234/)

  const rtf = new TextEncoder().encode('{\\rtf1\\ansi Product benefit\\par GMV 1234}')
  const rtfResult = await request(child, 'rtf', 'file', '产品说明.rtf', exactBuffer(rtf))
  assert.equal(rtfResult.result?.ok, true, JSON.stringify(rtfResult))
  assert.match(rtfResult.result?.text || '', /Product benefit[\s\S]*GMV 1234/)
  assert.doesNotMatch(rtfResult.result?.text || '', /\\rtf1|\\par/)

  const html = new TextEncoder().encode('<h1>经营摘要</h1><p>成交金额 1234</p><script>bad()</script>')
  const parsedHtmlResult = await request(child, 'html', 'file', '网页导出.html', exactBuffer(html))
  assert.equal(parsedHtmlResult.result?.ok, true, JSON.stringify(parsedHtmlResult))
  assert.match(parsedHtmlResult.result?.text || '', /经营摘要[\s\S]*成交金额 1234/)
  assert.doesNotMatch(parsedHtmlResult.result?.text || '', /bad\(\)/)

  const raggedCsv = new TextEncoder().encode('name,value\nalpha,1,extra')
  const raggedResult = await request(
    child,
    'ragged-csv',
    'file',
    'ragged.csv',
    exactBuffer(raggedCsv)
  )
  assert.equal(raggedResult.result?.ok, true, JSON.stringify(raggedResult))
  assert.match(raggedResult.result?.warning || '', /自动兼容/)
  assert.match(raggedResult.result?.text || '', /extra/)

  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['name', 'value'], ['beta', 2]]), 'Data')
  const xlsx = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
  const xlsxResult = await request(child, 'xlsx', 'file', 'sample.xlsx', xlsx)
  assert.equal(xlsxResult.result?.ok, true, JSON.stringify(xlsxResult))
  assert.match(xlsxResult.result?.text || '', /beta/)

  const pptx = new JSZip()
  pptx.file('[Content_Types].xml', '<Types/>')
  pptx.file('ppt/slides/slide1.xml', '<p:sld xmlns:p="p" xmlns:a="a"><a:t>产品图片说明</a:t></p:sld>')
  pptx.file('ppt/media/image1.png', makePng(10, 10))
  const pptxBytes = await pptx.generateAsync({ type: 'arraybuffer' })
  const pptxResult = await request(child, 'pptx', 'file', '产品手卡.pptx', pptxBytes)
  assert.equal(pptxResult.result?.ok, true, JSON.stringify(pptxResult))
  assert.match(pptxResult.result?.text || '', /产品图片说明/u)
  assert.equal(pptxResult.result?.attachments?.length, 1)

  const pdfResult = await request(child, 'pdf', 'file', 'sample.pdf', exactBuffer(makePdf()))
  assert.equal(pdfResult.result?.ok, true, JSON.stringify(pdfResult))
  assert.match(pdfResult.result?.text || '', /Hello PDF/)

  const sharp = (await import('sharp')).default
  const tiffBytes = await sharp({
    create: { width: 16, height: 12, channels: 3, background: { r: 20, g: 120, b: 220 } }
  }).tiff().toBuffer()
  const tiffResult = await request(child, 'tiff', 'file', '扫描图片.tiff', exactBuffer(tiffBytes))
  assert.equal(tiffResult.result?.ok, true, JSON.stringify(tiffResult))
  assert.equal(tiffResult.result?.attachments?.length, 1)
  assert.match(tiffResult.result?.attachments?.[0]?.dataUrl || '', /^data:image\/png;base64,/u)

  const zip = new JSZip()
  zip.file('inside.csv', 'name,value\ngamma,3')
  const zipBytes = await zip.generateAsync({ type: 'uint8array' })
  const zipResult = await request(child, 'zip', 'archive', 'sample.zip', exactBuffer(zipBytes))
  assert.equal(zipResult.ok, true, JSON.stringify(zipResult))
  assert.ok(Array.isArray(zipResult.result))
  assert.equal(zipResult.result[0]?.ok, true, JSON.stringify(zipResult))
  assert.match(zipResult.result[0]?.text || '', /gamma/)

  child.kill()

  const htmlChild = utilityProcess.fork(htmlModulePath, [], {
    serviceName: '产品经营报告-安装包HTML测试',
    stdio: 'pipe'
  })
  htmlChild.stderr?.on('data', (chunk) => console.error(`[packaged-html] ${String(chunk).trim()}`))
  await waitForReady(htmlChild)
  const htmlResult = await new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Packaged HTML render timeout')), 30_000)
    const onMessage = (message: any): void => {
      if (message?.id !== 'html') return
      clearTimeout(timer)
      htmlChild.off('message', onMessage)
      resolve(message)
    }
    htmlChild.on('message', onMessage)
    htmlChild.postMessage({
      id: 'html',
      markdown: `# 安装版 HTML 测试
<!-- Product visual brief
role: 家庭日常快速配餐
audience: 家庭主理人
scene: 工作日晚餐
value-signal: practicality
trust-model: visible-use
design-direction: household-field-guide
evidence-confidence: confirmed
-->

## 0. 结论先行
优先展示真实使用场景。

| 优先级 | 核心人群 | 关键判断 |
|---|---|---|
| P0 | 家庭主理人 | 晚餐配餐需求明确 |`
    })
  })
  assert.equal(htmlResult.ok, true, JSON.stringify(htmlResult))
  assert.match(htmlResult.html || '', /data-report-direction="household-field-guide"/)
  assert.match(htmlResult.html || '', /Content-Security-Policy/)
  assert.equal(/<script|@import|https?:\/\/[^"]+\.(?:js|css|woff)/i.test(htmlResult.html || ''), false)

  const outputPath = join(app.getPath('temp'), 'product-report-packaged-html-smoke.html')
  try {
    writeFileSync(outputPath, htmlResult.html, 'utf8')
    const saved = readFileSync(outputPath, 'utf8')
    assert.match(saved, /优先展示真实使用场景/)
    assert.match(saved, /@media print/)
  } finally {
    rmSync(outputPath, { force: true })
  }
  htmlChild.kill()

  assert.equal(existsSync(skillPath), true)
  const skill = readFileSync(skillPath, 'utf8')
  const referencePath = join(dirname(skillPath), 'references', 'positioning-driven-html-design.md')
  assert.equal(existsSync(referencePath), true)
  const reference = readFileSync(referencePath, 'utf8')
  assert.match(skill, /positioning-driven-html-design\.md/)
  assert.match(reference, /Product visual brief/)
}

void app.whenReady().then(async () => {
  try {
    await run()
    console.log('Packaged ASAR checks passed: Markdown, CSV/TSV, JSON/YAML, RTF, HTML, XLSX, PDF, TIFF conversion, ZIP, offline HTML renderer and bundled Skill.')
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
})
