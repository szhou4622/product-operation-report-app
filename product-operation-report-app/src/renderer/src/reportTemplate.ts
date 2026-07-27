export interface ReportSection {
  level: 2
  number: string
  title: string
  note: string
  format: string[]
}

export const FINAL_REPORT_TITLE = '# 产品名 产品经营报告'
export const FINAL_REPORT_DATE_LINE = '生成日期：YYYY-MM-DD'
export const FINAL_REPORT_REQUIRED_FOOTER = '> (注：内容由 AI 生成，请谨慎参考）'
export const FINAL_REPORT_VISUAL_BRIEF_GUIDE = `在生成日期下一行插入下面这段不可见 HTML 注释，用本次资料和已完成分析填写；不要把它写成可见章节：
<!-- Product visual brief
role: 产品在用户生活或工作中承担的作用；无依据写需补充
audience: 核心受众的阅读和决策特点；无依据写需补充
scene: 主要购买或使用场景；无依据写需补充
value-signal: practicality | price | premium | expertise | efficiency | identity | gifting | 需补充
trust-model: visible-use | ingredients | tests | authority | reviews | craft | service | ROI | 需补充
design-direction: household-field-guide | restrained-catalogue | technical-workbench | calm-evidence | energetic-social | utilitarian-decision-brief | material-editorial | neutral-evidence
evidence-confidence: confirmed | partial | insufficient
-->

视觉方向只能根据有来源的产品定位选择：
- 家庭日常/高频实用使用选 household-field-guide。
- 高端、礼赠、体验或身份价值选 restrained-catalogue。
- 专业参数、性能、机制或标准选 technical-workbench。
- 成分、安全、检测或安心决策选 calm-evidence。
- 年轻、社交、新奇和分享场景选 energetic-social。
- 企业采购、工业、ROI、交付或供应链选 utilitarian-decision-brief。
- 产地、手工、传统、文化或真实工艺选 material-editorial。
- 证据不足、信号冲突或只有产品名时必须选 neutral-evidence，并写 evidence-confidence: insufficient。
不得为了视觉效果编造品牌、受众、场景、功效、档次或信任背书。`

export interface FinalReportPart {
  id: string
  label: string
  sections: string[]
  includeTitle?: boolean
  includeDate?: boolean
  includeFooter?: boolean
}

export const FINAL_REPORT_PARTS: FinalReportPart[] = [
  { id: 'part-0-4', label: '0-4 章：结论、数据、产品、一方与竞品判断', sections: ['0', '1', '2', '3', '4'], includeTitle: true, includeDate: true },
  { id: 'part-5-8', label: '5-8 章：卖点、人群与内容主线', sections: ['5', '6', '7', '8'] },
  { id: 'part-9', label: '9 章：内容执行方向', sections: ['9'] },
  { id: 'part-10-11', label: '10-11 章：经营建议与限制', sections: ['10', '11'], includeFooter: true }
]

