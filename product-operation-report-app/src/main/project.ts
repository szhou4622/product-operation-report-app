import { app } from 'electron'
import { createHash } from 'crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync
} from 'fs'
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import type {
  CleaningCoverage,
  ProjectCleanDetailSnapshot,
  ProjectMessageSnapshot,
  ProjectPhase,
  ProjectStoragePreflight,
  ProjectSourceSnapshot,
  ProjectTaskSnapshot,
  SavedProject,
  ModuleKey,
  ModuleRunState,
  SourceKindV1
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
const MAX_PROJECT_MANIFEST_BYTES = 24 * 1024 * 1024
const EXTERNAL_STRING_THRESHOLD = 64 * 1024
const PROJECT_STORAGE_VERSION = 2

interface ProjectBlobRef {
  $blob: string
  bytes: number
}

interface StoredProjectV2 extends PlainRecord {
  storageVersion: 2
  project: unknown
}

interface ProjectMetadata {
  revision: number
  updatedAt: string
}

const blobReferenceCache = new Map<string, { value: string; ref: ProjectBlobRef }>()

function projectPath(): string {
  return join(app.getPath('userData'), PROJECT_FILE_NAME)
}

function backupPath(): string {
  return `${projectPath()}.bak`
}

function previousProjectPath(): string {
  return join(app.getPath('userData'), 'previous-project.json')
}

function blobDirectory(): string {
  return join(app.getPath('userData'), 'project-data', 'blobs')
}

function blobPath(hash: string): string {
  return join(blobDirectory(), `${hash}.txt`)
}

function isBlobRef(value: unknown): value is ProjectBlobRef {
  if (!isPlainObject(value)) return false
  return typeof value.$blob === 'string' && /^[a-f0-9]{64}$/u.test(value.$blob) &&
    typeof value.bytes === 'number' && Number.isSafeInteger(value.bytes) && value.bytes >= 0
}

function stringBlobRef(value: string): ProjectBlobRef {
  return {
    $blob: createHash('sha256').update(value, 'utf8').digest('hex'),
    bytes: Buffer.byteLength(value, 'utf8')
  }
}

async function storeStringBlob(value: string, cacheKey: string, usedKeys: Set<string>): Promise<ProjectBlobRef> {
  usedKeys.add(cacheKey)
  const cached = blobReferenceCache.get(cacheKey)
  const ref = cached?.value === value ? cached.ref : stringBlobRef(value)
  const file = blobPath(ref.$blob)
  if (!existsSync(file)) {
    await mkdir(blobDirectory(), { recursive: true })
    const temp = `${file}.tmp-${process.pid}-${Date.now()}`
    try {
      await writeFile(temp, value, { encoding: 'utf8', mode: 0o600 })
      try {
        await rename(temp, file)
      } catch (error) {
        if (!existsSync(file)) throw error
      }
    } finally {
      if (existsSync(temp)) await rm(temp, { force: true })
    }
  }
  blobReferenceCache.set(cacheKey, { value, ref })
  return ref
}

function storeStringBlobSync(value: string, cacheKey: string, usedKeys: Set<string>): ProjectBlobRef {
  usedKeys.add(cacheKey)
  const cached = blobReferenceCache.get(cacheKey)
  const ref = cached?.value === value ? cached.ref : stringBlobRef(value)
  const file = blobPath(ref.$blob)
  if (!existsSync(file)) {
    mkdirSync(blobDirectory(), { recursive: true })
    const temp = `${file}.sync-${process.pid}-${Date.now()}`
    try {
      writeFileSync(temp, value, { encoding: 'utf8', mode: 0o600 })
      try {
        renameSync(temp, file)
      } catch (error) {
        if (!existsSync(file)) throw error
      }
    } finally {
      if (existsSync(temp)) rmSync(temp, { force: true })
    }
  }
  blobReferenceCache.set(cacheKey, { value, ref })
  return ref
}

function childCacheKey(parent: string, key: string | number, value: unknown): string {
  if (isPlainObject(value) && typeof value.id === 'string' && value.id) return `${parent}/${key}:${value.id}`
  return `${parent}/${key}`
}

async function externalizeValue(value: unknown, path: string, usedKeys: Set<string>): Promise<unknown> {
  if (typeof value === 'string') {
    return Buffer.byteLength(value, 'utf8') >= EXTERNAL_STRING_THRESHOLD
      ? storeStringBlob(value, path, usedKeys)
      : value
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map((item, index) => externalizeValue(item, childCacheKey(path, index, item), usedKeys)))
  }
  if (isPlainObject(value)) {
    const entries = await Promise.all(Object.entries(value).map(async ([key, item]) => [
      key,
      await externalizeValue(item, childCacheKey(path, key, item), usedKeys)
    ] as const))
    return Object.fromEntries(entries)
  }
  return value
}

