import { create } from 'zustand'
import type { AppSettings, ChatMessage, ProjectPhase, SavedProject } from '../../shared/types'
import { SOP_STEPS } from '../../shared/types'
import { FINAL_REPORT_PARTS } from './reportTemplate'
import { buildExtractMessages, buildFinalReportPartMessages, buildStepMessages, buildSummaryMessages, type PriorOutput } from './sop'

export interface Source {
  id: string
  name: string
  kind: 'image' | 'doc' | 'table' | 'other'
  dataUrl?: string
  text?: string
  size?: number
  parsing?: boolean
  error?: string
  attribution?: string // 用户指定归属：自有数据 / 竞品数据 / ''(未定)
  platform?: string // 用户指定平台/来源：巨量云图 / 抖店罗盘 / 视频号 / 抖音 / 有米云...
  purpose?: string // 用户指定信息类型：人群画像数据 / 内容素材数据 / 交易数据 / 产品手卡...
  note?: string // 用户对这份文件的补充信息（平台/时间/内容/文件外说明）
}

const PARSE_CONCURRENCY = 4
const REPORT_STEP_ID = SOP_STEPS[SOP_STEPS.length - 1]?.id ?? 9
const CLEAN_DETAIL_MARKER = '\n\n---\n## 各来源清洗明细'
const FINAL_PRIOR_OUTPUT_LIMIT = 7000
const MAX_SINGLE_FILE_BYTES = 80 * 1024 * 1024
const MAX_TOTAL_UPLOAD_BYTES = 350 * 1024 * 1024
const MAX_IMAGE_FILE_BYTES = 25 * 1024 * 1024

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)}MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`
  return `${bytes}B`
}

export type Phase = 'idle' | 'cleaning' | 'checkpoint1' | 'analyzing' | 'checkpoint2' | 'done'

export interface ChatMsg {
  id: string
  role: 'user' | 'assistant'
  text: string
  kind?: 'narration' | 'checkpoint' | 'report-block' | 'error'
}

export interface CleaningProgress {
  total: number
  done: number
  running: string[]
  failed: number
}

function restorePhase(project: SavedProject): Phase {
  if (project.phase === 'cleaning') return project.cleanedData ? 'checkpoint1' : 'idle'
  if (project.phase === 'analyzing') return project.cleanedData ? 'checkpoint1' : 'idle'
  return project.phase as Phase
}

export function buildProjectSnapshot(state: {
  sources: Source[]
  messages: ChatMsg[]
  cleanedData: string
  cleanDetails: { id: string; name: string; text: string }[]
  artifacts: Record<number, string>
  reportMarkdown: string
  phase: Phase
  steering: string
}): SavedProject {
  return {
    sources: state.sources.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      text: s.text,
      dataUrl: s.dataUrl,
      error: s.error,
      attribution: s.attribution,
      platform: s.platform,
      purpose: s.purpose,
      note: s.note,
      size: s.size
    })),
    messages: state.messages.map((m) => ({
      id: m.id,
      role: m.role,
      text: m.text,
      kind: m.kind
    })),
    cleanedData: state.cleanedData,
    cleanDetails: state.cleanDetails,
    artifacts: state.artifacts,
    reportMarkdown: state.reportMarkdown,
    phase: state.phase as ProjectPhase,
    steering: state.steering,
    updatedAt: new Date().toISOString()
  }
}

function classify(name: string): Source['kind'] {
  const ext = name.toLowerCase().split('.').pop() || ''
  if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) return 'image'
  if (['xlsx', 'xls', 'csv'].includes(ext)) return 'table'
  if (['pdf', 'docx', 'doc', 'pptx', 'ppt', 'md', 'markdown', 'txt'].includes(ext)) return 'doc'
  return 'other'
}

const SUPPORTED_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'webp', 'gif',
  'xlsx', 'xls', 'csv',
  'pdf', 'docx', 'doc', 'pptx', 'ppt', 'md', 'markdown', 'txt',
  'zip'
])
const extOf = (n: string): string => n.toLowerCase().split('.').pop() || ''
const isJunkName = (n: string): boolean => {
  const b = n.split('/').pop() || n
  return b.startsWith('.') || b.startsWith('~$') || b === 'Thumbs.db'
}
const displayName = (f: File): string => {
  const rel = (f as unknown as { webkitRelativePath?: string }).webkitRelativePath
  return rel && rel !== '' ? rel : f.name
}

const inferAttribution = (name: string): string => {
  const n = name.toLowerCase()
  if (n.includes('竞品') || n.includes('竞对') || n.includes('对标') || n.includes('competitor')) {
    return '竞品数据'
  }
  return '自有数据'
}

const inferPlatform = (name: string): string => {
  const n = name.toLowerCase()
  if (n.includes('视频号') || n.includes('wechat') || n.includes('weixin')) return '视频号'
  if (n.includes('抖音') || n.includes('douyin')) return '抖音'
  if (n.includes('云图')) return '巨量云图'
  if (n.includes('罗盘')) return '抖店罗盘'
  if (n.includes('有米')) return '有米云'
  if (n.includes('蝉妈妈') || n.includes('查妈妈')) return '蝉妈妈'
  if (n.includes('淘宝')) return '淘宝'
  if (n.includes('天猫')) return '天猫'
  if (n.includes('小红书') || n.includes('xiaohongshu')) return '小红书'
  if (n.includes('飞书') || n.includes('base')) return '飞书Base'
  return ''
}

const inferPurpose = (name: string): string => {
  const n = name.toLowerCase()
  if (n.includes('手卡') || n.includes('产品')) return '产品手卡'
  if (n.includes('人群') || n.includes('画像')) return '人群画像数据'
  if (n.includes('大盘') || n.includes('趋势') || n.includes('行业')) return '平台大盘数据'
  if (n.includes('商品') || n.includes('经营')) return '商品经营数据'
  if (n.includes('订单') || n.includes('成交') || n.includes('销售') || n.includes('交易')) return '交易数据'
  if (n.includes('评价') || n.includes('评论') || n.includes('反馈')) return '用户反馈数据'
  if (n.includes('投放') || n.includes('广告')) return '投放数据'
  if (n.includes('售后')) return '售后数据'
  if (n.includes('竞品') || n.includes('竞对') || n.includes('对标')) return '竞品素材数据'
  if (n.includes('素材') || n.includes('爆款') || n.includes('脚本')) return '内容素材数据'
  return ''
}

// 截图压缩：缩放到最大边 maxDim、转 JPEG，避免多张全尺寸图拼成超大请求体导致 fetch failed
const downscaleImage = (file: File, maxDim = 1600, quality = 0.9): Promise<string> =>
  new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result as string
      const img = new Image()
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height))
        if (scale === 1 && file.size < 600_000) {
          resolve(dataUrl) // 已经够小，原样用
          return
        }
        const w = Math.round(img.width * scale)
        const h = Math.round(img.height * scale)
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          resolve(dataUrl)
          return
        }
        ctx.drawImage(img, 0, 0, w, h)
        resolve(canvas.toDataURL('image/jpeg', quality))
      }
      img.onerror = () => resolve(dataUrl)
      img.src = dataUrl
    }
    reader.onerror = () => resolve('')
    reader.readAsDataURL(file)
  })

const toSourceLike = (
  s: Source
): {
  name: string
  kind: string
  text?: string
  dataUrl?: string
  attribution?: string
  platform?: string
  purpose?: string
  note?: string
} => ({
  name: s.name,
  kind: s.kind,
  text: s.text,
  dataUrl: s.dataUrl,
  attribution: s.attribution,
  platform: s.platform,
  purpose: s.purpose,
  note: s.note
})

function cleanedSummaryOnly(cleanedData: string): string {
  const index = cleanedData.indexOf(CLEAN_DETAIL_MARKER)
  return index >= 0 ? cleanedData.slice(0, index).trim() : cleanedData
}

function compactForFinalReport(text: string, limit = FINAL_PRIOR_OUTPUT_LIMIT): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n\n（以上为该步骤关键产出节选；最终成稿只保留经营决策需要的信息，不要复述过程。）`
}