export const FINAL_REPORT_SECTIONS: ReportSection[] = [
  {
    level: 2,
    number: '0',
    title: '结论先行',
    note: '直接给经营结论、人群优先级和内容策略结论，不铺垫过程。',
    format: [
      '先用 1-2 个短段落直接说明产品本质、核心购买场景、当前最该打的经营方向。',
      '必须包含人群优先级表，列名固定为：优先级 | 核心人群 | 关键判断。',
      '结尾用 1 个短段落给内容策略总判断，优先说 3 条左右主线。'
    ]
  },
  {
    level: 2,
    number: '1',
    title: '数据来源与使用范围',
    note: '用表格列出数据类型、来源、本次用途，并说明数据限制。',
    format: [
      '必须用表格，列名固定为：数据类型 | 来源 | 本次用途。',
      '表后用「备注：」说明数据使用边界，比如素材成交字段缺失、截图只能按可见字段判断。',
      '只列本次真正使用的数据，不写泛泛的数据方法论。'
    ]
  },
  {
    level: 2,
    number: '2',
    title: '产品基础信息',
    note: '产品名称、类目、核心 SKU、成交规模、定位、场景、已知卖点。',
    format: [
      '必须用表格，列名固定为：模块 | 当前判断。',
      '模块建议包含：产品名称 / 类目、核心成交商品、核心成交规模、当前客单、当前定位、主要使用场景、已知核心卖点。',
      '表后用 1 个短段落写商品结构判断；没有商品数据时写「商品结构判断：需补充」。'
    ]
  },
  {
    level: 2,
    number: '3',
    title: '一方数据核心判断',
    note: '按平台或数据源拆 3.1/3.2/3.3 小节，只保留关键判断。',
    format: [
      '按真实数据源拆小节，例如「### 3.1 视频号成交人群」「### 3.2 云图购买画像」「### 3.3 抖店成交人群」。',
      '每个小节先给 1 句引导，再用表格，列名固定为：维度 | 关键数据 | 经营含义。',
      '每个小节表后用「XX核心判断：」写 1 个短段落。'
    ]
  },
  {
    level: 2,
    number: '4',
    title: '竞品与素材打法判断',
    note: '包含自有素材结构、竞品素材结构、信任打法和可借鉴结构。',
    format: [
      '必须包含「### 4.1 自有爆款素材结构」和「### 4.2 竞品素材结构」。',
      '自有素材结构先用「指标 | 结果」表，再列典型 3 秒开头表，列名建议：类型 | 原始 3 秒开头 | 可复用方向。',
      '竞品素材结构先用「指标 | 结果」表，再列竞品信任打法表，列名建议：竞品开头 | 打法本质 | 我方可迁移方向。',
      '如果没有实采竞品资料，本章必须明确写「未实采竞品，仅输出竞品采集方向」，不要伪造竞品事实。'
    ]
  },
  {
    level: 2,
    number: '5',
    title: '产品全量卖点拆解',
    note: '12 维卖点拆解，但只保留最终判断，不堆全部中间推理。',
    format: [
      '必须用表格，列名固定为：卖点维度 | 我方产品卖点 | 用户能感知的好处。',
      '卖点维度固定 12 类：产品包装、价格、工艺、材料、功能性、场景、地点、人群、使用方法、背书、情怀、稀缺。',
      '只保留最终可用于经营和内容表达的判断，不展开分析过程。'
    ]
  },
  {
    level: 2,
    number: '6',
    title: '卖点用户视角排序',
    note: '按用户决策价值排序，说明对应产品事实、人群场景和作用。',
    format: [
      '必须用表格，列名固定为：排序 | 用户视角卖点 | 对应产品事实 | 打动的人群/场景 | 作用。',
      '表后用「排序判断：」写 1 个短段落，说明内容开头、中段、收割线分别该讲什么。'
    ]
  },
  {
    level: 2,
    number: '7',
    title: '核心成交人群画像与卖点场景匹配',
    note: '输出核心人群画像、数据依据、卖点、场景和内容语言。',
    format: [
      '先写「一句话总判断：」并用 1 个短段落总结核心成交人群。',
      '必须用表格，列名固定为：优先级 | 成交人群 | 数据依据/特征 | 核心卖点 | 核心场景 | 内容语言。',
      '成交人群列必须写具体人群描述，不要只写第一主力、第二承接、视频号核心、增量拓展。'
    ]
  },
  {
    level: 2,
    number: '8',
    title: '视频号内容主线设计',
    note: '输出 3-5 条主线、对应人群、卖点、场景、表达和优先级。',
    format: [
      '先用 1 个短段落说明视频号内容总策略。',
      '必须用表格，列名固定为：内容主线 | 数据/分析依据 | 对应人群 | 对应卖点 | 核心场景 | 内容表达 | 作用。',
      '表后必须有「建议内容体量：」表，列名固定为：内容主线 | 建议占比 | 原因。',
      '主线数量控制在 3-5 条，除非资料强烈支持，否则不要扩成很多条。'
    ]
  },
  {
    level: 2,
    number: '9',
    title: '内容执行方向',
    note: '包含第一轮建议选题，必要时附 3 秒开头库。',
    format: [
      '必须包含「### 9.1 第一轮建议选题」，用表格，列名固定为：脚本编号 | 内容主线 | 选题 | 视频分类 | 视角 | 人群 | 场景 | 开头类型 | 3 秒开头来源 | 参考视频结构 | 优先级。',
      '必须包含「### 9.2 3 秒开头库」，用表格，列名固定为：开头类型 | 可直接复用的原始开头。',
      '9.1 选题表控制在 6-8 行，优先保留 P0/P1，不要为了凑数输出 10 条以上。',
      '参考视频结构用短句概括，避免长段落撑爆表格。',
      '9.2 开头库控制在 6-10 行，优先使用真实自有或竞品素材里的原始 3 秒开头。',
      '3 秒开头必须来自素材资料；没有真实素材开头时写「需补充素材来源」，不要编造。'
    ]
  },
  {
    level: 2,
    number: '10',
    title: '经营建议',
    note: '给短期可执行的经营与内容建议。',
    format: [
      '必须使用 1. 2. 3. 编号列表。',
      '建议控制在 4-6 条，每条聚焦一个可执行动作。',
      '不要写空泛建议，例如「加强投放」「优化内容」；必须落到人群、卖点、素材、SKU 或活动机制。'
    ]
  },
  {
    level: 2,
    number: '11',
    title: '本次报告的限制',
    note: '如实说明缺失数据、未实采竞品、需品牌确认的背书等。',
    format: [
      '必须使用短横线列表。',
      '写清楚：缺失数据、截图限制、素材字段缺失、背书/检测/功效/活动机制需要品牌确认的地方。',
      `最后一行必须输出：${FINAL_REPORT_REQUIRED_FOOTER}`
    ]
  }
]

