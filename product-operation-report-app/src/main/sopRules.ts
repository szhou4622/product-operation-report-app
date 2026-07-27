import { existsSync, readFileSync } from 'fs'
import { dirname, join } from 'path'

const HTML_DESIGN_REFERENCE = join('references', 'positioning-driven-html-design.md')

export function readBundledSopRules(candidates: string[]): string {
  for (const skillPath of candidates) {
    try {
      if (!existsSync(skillPath)) continue
      const skill = readFileSync(skillPath, 'utf8')
      const referencePath = join(dirname(skillPath), HTML_DESIGN_REFERENCE)
      if (!existsSync(referencePath)) return skill
      const reference = readFileSync(referencePath, 'utf8')
      return `${skill}\n\n# 内置 HTML 视觉规范\n\n${reference}`
    } catch {
      // 尝试下一个候选位置。
    }
  }
  return ''
}
