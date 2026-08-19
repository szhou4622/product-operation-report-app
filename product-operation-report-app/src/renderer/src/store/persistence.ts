import type {
  ProjectCleanDetailSnapshot,
  ProjectMessageSnapshot,
  ProjectPhase,
  ProjectSourceSnapshot,
  ProjectTaskSnapshot,
  SavedProject
} from '../../../shared/types'
import { SOP_STEPS } from '../../../shared/types'

const REPORT_STEP_ID = SOP_STEPS[SOP_STEPS.length - 1]?.id ?? 9

export interface ProjectSnapshotState {
  projectRevision: number
  analysisSessionId: string
  sources: (ProjectSourceSnapshot & { parsing?: boolean })[]
  messages: ProjectMessageSnapshot[]
  cleanedData: string
  cleanDetails: ProjectCleanDetailSnapshot[]
  artifacts: Record<number, string>
  taskJournal?: Record<string, ProjectTaskSnapshot>
  reportMarkdown: string
  reportStale: boolean
  phase: ProjectPhase
  steering: string
}

export function buildProjectSnapshot(state: ProjectSnapshotState): SavedProject {
  return {
    revision: state.projectRevision,
    analysisSessionId: state.analysisSessionId,
    sources: state.sources.map(({ parsing: _parsing, ...source }) => source),
    messages: state.messages.map((message) => ({ ...message })),
    cleanedData: state.cleanedData,
    cleanDetails: state.cleanDetails,
    artifacts: state.artifacts,
    taskJournal: state.taskJournal || {},
    reportMarkdown: state.phase === 'cleaning' || state.phase === 'analyzing'
      ? state.artifacts[REPORT_STEP_ID] || ''
      : state.reportMarkdown,
    reportStale: state.reportStale,
    phase: state.phase,
    steering: state.steering,
    updatedAt: new Date().toISOString()
  }
}
