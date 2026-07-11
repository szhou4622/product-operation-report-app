import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
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

function projectPath(): string {
  return join(app.getPath('userData'), PROJECT_FILE_NAME)
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
    phase: sanitizePhase(input.phase),
    steering: asString(input.steering),
    updatedAt: optionalString(input.updatedAt) || new Date().toISOString()
  }
}

export function loadLastProject(): SavedProject | null {
  const file = projectPath()
  if (!existsSync(file)) return null

  try {
    return sanitizeProject(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return null
  }
}

export function saveLastProject(project: SavedProject): SavedProject {
  const snapshot = sanitizeProject(project)
  const file = projectPath()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(snapshot, null, 2), 'utf8')
  return snapshot
}
