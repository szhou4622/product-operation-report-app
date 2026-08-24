const { readFileSync, mkdirSync, writeFileSync } = require('node:fs')
const { resolve, join } = require('node:path')
const { createHash } = require('node:crypto')
const iconv = require('iconv-lite')
const Papa = require('papaparse')

const input = process.argv[2]
if (!input) throw new Error('Usage: node scripts/import-module-prompts.cjs <prompt.csv>')

const definitions = [
  ['产品信息', 'M1-product-info.md', 'M1', '产品信息'],
  ['平台人群数据', 'M2-platform-audience.md', 'M2', '平台人群数据'],
  ['内容素材判断', 'M3-material-review.md', 'M3', '内容素材判断'],
  ['对标推荐', 'M4-benchmark-brands.md', 'M4', '对标推荐'],
  ['产品卖点', 'M5-selling-points.md', 'M5', '产品卖点'],
  ['用户真实需求VOC', 'M6-voc.md', 'M6', '用户真实需求VOC'],
  ['总结卖点排序', 'M7-selling-point-ranking.md', 'M7', '总结卖点排序'],
  ['核心人群画像*卖点*场景匹配', 'M8-audience-sp-scene.md', 'M8', '核心人群×卖点×场景匹配']
]

const text = iconv.decode(readFileSync(resolve(input)), 'gb18030')
const parsed = Papa.parse(text, { header: true, skipEmptyLines: false })
if (parsed.errors.some((error) => error.type === 'Quotes')) {
  throw new Error(`Prompt CSV has quoting errors: ${JSON.stringify(parsed.errors.slice(0, 3))}`)
}
const rows = parsed.data.filter((row) => row && typeof row === 'object')
const output = resolve(__dirname, '..', 'assets', 'modules')
mkdirSync(output, { recursive: true })
const manifest = []

for (const [dimension, fileName, id, title] of definitions) {
  const row = rows.find((candidate) => String(candidate['维度'] || '').trim() === dimension)
  if (!row) throw new Error(`Missing module row: ${dimension}`)
  const systemPrompt = String(row['提示词'] || '').trim()
  const outputTemplate = String(row['答案'] || '').trim()
  if (!systemPrompt || !outputTemplate) throw new Error(`Incomplete prompt row: ${dimension}`)
  const content = [
    `# 模块 ${id} · ${title}`,
    '',
    '## 输入资料',
    '',
    String(row['资料'] || '').trim() || '按资料类型路由',
    '',
    '## 资料包含',
    '',
    String(row['资料包含'] || '').trim() || '以用户本次上传并确认的对应资料为准',
    '',
    '## 分析目的',
    '',
    String(row['目的'] || '').trim() || '按模块规则输出来源绑定的分析结果',
    '',
    '---',
    '',
    '## 系统提示词',
    '',
    systemPrompt,
    '',
    '---',
    '',
    '## 输出模板',
    '',
    outputTemplate,
    '',
    '---',
    '',
    '## 验证逻辑',
    '',
    String(row['验证逻辑'] || '').trim() || '严格按输出模板和真实性规则校验',
    ''
  ].join('\n')
  writeFileSync(join(output, fileName), content, 'utf8')
  manifest.push({
    id,
    title,
    fileName,
    systemPromptSha256: createHash('sha256').update(systemPrompt, 'utf8').digest('hex'),
    systemPromptChars: systemPrompt.length,
    outputTemplateChars: outputTemplate.length
  })
}

writeFileSync(join(output, 'manifest.json'), `${JSON.stringify({ version: 1, modules: manifest }, null, 2)}\n`, 'utf8')
process.stdout.write(`Imported ${manifest.length} module prompts into ${output}\n`)
