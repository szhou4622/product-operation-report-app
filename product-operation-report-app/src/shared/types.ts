// 在主进程与渲染进程之间共享的类型定义

/** 单个模型配置（OpenAI 兼容） */
export interface ModelProfile {
  id: string
  name: string // 给用户看的名字，如 "GPT-5.5"
  baseURL: string // 如 https://api.openai.com/v1
  apiKey: string // 落盘时由 safeStorage 加密
  model: string // 模型名
  supportsVision: boolean // 是否支持读图（多模态）
  temperature?: number
}

/** 应用设置 */
export interface AppSettings {
  profiles: ModelProfile[]
  activeProfileId: string | null
  projectsDir: string // 报告工程默认保存目录
  privacyAccepted: boolean // 是否已确认“资料会发送到当前模型服务商”
}

/** 聊天消息内容块 */
export interface ActivationStatus {
  activated: boolean
  deviceId: string
  activatedAt?: string
  licenseId?: string
  codeCount: number
}

export interface ActivationResult {
  ok: boolean
  message: string
  status: ActivationStatus
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; dataUrl: string } // data:image/png;base64,...

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ContentPart[]
}

export type ProjectPhase = 'idle' | 'cleaning' | 'checkpoint1' | 'analyzing' | 'checkpoint2' | 'done'

export interface ProjectSourceSnapshot {
  id: string
  name: string
  kind: 'image' | 'doc' | 'table' | 'other'
  text?: string
  dataUrl?: string
  error?: string
  attribution?: string
  platform?: string
  purpose?: string
  note?: string
  size?: number
}

export interface ProjectMessageSnapshot {
  id: string
  role: 'user' | 'assistant'
  text: string
  kind?: 'narration' | 'checkpoint' | 'report-block' | 'error'
}

export interface ProjectCleanDetailSnapshot {
  id: string
  name: string
  text: string
}

export interface SavedProject {
  sources: ProjectSourceSnapshot[]
  messages: ProjectMessageSnapshot[]
  cleanedData: string
  cleanDetails: ProjectCleanDetailSnapshot[]
  artifacts: Record<number, string>
  reportMarkdown: string
  phase: ProjectPhase
  steering: string
  updatedAt: string
}

/** 测试连通的入参/结果 */
export interface TestModelOptions {
  profile: ModelProfile
  withImageDataUrl?: string // 传入则测试多模态读图
}

export interface TestModelResult {
  ok: boolean
  message: string // 成功时返回模型回复摘要，失败时返回错误
  latencyMs?: number
}

/** 拉取模型列表结果 */
export interface ModelListResult {
  ok: boolean
  models?: string[]
  error?: string
}

/** 压缩包/文件夹展开后的单个条目 */
export interface ArchiveItem {
  name: string
  kind: 'image' | 'doc' | 'table' | 'other'
  text?: string
  dataUrl?: string // 图片
  ok: boolean
  error?: string
}

/** 报告导出结果 */
export interface ExportResult {
  ok: boolean
  path?: string
  canceled?: boolean
  error?: string
}

/** 文件解析结果（PDF/Word/Markdown/CSV/XLSX 抽取） */
export interface ParsedFile {
  name: string
  kind: 'table' | 'doc' | 'other'
  text: string // 抽取出的文本（表格转 CSV）
  ok: boolean
  error?: string
}

/** 流式聊天事件（通过 IPC 推送到渲染层） */
export type ChatStreamEvent =
  | { type: 'chunk'; delta: string }
  | { type: 'done'; full: string }
  | { type: 'error'; message: string }

/** SOP 步骤定义（阶段一仅静态展示） */
export interface SopStep {
  id: number
  key: string
  title: string
  confirm: boolean // 是否为人工确认点
}

export const SOP_STEPS: SopStep[] = [
  { id: 1, key: 'product', title: '确定产品', confirm: true },
  { id: 2, key: 'own-sellingpoints', title: '12维产品卖点拆解', confirm: false },
  { id: 3, key: 'competitor-sellingpoints', title: '竞品卖点拆解', confirm: false },
  { id: 4, key: 'ranking', title: '卖点排序', confirm: true },
  { id: 5, key: 'audience', title: '核心人群画像', confirm: true },
  { id: 6, key: 'matrix', title: '内容矩阵', confirm: false },
  { id: 7, key: 'mainline', title: '3-5条视频号内容主线', confirm: true },
  { id: 8, key: 'execution', title: '执行选题表', confirm: true },
  { id: 9, key: 'report', title: '成稿', confirm: true }
]
