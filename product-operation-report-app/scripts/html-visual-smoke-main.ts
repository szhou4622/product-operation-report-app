import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { app, BrowserWindow } from 'electron'
import {
  buildHtmlReportPresentation,
  markdownToHtmlDocument,
  parseHtmlReportModel
} from '../src/main/htmlReport'

interface SavedReportProject {
  reportMarkdown?: unknown
}

interface Viewport {
  width: number
  height: number
}

const projectPath = process.env.REPORT_PROJECT_PATH
const keepOutputs = process.env.KEEP_HTML_VISUAL_OUTPUT === '1'
const outputDir = process.env.REPORT_VISUAL_OUTPUT_DIR
  ? resolve(process.env.REPORT_VISUAL_OUTPUT_DIR)
  : mkdtempSync(join(tmpdir(), 'por-html-visual-'))
const viewports: Viewport[] = [
  { width: 320, height: 760 },
  { width: 375, height: 812 },
  { width: 414, height: 896 },
  { width: 768, height: 1024 },
  { width: 1440, height: 1000 },
  { width: 2560, height: 1080 }
]
let activeWindow: BrowserWindow | null = null

const SAMPLE_REPORT = `# 示例产品 产品经营报告
生成日期：2026-07-27

<!-- Product visual brief
role: 家庭日常快速配餐
audience: 需要快速理解经营结论的小白用户
scene: 工作日晚餐
value-signal: practicality
trust-model: visible-use
design-direction: household-field-guide
evidence-confidence: confirmed
-->

## 0. 结论先行
优先服务家庭做饭决策者，先用真实使用场景证明方便，再补充产品信任。

| 优先级 | 核心人群 | 关键判断 |
|---|---|---|
| P1 | 31-45岁家庭做饭人群 | 先讲快手晚餐 |
| P2 | 家庭囤货人群 | 再讲多场景使用 |

## 1. 数据来源与使用范围
| 数据类型 | 来源 | 本次用途 |
|---|---|---|
| 成交人群 | 示例平台 | 判断核心人群 |

## 2. 产品基础信息
| 模块 | 当前判断 |
|---|---|
| 产品 | 示例产品 |
| 场景 | 家庭晚餐 |

## 3. 一方数据核心判断
### 3.1 示例平台成交人群
| 维度 | 关键数据 | 经营含义 |
|---|---|---|
| 性别 | 女性占比 68.4% | 内容优先服务家庭做饭决策者 |
| 婚育 | 已育占比 71.2% | 强调家庭场景 |

## 4. 竞品与素材打法判断
| 类型 | 原始 3 秒开头 | 可复用方向 |
|---|---|---|
| 场景型 | 下班吃什么 | 快手晚餐 |

## 5. 产品全量卖点拆解
| 卖点维度 | 我方产品卖点 | 用户能感知的好处 |
|---|---|---|
| 原料 | 自然发酵酸菜，配料简单 | 家庭做菜能直接感知酸菜发酵风味 |
| 使用 | 酸菜分袋，快速做菜 | 家庭晚餐做菜更快速 |
| 信任 | 配料清晰，发酵过程可见 | 家庭选择酸菜时更容易核对配料 |
| 场景 | 家庭日常酸菜做法 | 快速完成一顿家庭饭菜 |

## 6. 卖点用户视角排序
| 排序 | 用户视角卖点 | 对应产品事实 | 打动的人群/场景 | 作用 |
|---|---|---|---|---|
| 1 | 做饭更省事 | 打开即可使用 | 工作日晚餐 | 拉动需求 |

## 7. 核心成交人群画像与卖点场景匹配
| 优先级 | 成交人群 | 数据依据/特征 | 核心卖点 | 核心场景 | 内容语言 |
|---|---|---|---|---|---|
| P1 | 家庭做饭人群 | 女性占比 68.4% | 少准备步骤 | 工作日晚餐 | 直接易懂 |

## 8. 视频号内容主线设计
| 内容主线 | 对应人群 | 选题方向 | 建议占比 |
|---|---|---|---|
| 快手晚餐 | 家庭做饭人群 | 下班吃什么 | 60% |
| 多场景使用 | 家庭囤货人群 | 一袋多做法 | 40% |

## 9. 内容执行方向
| 脚本编号 | 选题 | 3 秒开头 | 视频分类 | 视角 |
|---|---|---|---|---|
| S01 | 快手晚餐 | 下班吃什么 | 3.1 | 用户 |
| S02 | 使用证明 | 打开直接用 | 3.2 | 商家 |

## 10. 经营建议
1. 短期优先放大快手晚餐内容线。
2. 持续按平台拆分人群表达。
3. 检测报告待补充后再放大信任内容。

## 11. 本次报告的限制
- 示例数据仅用于布局和离线测试。
- 正式结论必须以用户导入资料为准。
`

