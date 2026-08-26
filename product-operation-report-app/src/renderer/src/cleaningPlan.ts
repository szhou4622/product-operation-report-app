import type { SourceCleanCacheInput } from '../../shared/types'
import { buildSourceCleanBatchPlan } from './sourceCleanBatches'
import { preprocessTableForModel } from './tablePreprocess'

export type CleaningMethod = 'local_exact' | 'model_semantic' | 'model_vision' | 'unsupported'
export type CleaningJobStatus = 'waiting' | 'running' | 'complete' | 'failed' | 'not_started'

export interface CleaningJob {
  id: string
  sourceId: string
  method: Exclude<CleaningMethod, 'unsupported'>
  batchIndex: number
  batchCount: number
  inputChars: number
  imageCount: number
  status: CleaningJobStatus
}

export interface CleaningPlanEntry {
  sourceId: string
  sourceName: string
  method: CleaningMethod
  jobs: CleaningJob[]
  reason: string
  oversized: boolean
}

export interface CleaningPlan {
  entries: CleaningPlanEntry[]
  localFileCount: number
  modelFileCount: number
  unsupportedFileCount: number
  expectedModelJobs: number
  oversizedFiles: string[]
}

export interface CleaningPlanSource extends SourceCleanCacheInput {
  id: string
  error?: string
}

const SEMANTIC_HEADER = /评论|评价|反馈|用户声音|完整文案|脚本文案|口播文案|口播字幕|字幕|脚本|标题文案|素材文案|内容原文/iu
const AGGREGATED_METRIC_HEADER = /(?:率|数|量|金额|订单|人数|次数|占比|比例|得分|评分|星级|等级|均值|平均值|ID|编号)$/iu
const MAX_SILENT_MODEL_BATCHES = 20

function firstTableHeaders(text: string): string[] {
  const first = text.split(/\r?\n/u).find((line) => line.trim() && !/^###\s*工作表/u.test(line)) || ''
  const delimiter = first.includes('\t') ? '\t' : ','
  return first.split(delimiter).map((value) => value.replace(/^['"]|['"]$/gu, '').trim())
}

export function tableNeedsSemanticModel(text: string): boolean {
  const headers = firstTableHeaders(text)
  return headers.some((header) => SEMANTIC_HEADER.test(header) && !AGGREGATED_METRIC_HEADER.test(header))
}

function visionCount(source: CleaningPlanSource): number {
  return (source.dataUrl ? 1 : 0) + (source.attachments?.filter((item) => item.dataUrl).length || 0)
}

function modelEntry(source: CleaningPlanSource, method: 'model_semantic' | 'model_vision'): CleaningPlanEntry {
  const prepared = source.kind === 'table' && source.text
    ? { ...source, text: preprocessTableForModel(source.text).text }
    : source
  const plan = buildSourceCleanBatchPlan(prepared, { semanticSummary: method === 'model_semantic' && source.kind === 'table' })
  const jobs = plan.batches.map((batch) => ({
    id: `${source.id}:clean-v7:${batch.context.batchIndex}`,
    sourceId: source.id,
    method,
    batchIndex: batch.context.batchIndex,
    batchCount: batch.context.batchCount,
    inputChars: batch.source.text?.length || 0,
    imageCount: (batch.source.dataUrl ? 1 : 0) + (batch.source.attachments?.filter((item) => item.dataUrl).length || 0),
    status: 'waiting' as const
  }))
  return {
    sourceId: source.id,
    sourceName: source.name,
    method,
    jobs,
    reason: method === 'model_vision' ? '包含需要识别的图片或扫描页面' : '包含需要逐条理解的评论、文案或脚本',
    oversized: jobs.length > MAX_SILENT_MODEL_BATCHES
  }
}

export function buildCleaningPlan(sources: CleaningPlanSource[]): CleaningPlan {
  const entries = sources.map((source): CleaningPlanEntry => {
    if (source.error || (!source.text && !source.dataUrl && !source.attachments?.some((item) => item.dataUrl))) {
      return { sourceId: source.id, sourceName: source.name, method: 'unsupported', jobs: [], reason: source.error || '没有可读取内容', oversized: false }
    }
    if (source.kind === 'table' && source.text) {
      const local = preprocessTableForModel(source.text)
      if (local.canSkipModel && !tableNeedsSemanticModel(local.text)) {
        return {
          sourceId: source.id,
          sourceName: source.name,
          method: 'local_exact',
          jobs: [{ id: `${source.id}:local-exact`, sourceId: source.id, method: 'local_exact', batchIndex: 1, batchCount: 1, inputChars: local.text.length, imageCount: 0, status: 'waiting' }],
          reason: `本机可完整读取 ${local.retainedRows} 条结构化记录`,
          oversized: false
        }
      }
      return modelEntry(source, 'model_semantic')
    }
    if (source.kind === 'image' || source.dataUrl || visionCount(source) > 0) return modelEntry(source, 'model_vision')
    return modelEntry(source, 'model_semantic')
  })
  return {
    entries,
    localFileCount: entries.filter((entry) => entry.method === 'local_exact').length,
    modelFileCount: entries.filter((entry) => entry.method === 'model_semantic' || entry.method === 'model_vision').length,
    unsupportedFileCount: entries.filter((entry) => entry.method === 'unsupported').length,
    expectedModelJobs: entries.reduce((sum, entry) => sum + (entry.method.startsWith('model_') ? entry.jobs.length : 0), 0),
    oversizedFiles: entries.filter((entry) => entry.oversized).map((entry) => entry.sourceName)
  }
}

export const cleaningPlanInternals = {
  MAX_SILENT_MODEL_BATCHES,
  SEMANTIC_HEADER,
  AGGREGATED_METRIC_HEADER
}