async function runFinalReportInParts(params: {
  cleanedData: string
  priorOutputs: PriorOutput[]
  feedback: string
  setAbort: (fn: (() => void) | null) => void
  onProgress: (text: string) => void
  onRetry: (partLabel: string, n: number) => void
}): Promise<{ ok: boolean; text: string; error?: string }> {
  let full = ''
  for (const part of FINAL_REPORT_PARTS) {
    const messages = buildFinalReportPartMessages({
      part,
      cleanedData: params.cleanedData,
      priorOutputs: params.priorOutputs,
      feedback: params.feedback
    })
    let current = ''
    const res = await runModelRetry(
      messages,
      (acc) => {
        current = acc
        params.onProgress(`${full}${acc}`)
      },
      params.setAbort,
      (n) => params.onRetry(part.label, n),
      2
    )
    if (!res.ok) return { ok: false, text: full + current, error: res.error }
    full = `${full}${res.text.trim()}\n\n`
    params.onProgress(full)
  }
  return { ok: true, text: full.trim() }
}

// 包装流式调用为 Promise，并暴露中止函数
function runModel(
  messages: ChatMessage[],
  onAcc: (acc: string) => void,
  setAbort: (fn: (() => void) | null) => void
): Promise<{ ok: boolean; text: string; error?: string }> {
  return new Promise((resolve) => {
    let acc = ''
    let settled = false
    const done = (r: { ok: boolean; text: string; error?: string }): void => {
      if (settled) return
      settled = true
      setAbort(null)
      resolve(r)
    }
    const handle = window.api.sendChat(messages, {
      onChunk: (d) => {
        acc += d
        onAcc(acc)
      },
      onDone: (full) => done({ ok: true, text: full || acc }),
      onError: (msg) => done({ ok: false, text: acc, error: msg })
    })
    setAbort(() => {
      handle.abort()
      done({ ok: false, text: acc, error: '已停止' })
    })
  })
}