function externalizeValueSync(value: unknown, path: string, usedKeys: Set<string>): unknown {
  if (typeof value === 'string') {
    return Buffer.byteLength(value, 'utf8') >= EXTERNAL_STRING_THRESHOLD
      ? storeStringBlobSync(value, path, usedKeys)
      : value
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => externalizeValueSync(item, childCacheKey(path, index, item), usedKeys))
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      externalizeValueSync(item, childCacheKey(path, key, item), usedKeys)
    ]))
  }
  return value
}

async function hydrateValueAsync(value: unknown, missing: string[], path = 'project'): Promise<unknown> {
  if (isBlobRef(value)) {
    const file = blobPath(value.$blob)
    try {
      const info = await stat(file)
      if (info.size !== value.bytes) throw new Error('size mismatch')
      return await readFile(file, 'utf8')
    } catch {
      missing.push(path)
      return '[资料块丢失，请重新上传该文件]'
    }
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map((item, index) => hydrateValueAsync(item, missing, `${path}.${index}`)))
  }
  if (isPlainObject(value)) {
    const entries = await Promise.all(Object.entries(value).map(async ([key, item]) => [
      key,
      await hydrateValueAsync(item, missing, `${path}.${key}`)
    ] as const))
    return Object.fromEntries(entries)
  }
  return value
}

function pruneBlobReferenceCache(usedKeys: Set<string>): void {
  for (const key of blobReferenceCache.keys()) {
    if (!usedKeys.has(key)) blobReferenceCache.delete(key)
  }
}

async function storedProject(snapshot: SavedProject): Promise<StoredProjectV2> {
  const usedKeys = new Set<string>()
  const project = await externalizeValue(snapshot, 'project', usedKeys)
  pruneBlobReferenceCache(usedKeys)
  return { storageVersion: PROJECT_STORAGE_VERSION, project }
}

function storedProjectSync(snapshot: SavedProject): StoredProjectV2 {
  const usedKeys = new Set<string>()
  const project = externalizeValueSync(snapshot, 'project', usedKeys)
  pruneBlobReferenceCache(usedKeys)
  return { storageVersion: PROJECT_STORAGE_VERSION, project }
}

function serializeManifest(value: StoredProjectV2): string {
  const serialized = JSON.stringify(value, null, 2)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PROJECT_MANIFEST_BYTES) {
    throw new Error('项目索引过大，无法安全保存。请把资料拆成两份分析后重试。')
  }
  return serialized
}

function estimatedSnapshotBytes(value: unknown): number {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8')
  if (typeof value === 'number' || typeof value === 'boolean') return 16
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + estimatedSnapshotBytes(item), 0)
  if (isPlainObject(value)) {
    return Object.entries(value).reduce(
      (sum, [key, item]) => sum + Buffer.byteLength(key, 'utf8') + estimatedSnapshotBytes(item),
      0
    )
  }
  return 0
}

