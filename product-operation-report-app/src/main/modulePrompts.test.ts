import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPORT_MODULES } from '../shared/types'
import { readBundledModulePrompt } from './modulePrompts'

describe('bundled v1 module prompts', () => {
  it('loads all eight hash-verified prompts from assets', () => {
    const directory = join(process.cwd(), 'assets', 'modules')
    for (const module of REPORT_MODULES) {
      const prompt = readBundledModulePrompt(module.key, [directory])
      expect(prompt.systemPrompt.length).toBeGreaterThan(2_000)
      expect(prompt.outputTemplate.length).toBeGreaterThan(50)
      expect(prompt.key).toBe(module.key)
    }
  })

  it('loads hash-verified prompts after a Windows CRLF checkout', () => {
    const sourceDirectory = join(process.cwd(), 'assets', 'modules')
    const directory = mkdtempSync(join(tmpdir(), 'product-report-module-prompts-'))
    try {
      writeFileSync(join(directory, 'manifest.json'), readFileSync(join(sourceDirectory, 'manifest.json')))
      const markdown = readFileSync(join(sourceDirectory, 'M1-product-info.md'), 'utf8').replace(/\r?\n/gu, '\r\n')
      writeFileSync(join(directory, 'M1-product-info.md'), markdown, 'utf8')
      const prompt = readBundledModulePrompt('product-info', [directory])
      expect(prompt.systemPrompt.length).toBeGreaterThan(2_000)
      expect(prompt.key).toBe('product-info')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('loads historical CRLF-hashed prompts after an LF checkout', () => {
    const sourceDirectory = join(process.cwd(), 'assets', 'modules')
    const directory = mkdtempSync(join(tmpdir(), 'product-report-module-prompts-'))
    try {
      writeFileSync(join(directory, 'manifest.json'), readFileSync(join(sourceDirectory, 'manifest.json')))
      const markdown = readFileSync(join(sourceDirectory, 'M2-audience-analysis.md'), 'utf8').replace(/\r\n?/gu, '\n')
      writeFileSync(join(directory, 'M2-audience-analysis.md'), markdown, 'utf8')
      const prompt = readBundledModulePrompt('platform-audience', [directory])
      expect(prompt.systemPrompt.length).toBeGreaterThan(2_000)
      expect(prompt.key).toBe('platform-audience')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
