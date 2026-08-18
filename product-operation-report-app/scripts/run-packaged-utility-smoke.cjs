const { buildSync } = require('esbuild')
const { spawnSync } = require('node:child_process')
const { existsSync, readFileSync, rmSync } = require('node:fs')
const path = require('node:path')

const projectDir = path.resolve(__dirname, '..')
const output = path.join(projectDir, '.tmp-packaged-utility-smoke.cjs')
const packagedRoot = process.env.PRODUCT_REPORT_PACKAGED_DIR
  ? path.resolve(projectDir, process.env.PRODUCT_REPORT_PACKAGED_DIR)
  : path.join(projectDir, 'dist')
const asarPath = path.join(packagedRoot, 'win-unpacked', 'resources', 'app.asar')
const packagedPackagePath = path.join(asarPath, 'package.json')
const expectedVersion = JSON.parse(
  readFileSync(path.join(projectDir, 'package.json'), 'utf8')
).version
const parseModulePath = path.join(
  asarPath,
  'out',
  'main',
  'parse-utility.js'
)
const htmlModulePath = path.join(asarPath, 'out', 'main', 'html-report-utility.js')
const skillPath = path.join(
  packagedRoot,
  'win-unpacked',
  'resources',
  'app.asar.unpacked',
  'assets',
  'skill',
  'SKILL.md'
)

if (!existsSync(asarPath)) {
  throw new Error(`Packaged ASAR is missing: ${asarPath}`)
}

try {
  buildSync({
    entryPoints: [path.join(__dirname, 'packaged-utility-smoke-main.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron', 'jszip', 'xlsx', 'sharp'],
    outfile: output,
    logLevel: 'warning'
  })

  const electron = require('electron')
  const result = spawnSync(
    electron,
    [
      output,
      parseModulePath,
      htmlModulePath,
      skillPath,
      packagedPackagePath,
      expectedVersion
    ],
    {
      cwd: projectDir,
      stdio: 'inherit',
      windowsHide: true
    }
  )
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally {
  if (existsSync(output)) rmSync(output, { force: true })
}