function ensureWithResolvers(): void {
  const promiseConstructor = Promise as unknown as { withResolvers?: () => unknown }
  if (typeof promiseConstructor.withResolvers === 'function') return
  promiseConstructor.withResolvers = function <T>() {
    let resolvePromise!: (value: T | PromiseLike<T>) => void
    let rejectPromise!: (reason?: unknown) => void
    const promise = new Promise<T>((resolve, reject) => {
      resolvePromise = resolve
      rejectPromise = reject
    })
    return { promise, resolve: resolvePromise, reject: rejectPromise }
  }
}

function markerText(value: string): string {
  return value
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, '')
    .trim()
}

async function readPdfAudit(pdfPath: string): Promise<{
  text: string
  pageSizes: Array<{ width: number; height: number }>
  pageTexts: string[]
}> {
  ensureWithResolvers()
  const [pdfjs, pdfWorker] = await Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('pdfjs-dist/legacy/build/pdf.worker.mjs')
  ])
  ;(
    globalThis as typeof globalThis & {
      pdfjsWorker?: typeof pdfWorker
    }
  ).pdfjsWorker ??= pdfWorker
  const document = await pdfjs.getDocument({
    data: new Uint8Array(readFileSync(pdfPath)),
    useSystemFonts: true,
    isEvalSupported: false
  }).promise
  const pages: string[] = []
  const pageSizes: Array<{ width: number; height: number }> = []
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber)
      const viewport = page.getViewport({ scale: 1 })
      pageSizes.push({ width: viewport.width, height: viewport.height })
      const content = await page.getTextContent()
      pages.push(
        content.items
          .map((item) => ('str' in item ? (item as { str: string }).str : ''))
          .join('')
      )
    }
  } finally {
    await document.cleanup()
    await document.destroy()
  }
  return {
    text: markerText(pages.join('')),
    pageSizes,
    pageTexts: pages.map(markerText)
  }
}