// 带重试的调用：仅在"网络中断且尚无任何输出"时重试，避免重复内容；用户主动停止不重试
async function runModelRetry(
  messages: ChatMessage[],
  onAcc: (acc: string) => void,
  setAbort: (fn: (() => void) | null) => void,
  onRetry?: (n: number) => void,
  retries = 2
): Promise<{ ok: boolean; text: string; error?: string }> {
  let res = await runModel(messages, onAcc, setAbort)
  let n = 0
  while (
    !res.ok &&
    n < retries &&
    !res.text &&
    /fetch failed|ECONNRESET|terminated|network/i.test(res.error || '')
  ) {
    n++
    onRetry?.(n)
    res = await runModel(messages, onAcc, setAbort)
  }
  return res
}

function defaultReportName(ext: string): string {
  const d = new Date()
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  return `产品经营报告_${stamp}.${ext}`
}

interface StoreState {
  settings: AppSettings | null
  settingsOpen: boolean
  sopRules: string
  sources: Source[]
  phase: Phase
  messages: ChatMsg[]
  cleanedData: string
  cleanDetails: { id: string; name: string; text: string }[]
  artifacts: Record<number, string>
  reportMarkdown: string
  abortFn: (() => void) | null
  steering: string
  exportStatus: string
  cleaningProgress: CleaningProgress

  init: () => Promise<void>
  setSettingsOpen: (open: boolean) => void
  saveSettings: (s: AppSettings) => Promise<void>
  addSources: (files: FileList | File[]) => Promise<void>
  removeSource: (id: string) => void
  setSourceAttribution: (id: string, attribution: string) => void
  setSourcePlatform: (id: string, platform: string) => void
  setSourcePurpose: (id: string, purpose: string) => void
  setSourceNote: (id: string, note: string) => void
  startGeneration: () => Promise<void>
  confirmCheckpoint: () => Promise<void>
  sendMessage: (text: string) => Promise<void>
  abort: () => void
  exportReport: (format: 'html' | 'md' | 'docx') => Promise<void>

  // 内部
  _post: (role: ChatMsg['role'], text: string, kind?: ChatMsg['kind']) => string
  _update: (id: string, text: string) => void
  _runCleaning: (isRerun: boolean) => Promise<void>
  _runAnalysis: () => Promise<void>
  _rerunReport: () => Promise<void>
}

