const { buildSync } = require('esbuild')
const { spawnSync } = require('node:child_process')
const { existsSync, rmSync } = require('node:fs')
const path = require('node:path')

const projectDir = path.resolve(__dirname, '..')
const output = path.join(projectDir, '.tmp-utility-smoke.cjs')

try {
  buildSync({
    entryPoints: [path.join(__dirname, 'utility-smoke-main.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron', '@napi-rs/canvas', 'sharp', 'word-extractor'],
    outfile: output,
    logLevel: 'warning'
  })

  const electron = require('electron')
  const result = spawnSync(electron, [output], {
    cwd: projectDir,
    stdio: 'inherit',
    windowsHide: true
  })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally {
  if (existsSync(output)) rmSync(output, { force: true })
}