export const PROCESS_TERMS = [
  '第1步',
  '第 1 步',
  '第2步',
  '第 2 步',
  '第3步',
  '第 3 步',
  '第4步',
  '第 4 步',
  '第5步',
  '第 5 步',
  '第6步',
  '第 6 步',
  '第7步',
  '第 7 步',
  '第8步',
  '第 8 步',
  '第9步',
  '第 9 步',
  '上游产出',
  '本步任务',
  '分析过程',
  '归一后的数据集',
  '已生成的上游产出'
]

export function finalReportOutlineForPrompt(): string {
  return [
    FINAL_REPORT_TITLE,
    FINAL_REPORT_DATE_LINE,
    ...FINAL_REPORT_SECTIONS.map((section) => `## ${section.number}. ${section.title}`)
  ].join('\n')
}

export function finalReportFormatGuide(): string {
  return FINAL_REPORT_SECTIONS.map((section) => {
    const rules = section.format.map((rule) => `- ${rule}`).join('\n')
    return `## ${section.number}. ${section.title}\n${section.note}\n${rules}`
  }).join('\n\n')
}

export function finalReportFormatGuideForSections(sectionNumbers: string[]): string {
  const set = new Set(sectionNumbers)
  return FINAL_REPORT_SECTIONS.filter((section) => set.has(section.number))
    .map((section) => {
      const rules = section.format.map((rule) => `- ${rule}`).join('\n')
      return `## ${section.number}. ${section.title}\n${section.note}\n${rules}`
    })
    .join('\n\n')
}

export function finalReportOutlineForSections(part: FinalReportPart): string {
  const set = new Set(part.sections)
  const lines: string[] = []
  if (part.includeTitle) lines.push(FINAL_REPORT_TITLE)
  if (part.includeDate) lines.push(FINAL_REPORT_DATE_LINE)
  lines.push(
    ...FINAL_REPORT_SECTIONS.filter((section) => set.has(section.number)).map(
      (section) => `## ${section.number}. ${section.title}`
    )
  )
  if (part.includeFooter) lines.push(FINAL_REPORT_REQUIRED_FOOTER)
  return lines.join('\n')
}

export function finalReportRequiredHeadings(): string[] {
  return FINAL_REPORT_SECTIONS.map((section) => `## ${section.number}. ${section.title}`)
}
