const { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { basename, extname, join, resolve } = require('node:path')
const asar = require('@electron/asar')

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

function walk(root, visit) {
  for (const name of readdirSync(root)) {
    const path = join(root, name)
    const stat = statSync(path)
    if (stat.isDirectory()) walk(path, visit)
    else visit(path, stat)
  }
}

const packageArg = process.argv[2]
if (!packageArg) fail('Usage: node scripts/verify-package-secrets.cjs <packaged-app-root>')
const packageRoot = resolve(packageArg)
if (!existsSync(packageRoot)) fail('Packaged app root does not exist.')

const forbiddenNames = new Set(['managed-model.json', 'managed-model.local.json', 'proxy.env', '.env'])
const secretPattern = /sk-[A-Za-z0-9_-]{16,}/g
const providerPattern = /ccg-cli\.online/gi
const legacyContactPattern = /azssph2|wechat-contact-azssph2/gi
const textExtensions = new Set(['.js', '.cjs', '.mjs', '.json', '.html', '.css', '.yml', '.yaml', '.txt', '.md'])
const extracted = mkdtempSync(join(tmpdir(), 'product-report-package-scan-'))
let scannedRoot = packageRoot
let unpackedRoot = packageRoot

try {
  const asarPath = join(packageRoot, 'resources', 'app.asar')
  if (existsSync(asarPath)) {
    asar.extractAll(asarPath, extracted)
    scannedRoot = extracted
  }
  const unpackedCandidate = join(packageRoot, 'resources', 'app.asar.unpacked')
  if (existsSync(unpackedCandidate)) unpackedRoot = unpackedCandidate
  const findings = []
  walk(packageRoot, (path) => {
    if (forbiddenNames.has(basename(path).toLowerCase())) findings.push(`forbidden file: ${path}`)
  })
  walk(scannedRoot, (path, stat) => {
    if (stat.size > 25 * 1024 * 1024 || !textExtensions.has(extname(path).toLowerCase())) return
    const content = readFileSync(path, 'utf8')
    if (secretPattern.test(content)) findings.push(`API key pattern: ${path}`)
    secretPattern.lastIndex = 0
    if (providerPattern.test(content)) findings.push(`provider endpoint: ${path}`)
    providerPattern.lastIndex = 0
    if (legacyContactPattern.test(content)) findings.push(`legacy fixed contact identifier: ${path}`)
    legacyContactPattern.lastIndex = 0
  })
  if (unpackedRoot !== packageRoot) {
    walk(unpackedRoot, (path, stat) => {
      if (stat.size > 25 * 1024 * 1024 || !textExtensions.has(extname(path).toLowerCase())) return
      const content = readFileSync(path, 'utf8')
      if (secretPattern.test(content)) findings.push(`API key pattern: ${path}`)
      secretPattern.lastIndex = 0
      if (providerPattern.test(content)) findings.push(`provider endpoint: ${path}`)
      providerPattern.lastIndex = 0
      if (legacyContactPattern.test(content)) findings.push(`legacy fixed contact identifier: ${path}`)
      legacyContactPattern.lastIndex = 0
    })
  }
  if (findings.length) fail(`Package secret scan failed:\n${findings.join('\n')}`)
  process.stdout.write('Package secret scan passed: no provider key, provider endpoint, fixed contact identifier, or legacy managed-model resource.\n')
} finally {
  rmSync(extracted, { recursive: true, force: true })
}
