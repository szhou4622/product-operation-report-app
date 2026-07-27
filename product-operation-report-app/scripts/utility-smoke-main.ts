import { strict as assert } from 'node:assert'
import { app } from 'electron'
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

async function run(): Promise<void> {
  const csv = new TextEncoder().encode('name,value\nalpha,1\nbeta,2')
  const first = parseFileInUtility(1, 'first.csv', csv.buffer.slice(0))
  const second = parseFileInUtility(1, 'second.csv', csv.buffer.slice(0))
  const [firstResult, secondResult] = await Promise.all([first, second])
  assert.equal(firstResult.ok, true)
  assert.match(firstResult.text || '', /alpha/)
  assert.equal(secondResult.ok, true)
  assert.match(secondResult.text || '', /beta/)

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
}

void app.whenReady().then(async () => {
  try {
    await run()
    console.log('Utility-process smoke checks passed: FIFO parsing, PDF, bad archive isolation, recovery.')
    disposeParseService()
    app.exit(0)
  } catch (error) {
    console.error(error)
    disposeParseService()
    app.exit(1)
  }
})