export function preflightProjectStorage(project: SavedProject): ProjectStoragePreflight {
  const snapshot = sanitizeProject(project)
  const estimatedBytes = estimatedSnapshotBytes(snapshot)
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    const stats = statfsSync(app.getPath('userData'))
    const availableBytes = Number(stats.bavail) * Number(stats.bsize)
    const safetyReserve = Math.max(256 * 1024 * 1024, Math.ceil(estimatedBytes * 0.35))
    const ok = Number.isFinite(availableBytes) && availableBytes >= estimatedBytes + safetyReserve
    return {
      ok,
      message: ok
        ? '项目可以安全保存和恢复。'
        : '当前磁盘剩余空间不足以安全保存这批资料。请先清理磁盘空间，避免分析完成后无法恢复。',
      estimatedBytes,
      availableBytes
    }
  } catch {
    return {
      ok: estimatedBytes <= 512 * 1024 * 1024,
      message: estimatedBytes <= 512 * 1024 * 1024
        ? '项目容量检查完成。'
        : '无法确认磁盘剩余空间，且本次资料较大。请先确保磁盘至少有1GB可用空间。',
      estimatedBytes
    }
  }
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
    attachments: Array.isArray(value.attachments)
      ? value.attachments.flatMap((item) => {
          if (!isPlainObject(item)) return []
          const name = asString(item.name)
          const dataUrl = optionalString(item.dataUrl)
          const error = optionalString(item.error)
          if (!name || (!dataUrl && !error)) return []
          return [{ name, dataUrl, error, size: optionalNumber(item.size) }]
        }).slice(0, 100)
      : undefined,
    error: optionalString(value.error),
    warning: optionalString(value.warning),
    attribution: optionalString(value.attribution),
    platform: optionalString(value.platform),
    purpose: optionalString(value.purpose),
    kindV1: ['product-supply', 'business-data', 'material-data', 'audience-data', 'voice-data'].includes(asString(value.kindV1))
      ? value.kindV1 as SourceKindV1
      : undefined,
    note: optionalString(value.note),
    size: optionalNumber(value.size),
    topLevelId: optionalString(value.topLevelId),
    derivedKind: ['archive-entry', 'embedded-image', 'rendered-page', 'converted-page'].includes(asString(value.derivedKind))
      ? value.derivedKind as ProjectSourceSnapshot['derivedKind']
      : undefined
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

function sanitizeCleaningCoverage(value: unknown): CleaningCoverage | undefined {
  if (!isPlainObject(value) || (value.mode !== 'local_exact' && value.mode !== 'model_batches')) return undefined
  const nonnegative = (input: unknown): number | undefined =>
    typeof input === 'number' && Number.isSafeInteger(input) && input >= 0 ? input : undefined
  const batchCount = nonnegative(value.batchCount)
  if (batchCount === undefined) return undefined
  return {
    mode: value.mode,
    recordCount: nonnegative(value.recordCount),
    pageCount: nonnegative(value.pageCount),
    imageCount: nonnegative(value.imageCount),
    batchCount,
    verifiedAt: optionalString(value.verifiedAt) || new Date().toISOString()
  }
}

function sanitizeCleanDetail(value: unknown): ProjectCleanDetailSnapshot | null {
  if (!isPlainObject(value)) return null
  return {
    id: asString(value.id),
    name: asString(value.name),
    text: asString(value.text),
    coverage: sanitizeCleaningCoverage(value.coverage)
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

function sanitizeTaskJournal(value: unknown): Record<string, ProjectTaskSnapshot> {
  if (!isPlainObject(value)) return {}
  const allowedKinds = new Set<ProjectTaskSnapshot['kind']>(['parse', 'source_clean', 'summary', 'analysis_step', 'final_part', 'module'])
  const allowedStatuses = new Set<ProjectTaskSnapshot['status']>(['complete', 'failed', 'interrupted'])
  const result: Record<string, ProjectTaskSnapshot> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (!/^[\w.:@/+-]{1,300}$/u.test(key) || !isPlainObject(raw)) continue
    if (!allowedKinds.has(raw.kind as ProjectTaskSnapshot['kind'])) continue
    if (!allowedStatuses.has(raw.status as ProjectTaskSnapshot['status'])) continue
    result[key] = {
      kind: raw.kind as ProjectTaskSnapshot['kind'],
      status: raw.status as ProjectTaskSnapshot['status'],
      output: optionalString(raw.output),
      coverage: sanitizeCleaningCoverage(raw.coverage),
      inputFingerprint: optionalString(raw.inputFingerprint),
      updatedAt: optionalString(raw.updatedAt) || new Date().toISOString()
    }
  }
  return result
}

function sanitizeModuleStates(value: unknown): Partial<Record<ModuleKey, ModuleRunState>> {
  if (!isPlainObject(value)) return {}
  const keys = new Set<ModuleKey>([
    'product-info', 'platform-audience', 'material-review', 'benchmark-brands',
    'selling-points', 'voc', 'selling-point-ranking', 'audience-sp-scene'
  ])
  const statuses = new Set<ModuleRunState['status']>(['pending', 'running', 'done', 'failed', 'skipped'])
  const result: Partial<Record<ModuleKey, ModuleRunState>> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (!keys.has(key as ModuleKey) || !isPlainObject(raw) || !statuses.has(raw.status as ModuleRunState['status'])) continue
    result[key as ModuleKey] = {
      status: raw.status as ModuleRunState['status'],
      message: optionalString(raw.message),
      updatedAt: optionalString(raw.updatedAt) || new Date().toISOString()
    }
  }
  return result
}

