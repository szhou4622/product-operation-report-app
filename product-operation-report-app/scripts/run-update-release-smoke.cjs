#!/usr/bin/env node

const assert = require('assert/strict')
const { createHash } = require('crypto')
const { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('fs')
const { tmpdir } = require('os')
const { join } = require('path')
const {
  artifactDefinitions,
  buildManifest
} = require('./prepare-update-release.cjs')

async function run() {
  const root = mkdtempSync(join(tmpdir(), 'por-update-release-'))
  const version = '9.8.7'
  try {
    const artifacts = join(root, 'artifacts')
    mkdirSync(artifacts, { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version }), 'utf8')
    writeFileSync(join(root, 'release-notes.txt'), '# ignored\n第一条\n第二条\n', 'utf8')

    const payloads = {}
    for (const [key, filename] of Object.entries(artifactDefinitions(version))) {
      const payload = Buffer.from(`artifact-${key}`, 'utf8')
      payloads[key] = payload
      writeFileSync(join(artifacts, filename), payload)
    }

    const output = join(root, 'output', 'latest.json')
    const result = await buildManifest({
      projectRoot: root,
      version,
      artifactsDir: artifacts,
      notesFile: join(root, 'release-notes.txt'),
      minSupportedVersion: '9.0.0',
      output,
      force: false
    })
    const saved = JSON.parse(readFileSync(output, 'utf8'))
    assert.equal(saved.app_name, 'ProductOperationReport')
    assert.equal(saved.version, version)
    assert.equal(saved.min_supported_version, '9.0.0')
    assert.deepEqual(saved.notes, ['第一条', '第二条'])
    assert.equal(saved.force, false)
    for (const [key, filename] of Object.entries(artifactDefinitions(version))) {
      assert.equal(saved.download_url[key], `https://update.dadaozixun.com/product-operation-report/releases/${version}/${filename}`)
      assert.equal(saved.sha256[key], createHash('sha256').update(payloads[key]).digest('hex'))
    }
    assert.deepEqual(saved, result.manifest)

    await assert.rejects(
      buildManifest({ projectRoot: root, version, artifactsDir: artifacts, publicRoot: 'http://unsafe.example.test' }),
      /HTTPS/
    )
    rmSync(join(artifacts, artifactDefinitions(version).mac_x64))
    await assert.rejects(
      buildManifest({ projectRoot: root, version, artifactsDir: artifacts }),
      /缺少 mac_x64 安装包/
    )
    process.stdout.write('run-update-release-smoke: PASS\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
