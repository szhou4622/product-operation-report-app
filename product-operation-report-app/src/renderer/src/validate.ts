import { FINAL_REPORT_REQUIRED_FOOTER, finalReportRequiredHeadings, PROCESS_TERMS } from './reportTemplate'

// 成稿前的来源绑定硬规则检查（启发式，非阻断，仅提示）
export function validateReport(md: string): string[] {
  const warnings: string[] = []
  if (!md.trim()) return warnings

  const normalized = md.replace(/\\\./g, '.')
  const lines = normalized.split('\n')
  const firstNonEmpty = lines.find((line) => line.trim())?.trim() || ''
  if (!firstNonEmpty.startsWith('# ')) {
    warnings.push('报告标题前出现了多余文本。最终成稿第一行必须直接是「# 产品名 产品经营报告」。')
  }

  // 0) 最终报告结构检查
  const headings = finalReportRequiredHeadings()
  const missing = headings.filter((heading) => !normalized.includes(heading))
  if (missing.length > 0) {
    warnings.push(`报告缺少标准章节：${missing.map((h) => h.replace(/^##\s*/, '')).join('、')}。`)
  }

  let lastIndex = -1
  const outOfOrder: string[] = []
  for (const heading of headings) {
    const index = normalized.indexOf(heading)
    if (index >= 0) {
      if (index < lastIndex) outOfOrder.push(heading.replace(/^##\s*/, ''))
      lastIndex = Math.max(lastIndex, index)
    }
  }
  if (outOfOrder.length > 0) {
    warnings.push(`报告章节顺序疑似不符合标准模板：${outOfOrder.join('、')}。`)
  }

  const allowedHeadingSet = new Set(headings)
  const extraHeadings = lines
    .map((line) => line.trim())
    .filter((line) => /^##\s+/.test(line) && !allowedHeadingSet.has(line))
  if (extraHeadings.length > 0) {
    warnings.push(`报告出现模板外二级章节：${extraHeadings.slice(0, 6).join('、')}。最终成稿只允许 0-11 章。`)
  }

  if (!/^生成日期：/m.test(normalized)) {
    warnings.push('报告缺少「生成日期：YYYY-MM-DD」这一行。')
  } else {
    const d = new Date()
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const dateLine = normalized.match(/^生成日期：(.+)$/m)?.[1]?.trim()
    if (dateLine && dateLine !== today) {
      warnings.push(`报告生成日期不是今天：当前为 ${dateLine}，应为 ${today}。`)
    }
  }

  if (!normalized.includes('### 9.1 第一轮建议选题')) {
    warnings.push('第 9 章缺少「9.1 第一轮建议选题」。')
  }

  if (!normalized.includes('### 9.2 3 秒开头库') && !normalized.includes('### 9.2 3秒开头库')) {
    warnings.push('第 9 章缺少「9.2 3 秒开头库」。')
  }

  if (!normalized.includes(FINAL_REPORT_REQUIRED_FOOTER)) {
    warnings.push('报告末尾缺少 AI 生成谨慎参考注释。')
  }

  const hasHeader = (cols: string[]): boolean =>
    lines.some((line) => {
      if (!line.trim().startsWith('|')) return false
      return cols.every((col) => line.includes(col))
    })
  const requiredTableHeaders: { label: string; cols: string[] }[] = [
    { label: '0 章人群优先级表', cols: ['优先级', '核心人群', '关键判断'] },
    { label: '1 章数据来源表', cols: ['数据类型', '来源', '本次用途'] },
    { label: '2 章产品基础信息表', cols: ['模块', '当前判断'] },
    { label: '5 章卖点拆解表', cols: ['卖点维度', '我方产品卖点', '用户能感知的好处'] },
    { label: '6 章卖点排序表', cols: ['排序', '用户视角卖点', '对应产品事实', '打动的人群/场景', '作用'] },
    { label: '7 章人群画像表', cols: ['优先级', '成交人群', '数据依据/特征', '核心卖点', '核心场景', '内容语言'] },
    { label: '8 章内容主线表', cols: ['内容主线', '数据/分析依据', '对应人群', '对应卖点', '核心场景', '内容表达', '作用'] },
    { label: '8 章内容体量表', cols: ['内容主线', '建议占比', '原因'] },
    { label: '9.1 选题表', cols: ['脚本编号', '内容主线', '选题', '视频分类', '视角', '人群', '场景', '开头类型', '3 秒开头来源', '参考视频结构', '优先级'] },
    { label: '9.2 3 秒开头库', cols: ['开头类型', '可直接复用的原始开头'] }
  ]
  const missingTables = requiredTableHeaders.filter((item) => !hasHeader(item.cols)).map((item) => item.label)
  if (missingTables.length > 0) {
    warnings.push(`报告缺少目标格式要求的表格列：${missingTables.join('、')}。`)
  }

  const processTerms = PROCESS_TERMS.filter((term) => normalized.includes(term))
  if (processTerms.length > 0) {
    warnings.push(`报告里出现过程性词汇：${processTerms.slice(0, 8).join('、')}。最终成稿应像正式报告，不要保留过程记录。`)
  }

  // 1) 人群列疑似只写内部标签（应写具体人群描述）
  const labelCell = /\|\s*(第一主力人?群?|第二承接人?群?|视频号核心人?群?|增量拓展人?群?)\s*\|/
  const concreteAudience = /(\d+\s*[-/到至]\s*\d+\s*岁|\d+\+|女性|男性|妈妈|宝妈|家庭|主理人|银发|中老年|白领|中产|用户|人群)/
  if (lines.some((line) => labelCell.test(line) && !concreteAudience.test(line))) {
    warnings.push(
      '人群列疑似只写了内部标签（第一主力/第二承接/视频号核心/增量拓展），应改为具体人群描述，如「31-45 岁已育女性/家庭主理人」。'
    )
  }

  // 2) 缺失项提示（提醒补数据，不算错误）
  const needCount = (md.match(/需补充/g) || []).length
  if (needCount > 0) {
    warnings.push(`报告里有 ${needCount} 处「需补充」，发布前建议补齐数据来源。`)
  }

  // 3) 第9步若没有「3秒开头来源」字样，提醒检查来源绑定
  if (/执行|选题|脚本编号/.test(md) && !/3\s*秒开头来源/.test(md)) {
    warnings.push('执行选题表里没看到「3秒开头来源」列，请确认 3 秒开头均来自素材表、未编造。')
  }

  return warnings
}

/** 只返回会导致导出丢章、乱序或缺核心表格的硬错误；证据不足提醒仍允许用户导出。 */
export function validateReportStructure(md: string): string[] {
  const hardPrefixes = [
    '报告标题前出现了多余文本',
    '报告缺少标准章节',
    '报告章节顺序疑似不符合标准模板',
    '报告出现模板外二级章节',
    '报告缺少「生成日期',
    '第 9 章缺少',
    '报告末尾缺少',
    '报告缺少目标格式要求的表格列'
  ]
  return validateReport(md).filter((warning) => hardPrefixes.some((prefix) => warning.startsWith(prefix)))
}
