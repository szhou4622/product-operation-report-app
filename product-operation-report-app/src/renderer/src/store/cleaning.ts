export interface CleaningConcurrencyPlan {
  sourceWorkers: number
  batchWorkersPerSource: number
  maximumActiveRequests: number
}

export function cleaningBatchConcurrency(sourceWorkerCount: number, maxReportConcurrency = 4): number {
  const workers = Math.max(1, Math.min(maxReportConcurrency, Math.floor(sourceWorkerCount) || 1))
  if (workers === 1) return Math.min(3, maxReportConcurrency)
  return Math.max(1, Math.floor(maxReportConcurrency / workers))
}

export function planCleaningConcurrency(sourceCount: number, maxReportConcurrency = 4): CleaningConcurrencyPlan {
  const sourceWorkers = Math.max(1, Math.min(maxReportConcurrency, Math.floor(sourceCount) || 1))
  const batchWorkersPerSource = cleaningBatchConcurrency(sourceWorkers, maxReportConcurrency)
  return {
    sourceWorkers,
    batchWorkersPerSource,
    maximumActiveRequests: sourceWorkers * batchWorkersPerSource
  }
}
