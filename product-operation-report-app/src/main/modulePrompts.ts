import { createHash } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { ModuleKey, ModulePrompt } from '../shared/types'

const FILES: Record<ModuleKey, string> = {
  'product-info': 'M1-product-info.md',
  'platform-audience': 'M2-platform-audience.md',
  'material-review': 'M3-material-review.md',
  'benchmark-brands': 'M4-benchmark-brands.md',
  'selling-points': 'M5-selling-points.md',
  voc: 'M6-voc.md',
  'selling-point-ranking': 'M7-selling-point-ranking.md',
  'audience-sp-scene': 'M8-audience-sp-scene.md'
}

interface PromptManifest {
  version: number
  modules: Array<{ fileName: string; systemPromptSha256: string }>
}

function section(markdown: string, title: string, nextTitles: string[]): string {
  const start = markdown.indexOf(`## ${title}`)
  if (start < 0) return ''
  const contentStart = markdown.indexOf('\n', start) + 1
  const candidates = nextTitles
    .map((next) => markdown.indexOf(`\n## ${next}`, contentStart))
    .filter((index) => index >= 0)
  const end = candidates.length ? Math.min(...candidates) : markdown.length
  return markdown.slice(contentStart, end).replace(/^\s*---\s*$/gmu, '').trim()
}

export function readBundledModulePrompt(key: ModuleKey, directories: string[]): ModulePrompt {
  const fileName = FILES[key]
  for (const directory of directories) {
    try {
      const path = join(directory, fileName)
      const manifestPath = join(directory, 'manifest.json')
      if (!existsSync(path) || !existsSync(manifestPath)) continue
      const markdown = readFileSync(path, 'utf8')
      if (!markdown || markdown.length > 200_000) continue
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PromptManifest
      const systemPrompt = section(markdown, '系统提示词', ['输出模板', '验证逻辑'])
      const outputTemplate = section(markdown, '输出模板', ['验证逻辑'])
      const expected = manifest.modules?.find((item) => item.fileName === fileName)?.systemPromptSha256
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
    } catch {
      // Continue to the next development/packaged candidate.
    }
  }
  throw new Error(`模块提示词不可用：${key}`)
}

export const modulePromptFiles = FILES
