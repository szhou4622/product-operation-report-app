const PLATFORM_RULES: Array<[string, RegExp]> = [
  ['巨量云图', /巨量云图|云图人群|云图/u],
  ['巨量千川', /巨量千川|千川/u],
  ['抖音电商罗盘', /抖音电商罗盘|抖店罗盘|抖音罗盘/u],
  ['抖音', /抖音|douyin/u],
  ['视频号', /视频号|channels\.weixin|weixin channel/u],
  ['微信小店', /微信小店|小店罗盘|小店投放|小店加热/u],
  ['有米云', /有米有数|有米云|有米/u],
  ['蝉妈妈', /蝉妈妈|查妈妈/u],
  ['小红书', /小红书|xiaohongshu/u],
  ['淘宝', /淘宝/u],
  ['天猫', /天猫/u],
  ['京东', /京东/u],
  ['拼多多', /拼多多/u],
  ['快手', /快手|kuaishou/u],
  ['飞书Base', /飞书多维表格|飞书base/u]
]

export function inferSourcePlatform(name: string, content = ''): string {
  const value = `${name}\n${content.slice(0, 80_000)}`.toLowerCase()
  const matches = PLATFORM_RULES.filter(([, pattern]) => pattern.test(value)).map(([label]) => label)
  const normalized = Array.from(new Set(matches)).filter((label) => {
    if (label === '抖音' && matches.includes('抖音电商罗盘')) return false
    if (label === '视频号' && matches.includes('微信小店')) return false
    return true
  })
  if (normalized.length === 1) return normalized[0]
  if (normalized.length > 1) return `多平台（${normalized.join('、')}）`
  return ''
}