export const useStore = create<StoreState>((set, get) => ({
  settings: null,
  settingsOpen: false,
  sopRules: '',
  sources: [],
  phase: 'idle',
  messages: [],
  cleanedData: '',
  cleanDetails: [],
  artifacts: {},
  reportMarkdown: '',
  abortFn: null,
  steering: '',
  exportStatus: '',
  cleaningProgress: { total: 0, done: 0, running: [], failed: 0 },

  init: async () => {
    const [settings, sopRules, lastProject] = await Promise.all([
      window.api.getSettings(),
      window.api.getSopRules(),
      window.api.loadLastProject()
    ])
    set({ settings, sopRules })
    if (lastProject) {
      set({
        sources: lastProject.sources.map((s) => ({ ...s, parsing: false })),
        messages: lastProject.messages,
        cleanedData: lastProject.cleanedData || '',
        cleanDetails: Array.isArray(lastProject.cleanDetails) ? lastProject.cleanDetails : [],
        artifacts: lastProject.artifacts || {},
        reportMarkdown: lastProject.reportMarkdown || '',
        phase: restorePhase(lastProject),
        steering: lastProject.steering || '',
        abortFn: null,
        cleaningProgress: { total: 0, done: 0, running: [], failed: 0 }
      })
    }
    if (!settings.profiles.length) set({ settingsOpen: true })
  },

  setSettingsOpen: (open) => set({ settingsOpen: open }),
  saveSettings: async (s) => {
    const saved = await window.api.saveSettings(s)
    set({ settings: saved })
  },

  _post: (role, text, kind) => {
    const id = crypto.randomUUID()
    set((s) => ({ messages: [...s.messages, { id, role, text, kind }] }))
    return id
  },
  _update: (id, text) => set((s) => ({ messages: s.messages.map((m) => (m.id === id ? { ...m, text } : m)) })),

  addSources: async (files) => {
    const acceptedJobs: Array<{
      id: string
      file: File
      name: string
      ext: string
      kind: Source['kind']
      attribution: string
      platform: string
      purpose: string
    }> = []
    const rejected: Source[] = []
    let acceptedBytes = get().sources.reduce((sum, s) => sum + ((s as Source & { size?: number }).size || 0), 0)

    for (const file of Array.from(files)) {
      const name = displayName(file)
      const e = extOf(file.name)
      if (isJunkName(name)) continue
      const base = {
        id: crypto.randomUUID(),
        name,
        kind: 'other' as Source['kind'],
        size: file.size,
        parsing: false,
        attribution: inferAttribution(name),
        platform: inferPlatform(name),
        purpose: inferPurpose(name)
      }
      const reject = (error: string): void => {
        rejected.push({ ...base, error })
      }
      if (!SUPPORTED_EXTS.has(e)) {
        reject(`已忽略：暂不支持 .${e || '未知'} 文件。支持截图、CSV/XLSX、PDF、Word/PPTX、Markdown/TXT、ZIP。`)
        continue
      }
      if (file.size > MAX_SINGLE_FILE_BYTES) {
        reject(`已忽略：单文件 ${formatBytes(file.size)} 超过上限 ${formatBytes(MAX_SINGLE_FILE_BYTES)}。请拆分或只上传关键页/关键表。`)
        continue
      }
      if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(e) && file.size > MAX_IMAGE_FILE_BYTES) {
        reject(`已忽略：图片 ${formatBytes(file.size)} 过大，请压缩到 ${formatBytes(MAX_IMAGE_FILE_BYTES)} 以内。`)
        continue
      }
      if (acceptedBytes + file.size > MAX_TOTAL_UPLOAD_BYTES) {
        reject(`已忽略：本次资料总量会超过 ${formatBytes(MAX_TOTAL_UPLOAD_BYTES)}，请分批分析。`)
        continue
      }
      acceptedBytes += file.size
      acceptedJobs.push({
        id: base.id,
        file,
        name,
        ext: e,
        kind: e === 'zip' ? ('other' as Source['kind']) : classify(file.name),
        attribution: base.attribution,
        platform: base.platform,
        purpose: base.purpose
      })
    }

    const jobs = acceptedJobs

    if (!jobs.length && rejected.length) {
      set((s) => ({ sources: [...s.sources, ...rejected] }))
      return
    }

    if (!jobs.length) return

    set((s) => ({
      sources: [
        ...s.sources,
        ...rejected,
        ...jobs.map((job) => ({
          id: job.id,
          name: job.name,
          kind: job.kind,
          size: job.file.size,
          parsing: true,
          attribution: job.attribution,
          platform: job.platform,
          purpose: job.purpose
        }))
      ]
    }))

    let next = 0
    const worker = async (): Promise<void> => {
      while (next < jobs.length) {
        const job = jobs[next++]
        try {
          if (job.ext === 'zip') {
            const buf = await job.file.arrayBuffer()
            const items = await window.api.parseArchive(job.name, buf)
            set((s) => ({
              sources: [
                ...s.sources.filter((x) => x.id !== job.id),
                ...items.map((it) => ({
                  id: crypto.randomUUID(),
                  name: it.name,
                  kind: it.kind,
                  size: undefined,
                  dataUrl: it.dataUrl,
                  text: it.ok ? it.text : undefined,
                  parsing: false,
                  error: it.ok ? undefined : it.error,
                  attribution: inferAttribution(`${job.name}/${it.name}`),
                  platform: inferPlatform(`${job.name}/${it.name}`),
                  purpose: inferPurpose(`${job.name}/${it.name}`),
                  note: `来自压缩包：${job.name}`
                }))
              ]
            }))
            continue
          }

          if (job.kind === 'image') {
            const dataUrl = await downscaleImage(job.file)
            set((s) => ({
              sources: s.sources.map((a) =>
                a.id === job.id ? { ...a, parsing: false, dataUrl, error: undefined } : a
              )
            }))
            continue
          }

          const buf = await job.file.arrayBuffer()
          const parsed = await window.api.parseFile(job.file.name, buf)
          set((s) => ({
            sources: s.sources.map((a) =>
              a.id === job.id
                ? {
                    ...a,
                    parsing: false,
                    text: parsed.ok ? parsed.text : undefined,
                    error: parsed.ok ? undefined : parsed.error
                  }
                : a
            )
          }))
        } catch (err) {
          set((s) => ({
            sources: s.sources.map((a) =>
              a.id === job.id ? { ...a, parsing: false, error: err instanceof Error ? err.message : String(err) } : a
            )
          }))
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(PARSE_CONCURRENCY, jobs.length) }, () => worker()))
  },

  removeSource: (id) => set((s) => ({ sources: s.sources.filter((a) => a.id !== id) })),

  setSourceAttribution: (id, attribution) =>
    set((s) => ({
      sources: s.sources.map((x) => (x.id === id ? { ...x, attribution } : x)),
      cleanDetails: s.cleanDetails.filter((d) => d.id !== id),
      cleanedData: '',
      artifacts: {},
      reportMarkdown: ''
    })),

  setSourcePlatform: (id, platform) =>
    set((s) => ({
      sources: s.sources.map((x) => (x.id === id ? { ...x, platform } : x)),
      cleanDetails: s.cleanDetails.filter((d) => d.id !== id),
      cleanedData: '',
      artifacts: {},
      reportMarkdown: ''
    })),

  setSourcePurpose: (id, purpose) =>
    set((s) => ({
      sources: s.sources.map((x) => (x.id === id ? { ...x, purpose } : x)),
      cleanDetails: s.cleanDetails.filter((d) => d.id !== id),
      cleanedData: '',
      artifacts: {},
      reportMarkdown: ''
    })),

  setSourceNote: (id, note) =>
    set((s) => ({
      sources: s.sources.map((x) => (x.id === id ? { ...x, note } : x)),
      cleanDetails: s.cleanDetails.filter((d) => d.id !== id),
      cleanedData: '',
      artifacts: {},
      reportMarkdown: ''
    })),

  startGeneration: async () => {
    const { settings, sources, phase } = get()
    if (phase === 'cleaning' || phase === 'analyzing') return
    const profile =
      settings?.profiles.find((p) => p.id === settings.activeProfileId) ?? settings?.profiles[0]
    if (!profile || !profile.baseURL.trim() || !profile.model.trim() || !profile.apiKey.trim()) {
      set({ settingsOpen: true })
      get()._post(
        'assistant',
        '还没有完成模型配置。请在设置里确认 ai英雄会 的 Base URL、模型名和 API Key。填好后即可使用；测试连通和测试读图只是可选排障。',
        'error'
      )
      return
    }
    if (sources.some((s) => s.parsing)) {
      get()._post('assistant', '还有文件正在本地解析，请等解析完成后再开始生成。', 'narration')
      return
    }
    if (!sources.some((s) => s.dataUrl || s.text)) {
      get()._post('assistant', '还没有可用的资料。请先上传截图/表格/文档/zip/文件夹，再点「开始生成」。', 'narration')
      return
    }
    set({ artifacts: {}, reportMarkdown: '' })
    await get()._runCleaning(false)
  },

  // 分批清洗：并发抽取每个文件(最多4个) → 汇总(输入截断+失败重试)，避免大请求被中转掐断
  _runCleaning: async (isRerun) => {
    set({ phase: 'cleaning' })
    const usable = get().sources.filter((s) => s.dataUrl || s.text)
    const usableIds = new Set(usable.map((s) => s.id))
    // 丢掉已删除文件的旧明细；只抽取还没处理过的文件（支持中断续跑 / 补传后只洗新文件）
    set((st) => ({ cleanDetails: st.cleanDetails.filter((d) => usableIds.has(d.id)) }))
    const doneIds = new Set(get().cleanDetails.map((d) => d.id))
    const todo = usable.filter((s) => !doneIds.has(s.id))
    set({
      cleaningProgress: {
        total: todo.length,
        done: 0,
        running: [],
        failed: 0
      }
    })

    if (todo.length) {
      const conc = Math.min(4, todo.length)
      get()._post(
        'assistant',
        `${isRerun ? '补充' : '开始'}清洗 ${todo.length} 份资料（并发 ${conc} 个，更快）……`,
        'narration'
      )

      const aborts = new Set<() => void>()
      let cancelled = false
      const failedRef: { current: { name: string; error: string } | null } = { current: null }
      set({ abortFn: () => { cancelled = true; aborts.forEach((fn) => fn()) } })

      let next = 0
      const worker = async (): Promise<void> => {
        while (!cancelled && !failedRef.current) {
          const i = next++
          if (i >= todo.length) return
          const s = todo[i]
          set((st) => ({
            cleaningProgress: {
              ...st.cleaningProgress,
              running: [...st.cleaningProgress.running, s.name].slice(0, 4)
            }
          }))
          get()._post('assistant', `⏳ 清洗：${s.name}`, 'narration')
          const res = await runModelRetry(
            buildExtractMessages(toSourceLike(s)),
            () => {},
            (fn) => {
              if (fn) aborts.add(fn)
            }
          )
          if (!res.ok) {
            if (!failedRef.current) failedRef.current = { name: s.name, error: res.error || '失败' }
            set((st) => ({
              cleaningProgress: {
                ...st.cleaningProgress,
                running: st.cleaningProgress.running.filter((name) => name !== s.name),
                failed: st.cleaningProgress.failed + 1
              }
            }))
            return
          }
          set((st) => ({ cleanDetails: [...st.cleanDetails, { id: s.id, name: s.name, text: res.text }] }))
          set((st) => ({
            cleaningProgress: {
              ...st.cleaningProgress,
              done: st.cleaningProgress.done + 1,
              running: st.cleaningProgress.running.filter((name) => name !== s.name)
            }
          }))
          get()._post('assistant', `✅ 已清洗：${s.name}`, 'narration')
        }
      }
      await Promise.all(Array.from({ length: conc }, () => worker()))
      set({ abortFn: null })

      if (cancelled) {
        set({ phase: get().cleanedData ? 'checkpoint1' : 'idle' })
        return
      }
      if (failedRef.current) {
        const f = failedRef.current
        get()._post(
          'assistant',
          `⚠️ 「${f.name}」清洗失败：${f.error}。已完成的会保留，再点「开始生成」会跳过它们只洗剩下的。`,
          'error'
        )
        set({ phase: get().cleanedData ? 'checkpoint1' : 'idle' })
        return
      }
    }

    // 汇总：输入按文件截断（避免请求过大），网络错误自动重试一次
    get()._post('assistant', '正在汇总「① 资料分类总览」…', 'narration')
    const details = get().cleanDetails.map((d) => ({ name: d.name, text: d.text }))
    const blockId = get()._post('assistant', '', 'report-block')
    const res = await runModelRetry(
      buildSummaryMessages(details, get().steering),
      (acc) => get()._update(blockId, acc),
      (fn) => set({ abortFn: fn }),
      (n) => get()._post('assistant', `汇总连接中断，正在重试（第 ${n} 次）…`, 'narration')
    )
    if (!res.ok) {
      get()._update(blockId, (res.text || '') + `\n\n⚠️ 汇总失败：${res.error}`)
      set({ phase: get().cleanedData ? 'checkpoint1' : 'idle' })
      return
    }

    // cleanedData = 汇总(总览+竞品+人群方向) + 各文件完整明细（供后续分析用，不截断）
    const detailFull = get().cleanDetails.map((d) => `### ${d.name}\n${d.text}`).join('\n\n')
    set({
      cleanedData: `${res.text}\n\n---\n## 各来源清洗明细\n\n${detailFull}`,
      phase: 'checkpoint1'
    })
    get()._post(
      'assistant',
      isRerun
        ? '✅ 已按你的要求重新归一（见上）。再核对一下「① 资料分类总览」和「竞品情况」；没问题点「确认，继续分析」，还要改继续说。'
        : '✅ 资料已清洗归一（见上）。请重点核对三处：\n' +
            '① 最上面的「① 资料分类总览」——每份文件的归属、平台/来源、信息类型对不对。不对就直接说，如「xxx.png 是竞品数据」「这份是自有数据」。\n' +
            '②「竞品情况」——若没发现竞品资料，我已按 8 类方向给了候选竞品 + 采集清单：可去采集后拖进来打字「重新归一」，或确认用推荐方向继续（会标注待验证），或打字指定竞品名。\n' +
            '③「初步人群方向」是否对。\n\n都没问题 → 点「确认，继续分析」；要纠偏 → 直接打字。',
      'checkpoint'
    )
  },

  _runAnalysis: async () => {
    set({ phase: 'analyzing' })
    const { sopRules, cleanedData } = get()
    for (const step of SOP_STEPS) {
      if (get().phase !== 'analyzing') return
      const isReportStep = step.id === REPORT_STEP_ID
      // 已完成的非成稿步骤直接跳过（支持中断后续跑）
      if (!isReportStep && get().artifacts[step.id]) continue

      const priorOutputs = SOP_STEPS.filter((s) => s.id < step.id && get().artifacts[s.id]).map((s) => ({
        id: s.id,
        title: `第${s.id}步 ${s.title}`,
        output: isReportStep ? compactForFinalReport(get().artifacts[s.id]) : get().artifacts[s.id]
      }))
      if (isReportStep) {
        get()._post('assistant', '⏳ 正在整合成稿…', 'narration')
        const res = await runFinalReportInParts({
          cleanedData: cleanedSummaryOnly(cleanedData),
          priorOutputs,
          feedback: get().steering,
          setAbort: (fn) => set({ abortFn: fn }),
          onProgress: (text) => set({ reportMarkdown: text }),
          onRetry: (partLabel, n) => get()._post('assistant', `成稿「${partLabel}」连接中断，重试第 ${n} 次…`, 'narration')
        })
        if (!res.ok) {
          get()._post('assistant', `⚠️ 成稿中断：${res.error}。修好后点「确认，继续分析」可继续。`, 'error')
          set({ phase: 'checkpoint1' })
          return
        }
        set((s) => ({ artifacts: { ...s.artifacts, [REPORT_STEP_ID]: res.text }, reportMarkdown: res.text }))
      } else {
        const messages = buildStepMessages({
          stepId: step.id,
          stepTitle: step.title,
          sopRules,
          cleanedData,
          priorOutputs,
          feedback: get().steering
        })
        get()._post('assistant', `⏳ 正在：${step.title}…`, 'narration')
        const res = await runModelRetry(
          messages,
          () => {},
          (fn) => set({ abortFn: fn }),
          (n) => get()._post('assistant', `${step.title}连接中断，重试第 ${n} 次…`, 'narration')
        )
        if (!res.ok) {
          get()._post('assistant', `⚠️ ${step.title}中断：${res.error}。修好后点「确认，继续分析」可继续（已完成的步骤会跳过）。`, 'error')
          set({ phase: 'checkpoint1' })
          return
        }
        set((s) => ({ artifacts: { ...s.artifacts, [step.id]: res.text } }))
        get()._post('assistant', `✅ ${step.title} 完成`, 'narration')
      }
    }
    set({ phase: 'checkpoint2' })
    get()._post(
      'assistant',
      '✅ 报告初稿已生成（右侧）。需要改哪里直接说（如：经营建议再具体、第 9 步选题加几条），或点「确认定稿」。',
      'checkpoint'
    )
  },

  _rerunReport: async () => {
    const { sopRules, cleanedData, steering, artifacts } = get()
    set({ phase: 'analyzing' })
    const priorOutputs = SOP_STEPS.filter((s) => s.id < REPORT_STEP_ID && artifacts[s.id]).map((s) => ({
      id: s.id,
      title: `第${s.id}步 ${s.title}`,
      output: compactForFinalReport(artifacts[s.id])
    }))
    const res = await runFinalReportInParts({
      cleanedData: cleanedSummaryOnly(cleanedData),
      priorOutputs,
      feedback: steering,
      setAbort: (fn) => set({ abortFn: fn }),
      onProgress: (text) => set({ reportMarkdown: text }),
      onRetry: (partLabel, n) => get()._post('assistant', `修订成稿「${partLabel}」连接中断，重试第 ${n} 次…`, 'narration')
    })
    if (!res.ok) {
      get()._post('assistant', `⚠️ 修订中断：${res.error}`, 'error')
      set({ phase: 'checkpoint2' })
      return
    }
    set((s) => ({ artifacts: { ...s.artifacts, [REPORT_STEP_ID]: res.text }, reportMarkdown: res.text, phase: 'checkpoint2' }))
    get()._post('assistant', '✅ 已按你的要求修订报告。还要改继续说，或点「确认定稿」。', 'checkpoint')
  },

  confirmCheckpoint: async () => {
    const phase = get().phase
    if (phase === 'checkpoint1') await get()._runAnalysis()
    else if (phase === 'checkpoint2') {
      set({ phase: 'done' })
      get()._post('assistant', '✅ 报告已定稿，可在右侧导出 HTML / Markdown / Word。', 'narration')
    }
  },

  sendMessage: async (text) => {
    const t = text.trim()
    if (!t) return
    const phase = get().phase
    get()._post('user', t)

    if (phase === 'cleaning' || phase === 'analyzing') {
      set((s) => ({ steering: (s.steering ? s.steering + '\n' : '') + t }))
      get()._post('assistant', '收到，我会在后续步骤里按这个调整。', 'narration')
      return
    }
    if (phase === 'checkpoint1') {
      set((s) => ({ steering: (s.steering ? s.steering + '\n' : '') + t }))
      get()._post('assistant', '好的，按你的要求重新清洗归一……', 'narration')
      await get()._runCleaning(true)
      return
    }
    if (phase === 'checkpoint2' || phase === 'done') {
      set((s) => ({ steering: (s.steering ? s.steering + '\n' : '') + t }))
      get()._post('assistant', '好的，按你的要求修订报告……', 'narration')
      await get()._rerunReport()
      return
    }
    get()._post('assistant', '先上传资料并点「开始生成」。生成过程中你可以随时打字纠偏方向。', 'narration')
  },

  abort: () => {
    get().abortFn?.()
  },

  exportReport: async (format) => {
    const md = get().reportMarkdown
    if (!md.trim()) {
      set({ exportStatus: '还没有报告可导出。' })
      return
    }
    set({ exportStatus: '导出中…' })
    const name = defaultReportName(format)
    const res =
      format === 'html'
        ? await window.api.exportHtml(md, name)
        : format === 'md'
          ? await window.api.exportMarkdown(md, name)
          : await window.api.exportDocx(md, name)
    if (res.ok) set({ exportStatus: `已导出：${res.path}` })
    else if (res.canceled) set({ exportStatus: '' })
    else set({ exportStatus: `导出失败：${res.error || '未知错误'}` })
  }
}))
