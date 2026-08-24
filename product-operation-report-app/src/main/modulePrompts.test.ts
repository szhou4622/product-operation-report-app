import { describe, expect, it } from 'vitest'
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
})
