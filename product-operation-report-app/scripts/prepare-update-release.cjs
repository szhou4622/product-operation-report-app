#!/usr/bin/env node

const { createHash } = require('crypto')
const { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } = require('fs')
const { dirname, join, resolve } = require('path')

const APP_NAME = 'ProductOperationReport'
const DEFAULT_PUBLIC_ROOT = 'https://update.dadaozixun.com/product-operation-report/releases'
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

function artifactDefinitions(version) {
  return {
    windows_x64: `Product-Operation-Report-Windows-${version}-x64-Setup.exe`,
    mac_arm64: `Product-Operation-Report-macOS-${version}-arm64.dmg`,
    mac_x64: `Product-Operation-Report-macOS-${version}-x64.dmg`
  }
}

function parseArguments(argv) {
  const result = { force: false }
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (item === '--force') {
      result.force = true
      continue
    }
    if (!item.startsWith('--')) throw new Error(`无法识别的参数：${item}`)
    const key = item.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`参数 ${item} 缺少值`)
    result[key] = value
    index += 1
  }
  return result
}

function normalizeVersion(value, label = '版本号') {
  const version = String(value || '').trim().replace(/^v/i, '')
  if (!VERSION_PATTERN.test(version)) throw new Error(`${label}无效：${value || '未填写'}`)
  return version
}

function compareVersions(left, right) {
  const a = left.split('-')[0].split('.').map(Number)
  const b = right.split('-')[0].split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1
  }
  return left === right ? 0 : left > right ? 1 : -1
}

function readNotes(path) {
  if (!path || !existsSync(path)) return ['修复问题并提升使用体验。']
  const notes = readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .slice(0, 20)
  return notes.length ? notes : ['修复问题并提升使用体验。']
}

function hashFile(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolveHash(hash.digest('hex')))
  })
}

async function buildManifest(options) {
  const projectRoot = resolve(options.projectRoot || join(__dirname, '..'))
  const packageJson = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'))
  const packageVersion = normalizeVersion(packageJson.version, 'package.json 版本号')
  const version = normalizeVersion(options.version || packageVersion)
  if (version !== packageVersion) {
    throw new Error(`发布版本 ${version} 与 package.json ${packageVersion} 不一致`)
  }

  const minSupportedVersion = options.minSupportedVersion
    ? normalizeVersion(options.minSupportedVersion, '最低支持版本号')
    : undefined
  if (minSupportedVersion && compareVersions(minSupportedVersion, version) > 0) {
    throw new Error('最低支持版本不能高于发布版本')
  }

  const artifactsDir = resolve(options.artifactsDir || join(projectRoot, 'dist'))
  const names = artifactDefinitions(version)
  const files = {}
  for (const [key, filename] of Object.entries(names)) {
    const path = join(artifactsDir, filename)
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw new Error(`缺少 ${key} 安装包：${path}`)
    }
    if (statSync(path).size <= 0) throw new Error(`${key} 安装包为空：${path}`)
    files[key] = { filename, path, sha256: await hashFile(path) }
  }

  const publicRoot = String(options.publicRoot || DEFAULT_PUBLIC_ROOT).replace(/\/+$/, '')
  const versionRoot = `${publicRoot}/${version}`
  const parsedRoot = new URL(versionRoot)
  if (parsedRoot.protocol !== 'https:') throw new Error('更新下载地址必须使用 HTTPS')

  const manifest = {
    app_name: APP_NAME,
    version,
    ...(minSupportedVersion ? { min_supported_version: minSupportedVersion } : {}),
    download_url: Object.fromEntries(
      Object.entries(files).map(([key, file]) => [key, `${versionRoot}/${encodeURIComponent(file.filename)}`])
    ),
    sha256: Object.fromEntries(Object.entries(files).map(([key, file]) => [key, file.sha256])),
    notes: readNotes(options.notesFile ? resolve(options.notesFile) : join(projectRoot, 'release-notes.txt')),
    force: options.force === true
  }

  const output = resolve(options.output || join(projectRoot, 'dist', 'update-release', 'latest.json'))
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return { manifest, output, files }
}

async function main() {
  const args = parseArguments(process.argv.slice(2))
  const result = await buildManifest({
    projectRoot: join(__dirname, '..'),
    version: args.version,
    artifactsDir: args.artifactsDir,
    notesFile: args.notesFile,
    minSupportedVersion: args.minSupportedVersion,
    publicRoot: args.publicRoot,
    output: args.output,
    force: args.force
  })
  process.stdout.write(`${JSON.stringify({
    ok: true,
    app_name: APP_NAME,
    version: result.manifest.version,
    force: result.manifest.force,
    output: result.output,
    files: Object.fromEntries(
      Object.entries(result.files).map(([key, file]) => [key, { filename: file.filename, sha256: file.sha256 }])
    )
  }, null, 2)}\n`)
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`UPDATE_RELEASE_PREPARE_FAILED: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}

module.exports = {
  APP_NAME,
  DEFAULT_PUBLIC_ROOT,
  artifactDefinitions,
  buildManifest,
  compareVersions,
  normalizeVersion,
  parseArguments,
  readNotes
}