async function runAudit(): Promise<void> {
  let markdown = SAMPLE_REPORT
  let projectName = '内置匿名样本'
  if (projectPath) {
    const project = JSON.parse(readFileSync(projectPath, 'utf8')) as SavedReportProject
    assert.equal(typeof project.reportMarkdown, 'string', '项目中没有可导出的报告。')
    assert.ok(project.reportMarkdown.trim(), '项目中的报告为空。')
    markdown = project.reportMarkdown
    projectName = basename(projectPath)
  }

  mkdirSync(outputDir, { recursive: true })
  const model = parseHtmlReportModel(markdown)
  const presentation = buildHtmlReportPresentation(model)
  const printMarkers = presentation.sections
    .flatMap((sectionPlan) =>
      sectionPlan.tables
        .filter((tablePlan) => tablePlan.mode === 'collapsed')
        .flatMap((tablePlan) => {
          const table = model.sections
            .find((section) => section.number === sectionPlan.sectionNumber)
            ?.tables[tablePlan.tableIndex]
          if (!table || table.rows.length === 0) return []
          return [table.rows[0], table.rows[table.rows.length - 1]]
            .map((row) => row.map(markerText).find((cell) => cell.length >= 2) || '')
            .filter(Boolean)
        })
    )
    .filter((value, index, values) => values.indexOf(value) === index)
  const html = await markdownToHtmlDocument(markdown)
  const htmlPath = join(outputDir, 'report-preview.html')
  writeFileSync(htmlPath, html, 'utf8')
  if (process.env.HTML_VISUAL_TEST_FORCE_FAILURE === '1') {
    throw new Error('HTML visual cleanup failure-path probe')
  }

  const errors: string[] = []
  const externalRequests: string[] = []
  const window = (activeWindow = new BrowserWindow({
    show: false,
    width: 1440,
    height: 1000,
    backgroundColor: '#f4f6f5',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  }))
  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) errors.push(message)
  })
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details) => {
    externalRequests.push(details.url)
  })
  await window.loadFile(htmlPath)

  const expectedDonuts = presentation.sections.reduce(
    (sum, sectionPlan) =>
      sum +
      sectionPlan.executionDistributions.length +
      (sectionPlan.contentMix?.mode === 'stacked' ? 1 : 0),
    0
  )
  const expectedWordClouds = presentation.sections.filter(
    (sectionPlan) => sectionPlan.keywordCloud
  ).length
  const visualAudit = (await window.webContents.executeJavaScript(
    `(() => ({
      donuts: document.querySelectorAll('.donut-chart').length,
      visibleDonuts: Array.from(document.querySelectorAll('.donut-chart')).filter((element) => {
        const rect = element.getBoundingClientRect()
        return rect.width >= 120 && rect.height >= 120 && getComputedStyle(element).backgroundImage !== 'none'
      }).length,
      wordClouds: document.querySelectorAll('.word-cloud').length,
      wordItems: Array.from(document.querySelectorAll('.word-cloud__item')).filter((element) =>
        Number(element.getAttribute('data-count')) >= 2
      ).length
    }))()`
  )) as { donuts: number; visibleDonuts: number; wordClouds: number; wordItems: number }
  assert.equal(visualAudit.donuts, expectedDonuts, '环图数量与展示模型不一致。')
  assert.equal(visualAudit.visibleDonuts, expectedDonuts, '环图未正确显示或尺寸过小。')
  assert.equal(visualAudit.wordClouds, expectedWordClouds, '词云数量与展示模型不一致。')
  if (expectedWordClouds > 0) {
    assert.ok(visualAudit.wordItems >= 6, '词云未显示足够的可核对高频词。')
  }

  const keyboardAudit = (await window.webContents.executeJavaScript(
    `(() => {
      const focusable = Array.from(document.querySelectorAll('a[href], summary, [tabindex]'))
        .filter((element) => {
          const style = getComputedStyle(element)
          return style.display !== 'none' && style.visibility !== 'hidden'
        })
      const summary = document.querySelector('.evidence-disclosure summary')
      if (!(summary instanceof HTMLElement)) {
        return { firstClass: focusable[0]?.className || '', summaryFound: false, summaryFocused: false }
      }
      summary.focus()
      return {
        firstClass: focusable[0]?.className || '',
        summaryFound: true,
        summaryFocused: document.activeElement === summary,
        initiallyOpen: summary.parentElement?.hasAttribute('open') || false
      }
    })()`
  )) as {
    firstClass: string
    summaryFound: boolean
    summaryFocused: boolean
    initiallyOpen?: boolean
  }
  assert.equal(keyboardAudit.firstClass, 'skip-link', '键盘焦点顺序应先到“跳到报告正文”。')
  assert.equal(keyboardAudit.summaryFound, true, '长表必须提供可聚焦的展开入口。')
  assert.equal(keyboardAudit.summaryFocused, true, '长表展开入口无法通过键盘获得焦点。')
  assert.equal(keyboardAudit.initiallyOpen, false, '长表在屏幕端应默认折叠。')
  const disclosureOpened = await window.webContents.executeJavaScript(
    `(() => {
      const summary = document.querySelector('.evidence-disclosure summary')
      if (!(summary instanceof HTMLElement)) return false
      summary.click()
      return summary.parentElement?.hasAttribute('open') || false
    })()`
  )
  assert.equal(disclosureOpened, true, '完整数据入口无法展开。')

  let reducedMotionBehavior = ''
  try {
    window.webContents.debugger.attach('1.3')
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      media: 'screen',
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
    })
    reducedMotionBehavior = await window.webContents.executeJavaScript(
      `getComputedStyle(document.documentElement).scrollBehavior`
    )
    assert.equal(reducedMotionBehavior, 'auto', '减少动效设置未关闭平滑滚动。')
  } finally {
    if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach()
  }

  const captures: string[] = []
  const viewportLayout: Array<Viewport & { innerWidth: number; scrollWidth: number }> = []
  for (const viewport of viewports) {
    window.setContentSize(viewport.width, viewport.height)
    let layout = { innerWidth: -1, scrollWidth: -1 }
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 50))
      layout = (await window.webContents.executeJavaScript(
        `({ innerWidth: window.innerWidth, scrollWidth: document.documentElement.scrollWidth })`
      )) as { innerWidth: number; scrollWidth: number }
      if (Math.abs(layout.innerWidth - viewport.width) <= 1) break
    }
    viewportLayout.push({ ...viewport, ...layout })
    assert.ok(
      Math.abs(layout.innerWidth - viewport.width) <= 1,
      `视口设置失败：目标 ${viewport.width}px，实际 ${layout.innerWidth}px。`
    )
    assert.ok(
      layout.scrollWidth <= layout.innerWidth + 1,
      `${viewport.width}px 视口出现横向滚动：内容 ${layout.scrollWidth}px，视口 ${layout.innerWidth}px。`
    )
    const image = await window.webContents.capturePage()
    const file = join(outputDir, `report-${viewport.width}x${viewport.height}.png`)
    writeFileSync(file, image.toPNG())
    captures.push(file)
  }
  const pdfPath = join(outputDir, 'report-print.pdf')
  writeFileSync(
    pdfPath,
    await window.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      preferCSSPageSize: true
    })
  )
  const pdfAudit = await readPdfAudit(pdfPath)
  for (const marker of printMarkers) {
    assert.ok(
      pdfAudit.text.includes(marker),
      `打印 PDF 丢失折叠表数据：未找到“${marker}”。`
    )
  }
  assert.ok(
    pdfAudit.pageSizes.some((page) => page.height > page.width),
    '打印 PDF 缺少纵向页面。'
  )
  assert.ok(
    pdfAudit.pageSizes.some((page) => page.width > page.height),
    '宽表未进入横向打印页面。'
  )
  assert.equal(
    pdfAudit.pageTexts.some((pageText) => pageText.length < 2),
    false,
    '打印 PDF 出现空白页。'
  )
  window.setContentSize(1440, 1000)
  const sectionLayout = (await window.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll('[data-section]')).map((element) => ({
      section: element.getAttribute('data-section'),
      top: Math.round(element.getBoundingClientRect().top + window.scrollY),
      height: Math.round(element.getBoundingClientRect().height)
    }))`
  )) as Array<{ section: string; top: number; height: number }>
  const sectionPositions: Record<string, number> = {}
  for (const sectionNumber of ['1', '3', '4', '5', '7', '8', '9', '10', '11']) {
    sectionPositions[sectionNumber] = await window.webContents.executeJavaScript(
      `(() => {
        const target = document.querySelector('[data-section="${sectionNumber}"]')
        if (!target) return -1
        const top = target.getBoundingClientRect().top + window.scrollY
        const previous = document.documentElement.style.scrollBehavior
        document.documentElement.style.scrollBehavior = 'auto'
        window.scrollTo({ top, behavior: 'auto' })
        document.documentElement.style.scrollBehavior = previous
        return window.scrollY
      })()`
    )
    await new Promise((resolveWait) => setTimeout(resolveWait, 80))
    const image = await window.webContents.capturePage()
    const file = join(outputDir, `report-1440-section-${sectionNumber}.png`)
    writeFileSync(file, image.toPNG())
    captures.push(file)
  }
  window.setContentSize(320, 760)
  await new Promise((resolveWait) => setTimeout(resolveWait, 120))
  const mobileSectionPositions: Record<string, number> = {}
  for (const sectionNumber of ['3', '5', '7', '8', '9', '10']) {
    mobileSectionPositions[sectionNumber] = await window.webContents.executeJavaScript(
      `(() => {
        const target = document.querySelector('[data-section="${sectionNumber}"]')
        if (!target) return -1
        const top = target.getBoundingClientRect().top + window.scrollY
        const previous = document.documentElement.style.scrollBehavior
        document.documentElement.style.scrollBehavior = 'auto'
        window.scrollTo({ top, behavior: 'auto' })
        document.documentElement.style.scrollBehavior = previous
        return window.scrollY
      })()`
    )
    await new Promise((resolveWait) => setTimeout(resolveWait, 80))
    const mobileLayout = (await window.webContents.executeJavaScript(
      `({ innerWidth: window.innerWidth, scrollWidth: document.documentElement.scrollWidth })`
    )) as { innerWidth: number; scrollWidth: number }
    assert.ok(
      mobileLayout.scrollWidth <= mobileLayout.innerWidth + 1,
      `320px 章节 ${sectionNumber} 出现横向滚动：内容 ${mobileLayout.scrollWidth}px，视口 ${mobileLayout.innerWidth}px。`
    )
    const image = await window.webContents.capturePage()
    const file = join(outputDir, `report-320-section-${sectionNumber}.png`)
    writeFileSync(file, image.toPNG())
    captures.push(file)
  }
  window.close()
  activeWindow = null

  assert.deepEqual(errors, [], `HTML 控制台出现错误：${errors.join('；')}`)
  assert.deepEqual(externalRequests, [], `HTML 发起了外部请求：${externalRequests.join('；')}`)
  const result = JSON.stringify(
    {
      project: projectName,
      outputsRetained: keepOutputs,
      outputDir: keepOutputs ? outputDir : '已自动清理',
      htmlPath: keepOutputs ? htmlPath : null,
      captures: keepOutputs ? captures : [],
      pdfPath: keepOutputs ? pdfPath : null,
      viewportLayout,
      sectionLayout,
      sectionPositions,
      mobileSectionPositions,
      keyboardAudit: {
        firstClass: keyboardAudit.firstClass,
        summaryFocused: keyboardAudit.summaryFocused,
        disclosureOpened
      },
      reducedMotionBehavior,
      printPages: pdfAudit.pageSizes,
      externalRequests: externalRequests.length,
      consoleErrors: errors.length
    },
    null,
    2
  )
  process.stdout.write(`${result}\n`)
}

async function run(): Promise<void> {
  try {
    await runAudit()
  } finally {
    if (activeWindow && !activeWindow.isDestroyed()) activeWindow.close()
    activeWindow = null
    if (!keepOutputs && existsSync(outputDir)) {
      rmSync(outputDir, { recursive: true, force: true })
    }
  }
}

app
  .whenReady()
  .then(run)
  .then(() => app.quit())
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })
