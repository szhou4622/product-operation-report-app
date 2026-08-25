import type {
  ProjectCleanDetailSnapshot,
  ProjectMessageSnapshot,
  ProjectPhase,
  ProjectSourceSnapshot,
  ProjectTaskSnapshot,
  SavedProject,
  ModuleKey,
  ModuleRunState,
  ReportEngineVersion
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
  engineVersion: ReportEngineVersion
  legacyEngineVersion?: 'v1'
  legacyArtifacts?: Record<number, string>
  legacyModuleStates?: Partial<Record<ModuleKey, ModuleRunState>>
  legacyReportMarkdown?: string
  legacyBenchmarkAppendix?: string
  readOnly: boolean
  legacyNotice: string
  moduleStates: Partial<Record<ModuleKey, ModuleRunState>>
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
    engineVersion: state.engineVersion,
    legacyEngineVersion: state.legacyEngineVersion,
    legacyArtifacts: state.legacyArtifacts,
    legacyModuleStates: state.legacyModuleStates,
    legacyReportMarkdown: state.legacyReportMarkdown,
    legacyBenchmarkAppendix: state.legacyBenchmarkAppendix,
    readOnly: state.readOnly,
    legacyNotice: state.legacyNotice,
    moduleStates: state.moduleStates,
    updatedAt: new Date().toISOString()
  }
}
