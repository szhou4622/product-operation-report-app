import { createHash } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { ModuleKey, ModulePrompt } from '../shared/types'

const FILES: Record<ModuleKey, string> = {
  'product-info': 'M1-product-info.md',
  'platform-audience': 'M2-audience-analysis.md',
  'material-review': 'M3-material-review.md',
  'benchmark-brands': 'M4-benchmark-brands.md',
  'selling-points': 'M4-selling-point-strategy.md',
  voc: 'M5-voc.md',
  'selling-point-ranking': 'M7-selling-point-ranking.md',
  'audience-sp-scene': 'M6-audience-sp-scene.md'
}

interface PromptManifest {
  version: number
  modules: Array<{ fileName: string; systemPromptSha256: string }>
}

function section(markdown: string, title: string, nextTitles: string[], preserveInternalSeparators = false): string {
  const start = markdown.indexOf(`## ${title}`)
  if (start < 0) return ''
  const contentStart = markdown.indexOf('\n', start) + 1
  const candidates = nextTitles
    .map((next) => markdown.indexOf(`\n## ${next}`, contentStart))
    .filter((index) => index >= 0)
  const end = candidates.length ? Math.min(...candidates) : markdown.length
  const value = markdown.slice(contentStart, end)
  return preserveInternalSeparators
    ? value.replace(/\r?\n\s*---\s*$/u, '').trim()
    : value.replace(/^\s*---\s*$/gmu, '').trim()
}

export function readBundledModulePrompt(key: ModuleKey, directories: string[]): ModulePrompt {
  const fileName = FILES[key]
  for (const directory of directories) {
    try {
      const path = join(directory, fileName)
      const manifestPath = join(directory, 'manifest.json')
      if (!existsSync(path) || !existsSync(manifestPath)) continue
      const rawMarkdown = readFileSync(path, 'utf8')
      if (!rawMarkdown || rawMarkdown.length > 200_000) continue
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PromptManifest
      const preserveInternalSeparators = fileName === 'M2-audience-analysis.md' || fileName === 'M4-selling-point-strategy.md'
      const expected = manifest.modules?.find((item) => item.fileName === fileName)?.systemPromptSha256
      const normalizedMarkdown = rawMarkdown.replace(/\r\n?/gu, '\n')
      const candidates = Array.from(new Set([rawMarkdown, normalizedMarkdown, normalizedMarkdown.replace(/\n/gu, '\r\n')]))
      for (const markdown of candidates) {
        const systemPrompt = section(markdown, '系统提示词', ['输出模板', '验证逻辑'], preserveInternalSeparators)
        const outputTemplate = section(markdown, '输出模板', ['验证逻辑'])
        const actual = createHash('sha256').update(systemPrompt, 'utf8').digest('hex')
        if (!systemPrompt || !outputTemplate || !expected || expected !== actual) continue
        return {
          key,
          systemPrompt,
          outputTemplate,
          validation: section(markdown, '验证逻辑', []),
          inputDescription: section(markdown, '输入资料', ['资料包含', '分析目的']),
          purpose: section(markdown, '分析目的', ['系统提示词'])
        }
      }
    } catch {
      // Continue to the next development/packaged candidate.
    }
  }
  throw new Error(`模块提示词不可用：${key}`)
}

export const modulePromptFiles = FILES
