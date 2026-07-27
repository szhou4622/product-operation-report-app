import { app } from 'electron'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { copyFile, rename, rm, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import type {
  ProjectCleanDetailSnapshot,
  ProjectMessageSnapshot,
  ProjectPhase,
  ProjectSourceSnapshot,
  SavedProject
} from '../shared/types'

type PlainRecord = Record<string, unknown>

const PROJECT_FILE_NAME = 'last-project.json'
const PROJECT_PHASES = new Set<ProjectPhase>([
  'idle',
  'cleaning',
  'checkpoint1',
  'analyzing',
  'checkpoint2',
  'done'
])
const SOURCE_KINDS = new Set<ProjectSourceSnapshot['kind']>(['image', 'doc', 'table', 'other'])
const MESSAGE_ROLES = new Set<ProjectMessageSnapshot['role']>(['user', 'assistant'])
const MESSAGE_KINDS = new Set<NonNullable<ProjectMessageSnapshot['kind']>>([
  'narration',
  'checkpoint',
  'report-block',
  'error'
])
const MAX_PROJECT_FILE_BYTES = 200 * 1024 * 1024

function projectPath(): string {
  return join(app.getPath('userData'), PROJECT_FILE_NAME)
}

function backupPath(): string {
  return `${projectPath()}.bak`
}

function previousProjectPath(): string {
  return join(app.getPath('userData'), 'previous-project.json')
}

function isPlainObject(value: unknown): value is PlainRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function sanitizeRevision(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function sanitizePhase(value: unknown): ProjectPhase {
  return typeof value === 'string' && PROJECT_PHASES.has(value as ProjectPhase)
    ? (value as ProjectPhase)
    : 'idle'
}

function sanitizeSource(value: unknown): ProjectSourceSnapshot | null {
  if (!isPlainObject(value)) return null
  const kind = SOURCE_KINDS.has(value.kind as ProjectSourceSnapshot['kind'])
    ? (value.kind as ProjectSourceSnapshot['kind'])
    : 'other'

  return {
    id: asString(value.id),
    name: asString(value.name),
    kind,
    text: optionalString(value.text),
    dataUrl: optionalString(value.dataUrl),
    error: optionalString(value.error),
    attribution: optionalString(value.attribution),
    platform: optionalString(value.platform),
    purpose: optionalString(value.purpose),
    note: optionalString(value.note),
    size: optionalNumber(value.size)
  }
}

function sanitizeMessage(value: unknown): ProjectMessageSnapshot | null {
  if (!isPlainObject(value)) return null
  if (!MESSAGE_ROLES.has(value.role as ProjectMessageSnapshot['role'])) return null

  const message: ProjectMessageSnapshot = {
    id: asString(value.id),
    role: value.role as ProjectMessageSnapshot['role'],
    text: asString(value.text)
  }
  if (MESSAGE_KINDS.has(value.kind as NonNullable<ProjectMessageSnapshot['kind']>)) {
    message.kind = value.kind as NonNullable<ProjectMessageSnapshot['kind']>
  }
  return message
}

function sanitizeCleanDetail(value: unknown): ProjectCleanDetailSnapshot | null {
  if (!isPlainObject(value)) return null
  return {
    id: asString(value.id),
    name: asString(value.name),
    text: asString(value.text)
  }
}

function sanitizeArtifactRecord(value: unknown): Record<number, string> {
  if (!isPlainObject(value)) return {}
  const result: Record<number, string> = {}
  for (const [key, text] of Object.entries(value)) {
    const id = Number(key)
    if (Number.isInteger(id) && typeof text === 'string') {
      result[id] = text
    }
  }
  return result
}

function sanitizeProject(value: unknown): SavedProject {
  const input = isPlainObject(value) ? value : {}
  return {
    revision: sanitizeRevision(input.revision),
    sources: Array.isArray(input.sources)
      ? input.sources
          .map((source) => sanitizeSource(source))
          .filter((source): source is ProjectSourceSnapshot => Boolean(source))
      : [],
    messages: Array.isArray(input.messages)
      ? input.messages
          .map((message) => sanitizeMessage(message))
          .filter((message): message is ProjectMessageSnapshot => Boolean(message))
      : [],
    cleanedData: asString(input.cleanedData),
    cleanDetails: Array.isArray(input.cleanDetails)
      ? input.cleanDetails
          .map((detail) => sanitizeCleanDetail(detail))
          .filter((detail): detail is ProjectCleanDetailSnapshot => Boolean(detail))
      : [],
    artifacts: sanitizeArtifactRecord(input.artifacts),
    reportMarkdown: asString(input.reportMarkdown),
    reportStale: Boolean(input.reportStale),
    phase: sanitizePhase(input.phase),
    steering: asString(input.steering),
    updatedAt: optionalString(input.updatedAt) || new Date().toISOString()
  }
}

function hasProjectShape(value: unknown): value is PlainRecord {
  if (!isPlainObject(value)) return false
  return (
    Array.isArray(value.sources) &&
    Array.isArray(value.messages) &&
    isPlainObject(value.artifacts) &&
    typeof value.cleanedData === 'string' &&
    typeof value.reportMarkdown === 'string' &&
    typeof value.steering === 'string' &&
    typeof value.phase === 'string' &&
    PROJECT_PHASES.has(value.phase as ProjectPhase)
  )
}

function loadProjectFile(file: string): SavedProject | null {
  if (!existsSync(file)) return null

  try {
    if (statSync(file).size > MAX_PROJECT_FILE_BYTES) return null
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    return hasProjectShape(parsed) ? sanitizeProject(parsed) : null
  } catch {
    return null
  }
}

export function loadLastProject(): SavedProject | null {
  const candidates = [loadProjectFile(projectPath()), loadProjectFile(backupPath())].filter(
    (project): project is SavedProject => Boolean(project)
  )
  candidates.sort((a, b) => {
    if (a.revision !== b.revision) return b.revision - a.revision
    return Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
  })
  return candidates[0] ?? null
}

export function loadPreviousProject(): SavedProject | null {
  return loadProjectFile(previousProjectPath())
}

let saveQueue: Promise<void> = Promise.resolve()

function serializedProject(snapshot: SavedProject): string {
  const serialized = JSON.stringify(snapshot, null, 2)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PROJECT_FILE_BYTES) {
    throw new Error('当前资料过多，项目无法安全保存。请删除部分大图片或拆成两份分析后重试。')
  }
  return serialized
}

function currentIsNewer(current: SavedProject | null, snapshot: SavedProject): current is SavedProject {
  if (!current) return false
  if (current.revision !== snapshot.revision) return current.revision > snapshot.revision
  return Date.parse(current.updatedAt) > Date.parse(snapshot.updatedAt)
}

async function refreshBackupAtomically(file: string, backup: string): Promise<void> {
  const backupTemp = `${backup}.tmp-${process.pid}-${Date.now()}`
  try {
    await copyFile(file, backupTemp)
    await rename(backupTemp, backup)
  } finally {
    if (existsSync(backupTemp)) await rm(backupTemp, { force: true })
  }
}

async function writeProjectSnapshot(snapshot: SavedProject): Promise<SavedProject> {
  const file = projectPath()
  const backup = backupPath()
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`
  mkdirSync(dirname(file), { recursive: true })
  const serialized = serializedProject(snapshot)

  const current = loadProjectFile(file) ?? loadProjectFile(backup)
  if (currentIsNewer(current, snapshot)) return current

  try {
    await writeFile(temp, serialized, 'utf8')
    const latest = loadProjectFile(file) ?? loadProjectFile(backup)
    if (currentIsNewer(latest, snapshot)) return latest
    await rename(temp, file)
    try {
      await refreshBackupAtomically(file, backup)
    } catch {
      // 保留旧备份；主文件已经原子写入成功
    }
  } finally {
    if (existsSync(temp)) await rm(temp, { force: true })
  }
  return snapshot
}

export function saveLastProject(project: SavedProject): Promise<SavedProject> {
  const snapshot = sanitizeProject(project)
  const task = saveQueue.then(() => writeProjectSnapshot(snapshot))
  saveQueue = task.then(
    () => undefined,
    () => undefined
  )
  return task
}

export function saveLastProjectSync(project: SavedProject): SavedProject {
  const snapshot = sanitizeProject(project)
  const serialized = serializedProject(snapshot)
  const file = projectPath()
  const backup = backupPath()
  const temp = `${file}.sync-${process.pid}-${Date.now()}`
  const backupTemp = `${backup}.sync-${process.pid}-${Date.now()}`
  mkdirSync(dirname(file), { recursive: true })
  const current = loadProjectFile(file) ?? loadProjectFile(backup)
  if (currentIsNewer(current, snapshot)) return current

  try {
    writeFileSync(temp, serialized, 'utf8')
    renameSync(temp, file)
    try {
      copyFileSync(file, backupTemp)
      renameSync(backupTemp, backup)
    } catch {
      if (existsSync(backupTemp)) rmSync(backupTemp, { force: true })
    }
    return snapshot
  } finally {
    if (existsSync(temp)) rmSync(temp, { force: true })
    if (existsSync(backupTemp)) rmSync(backupTemp, { force: true })
  }
}

export function archiveProject(project: SavedProject): Promise<SavedProject> {
  const snapshot = sanitizeProject(project)
  serializedProject(snapshot)
  const task = saveQueue.then(async () => {
    const file = previousProjectPath()
    const temp = `${file}.tmp`
    mkdirSync(dirname(file), { recursive: true })
    try {
      await writeFile(temp, JSON.stringify(snapshot, null, 2), 'utf8')
      await rename(temp, file)
    } finally {
      if (existsSync(temp)) await rm(temp, { force: true })
    }
    return snapshot
  })
  saveQueue = task.then(
    () => undefined,
    () => undefined
  )
  return task
}