function sanitizeProject(value: unknown): SavedProject {
  const input = isPlainObject(value) ? value : {}
  return {
    revision: sanitizeRevision(input.revision),
    analysisSessionId: typeof input.analysisSessionId === 'string' && /^[\w.:@/+-]{1,240}$/u.test(input.analysisSessionId)
      ? input.analysisSessionId
      : undefined,
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
    taskJournal: sanitizeTaskJournal(input.taskJournal),
    reportMarkdown: asString(input.reportMarkdown),
    reportStale: Boolean(input.reportStale),
    phase: sanitizePhase(input.phase),
    steering: asString(input.steering),
    updatedAt: optionalString(input.updatedAt) || new Date().toISOString(),
    missingBlobs: Array.isArray(input.missingBlobs)
      ? input.missingBlobs.filter((item): item is string => typeof item === 'string').slice(0, 200)
      : undefined,
    engineVersion: input.engineVersion === 'v1' || input.engineVersion === 'v2' ? input.engineVersion : undefined,
    legacyEngineVersion: input.legacyEngineVersion === 'v1' ? 'v1' : undefined,
    legacyArtifacts: sanitizeArtifactRecord(input.legacyArtifacts),
    legacyModuleStates: sanitizeModuleStates(input.legacyModuleStates),
    legacyReportMarkdown: optionalString(input.legacyReportMarkdown),
    legacyBenchmarkAppendix: optionalString(input.legacyBenchmarkAppendix),
    readOnly: Boolean(input.readOnly),
    legacyNotice: optionalString(input.legacyNotice),
    moduleStates: sanitizeModuleStates(input.moduleStates)
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

function projectRoot(value: unknown): unknown {
  return isPlainObject(value) && value.storageVersion === PROJECT_STORAGE_VERSION && 'project' in value
    ? value.project
    : value
}

function collectBlobHashes(value: unknown, hashes: Set<string>): void {
  if (isBlobRef(value)) {
    hashes.add(value.$blob)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectBlobHashes(item, hashes)
    return
  }
  if (isPlainObject(value)) {
    for (const item of Object.values(value)) collectBlobHashes(item, hashes)
  }
}

async function manifestBlobHashes(file: string): Promise<Set<string> | null> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown
    if (!isPlainObject(parsed) || parsed.storageVersion !== PROJECT_STORAGE_VERSION || !('project' in parsed)) return null
    const hashes = new Set<string>()
    collectBlobHashes(parsed.project, hashes)
    return hashes
  } catch {
    return null
  }
}

