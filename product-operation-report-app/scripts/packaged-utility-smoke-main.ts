import { strict as assert } from 'node:assert'
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
  const modulePath = process.argv[2]
  assert.ok(modulePath, 'Missing packaged utility module path')
  const child = utilityProcess.fork(modulePath, [], {
    serviceName: '产品经营报告-安装包解析测试',
    stdio: 'ignore'
  })
  await waitForReady(child)

  const csv = new TextEncoder().encode('name,value\nalpha,1')
  const csvResult = await request(child, 'csv', 'file', 'sample.csv', exactBuffer(csv))
  assert.equal(csvResult.ok, true, JSON.stringify(csvResult))
  assert.equal(csvResult.result?.ok, true, JSON.stringify(csvResult))
  assert.match(csvResult.result?.text || '', /alpha/)

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

  const pdfResult = await request(child, 'pdf', 'file', 'sample.pdf', exactBuffer(makePdf()))
  assert.equal(pdfResult.result?.ok, true, JSON.stringify(pdfResult))
  assert.match(pdfResult.result?.text || '', /Hello PDF/)

  const zip = new JSZip()
  zip.file('inside.csv', 'name,value\ngamma,3')
  const zipBytes = await zip.generateAsync({ type: 'uint8array' })
  const zipResult = await request(child, 'zip', 'archive', 'sample.zip', exactBuffer(zipBytes))
  assert.equal(zipResult.ok, true, JSON.stringify(zipResult))
  assert.ok(Array.isArray(zipResult.result))
  assert.equal(zipResult.result[0]?.ok, true, JSON.stringify(zipResult))
  assert.match(zipResult.result[0]?.text || '', /gamma/)

  child.kill()
}

void app.whenReady().then(async () => {
  try {
    await run()
    console.log('Packaged ASAR utility checks passed: CSV, XLSX, PDF and ZIP.')
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
})