export async function pruneOrphanBlobs(): Promise<{ skipped: boolean; deleted: number }> {
  const [last, previous] = await Promise.all([
    manifestBlobHashes(projectPath()),
    manifestBlobHashes(previousProjectPath())
  ])
  if (!last || !previous) return { skipped: true, deleted: 0 }
  const referenced = new Set([...last, ...previous])
  let entries
  try {
    entries = await readdir(blobDirectory(), { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { skipped: false, deleted: 0 }
    return { skipped: true, deleted: 0 }
  }
  let deleted = 0
  for (const entry of entries) {
    const match = /^([a-f0-9]{64})\.txt$/u.exec(entry.name)
    if (!entry.isFile() || !match || referenced.has(match[1])) continue
    await rm(join(blobDirectory(), entry.name), { force: true })
    deleted += 1
  }
  return { skipped: false, deleted }
}

function metadataFromParsed(value: unknown): ProjectMetadata | null {
  const root = projectRoot(value)
  if (!isPlainObject(root)) return null
  const revision = typeof root.revision === 'number' && Number.isSafeInteger(root.revision) && root.revision >= 0
    ? root.revision
    : 0
  const updatedAt = typeof root.updatedAt === 'string' ? root.updatedAt : ''
  return { revision, updatedAt }
}

function loadProjectMetadataSync(file: string): ProjectMetadata | null {
  if (!existsSync(file)) return null

  try {
    if (statSync(file).size > MAX_PROJECT_FILE_BYTES) return null
    return metadataFromParsed(JSON.parse(readFileSync(file, 'utf8')) as unknown)
  } catch {
    return null
  }
}

async function loadProjectMetadata(file: string): Promise<ProjectMetadata | null> {
  try {
    const info = await stat(file)
    if (info.size > MAX_PROJECT_FILE_BYTES) return null
    return metadataFromParsed(JSON.parse(await readFile(file, 'utf8')) as unknown)
  } catch {
    return null
  }
}

async function loadProjectFile(file: string): Promise<SavedProject | null> {
  try {
    const info = await stat(file)
    if (info.size > MAX_PROJECT_FILE_BYTES) return null
    const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown
    const root = projectRoot(parsed)
    const missing: string[] = []
    const hydrated = isPlainObject(parsed) && parsed.storageVersion === PROJECT_STORAGE_VERSION
      ? await hydrateValueAsync(root, missing)
      : root
    if (!hasProjectShape(hydrated)) return null
    const project = sanitizeProject(hydrated)
    if (missing.length) {
      project.missingBlobs = Array.from(new Set(missing.map((path) => {
        const match = /^project\.sources\.(\d+)\./u.exec(path)
        if (!match) return path
        return project.sources[Number(match[1])]?.name || path
      })))
    }
    return project
  } catch {
    return null
  }
}

export async function loadLastProject(): Promise<SavedProject | null> {
  const candidates = (await Promise.all([loadProjectFile(projectPath()), loadProjectFile(backupPath())])).filter(
    (project): project is SavedProject => Boolean(project)
  )
  candidates.sort((a, b) => {
    if (a.revision !== b.revision) return b.revision - a.revision
    return Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
  })
  return candidates[0] ?? null
}

export function loadPreviousProject(): Promise<SavedProject | null> {
  return loadProjectFile(previousProjectPath())
}

let saveQueue: Promise<void> = Promise.resolve()

function currentIsNewer(current: ProjectMetadata | null, snapshot: SavedProject): boolean {
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
  const serialized = serializeManifest(await storedProject(snapshot))

  const current = (await loadProjectMetadata(file)) ?? (await loadProjectMetadata(backup))
  if (currentIsNewer(current, snapshot)) return snapshot

  try {
    await writeFile(temp, serialized, 'utf8')
    const latest = (await loadProjectMetadata(file)) ?? (await loadProjectMetadata(backup))
    if (currentIsNewer(latest, snapshot)) return snapshot
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
  const serialized = serializeManifest(storedProjectSync(snapshot))
  const file = projectPath()
  const backup = backupPath()
  const temp = `${file}.sync-${process.pid}-${Date.now()}`
  const backupTemp = `${backup}.sync-${process.pid}-${Date.now()}`
  mkdirSync(dirname(file), { recursive: true })
  const current = loadProjectMetadataSync(file) ?? loadProjectMetadataSync(backup)
  if (currentIsNewer(current, snapshot)) return snapshot

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
  const task = saveQueue.then(async () => {
    const file = previousProjectPath()
    const temp = `${file}.tmp`
    mkdirSync(dirname(file), { recursive: true })
    try {
      await writeFile(temp, serializeManifest(await storedProject(snapshot)), 'utf8')
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
