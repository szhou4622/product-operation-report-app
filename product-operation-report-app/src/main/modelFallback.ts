import type { ChatStreamEvent, ModelProfile, ModelTaskType } from '../shared/types'

const RECOVERABLE_FAILURES = new Set([
  'empty_output',
  'model_unavailable',
  'provider_route_unavailable'
])
const MODULE_PROVIDER_RECOVERY_TASKS = new Set<ModelTaskType>([
  'source_clean',
  'module_product_info',
  'module_platform_audience',
  'module_material_review',
  'module_benchmark',
  'module_selling_points',
  'module_voc',
  'module_ranking',
  'module_audience_sp_scene'
])

export function profilesForTask(profiles: ModelProfile[], taskType: ModelTaskType): ModelProfile[] {
  if (taskType !== 'module_benchmark' || !profiles.length) return profiles
  const gpt55 = profiles.find((profile) => profile.model.toLowerCase() === 'gpt-5.5') || profiles[0]
  return [
    {
      ...gpt55,
      id: `${gpt55.id}-benchmark-sol`,
      name: '内置对标研究服务',
      model: 'gpt-5.6-sol'
    },
    { ...gpt55, id: `${gpt55.id}-benchmark-fallback`, model: 'gpt-5.5' }
  ]
}

export interface ModelFallbackDecisionInput {
  failureKind?: string
  outputChars: number
  aborted: boolean
  hasNext: boolean
  taskType?: ModelTaskType
}

/**
 * 仅在当前模型没有产生任何有效文字且错误可恢复时切换。
 * 这条边界用于防止不同模型的半截内容拼接，也避免绕过授权或安全限制。
 */
export function shouldTryModelFallback(input: ModelFallbackDecisionInput): boolean {
  const taskSpecificProviderRecovery =
    Boolean(input.taskType && MODULE_PROVIDER_RECOVERY_TASKS.has(input.taskType)) &&
    input.failureKind === 'provider_error'
  return Boolean(
    input.hasNext &&
    !input.aborted &&
    input.outputChars === 0 &&
    input.failureKind &&
    (RECOVERABLE_FAILURES.has(input.failureKind) || taskSpecificProviderRecovery)
  )
}

export interface ModelFallbackAttemptOutcome {
  terminal: Extract<ChatStreamEvent, { type: 'done' | 'error' }>
  failureKind?: string
  outputChars: number
  hasVisibleOutput: boolean
  aborted: boolean
}

export interface ModelFallbackSequenceResult {
  profile: ModelProfile
  profileIndex: number
  outcome: ModelFallbackAttemptOutcome
}

/** 依次执行模型；attempt 负责每次尝试的 Token 记录与积分结算。 */
export async function runModelFallbackSequence(
  profiles: ModelProfile[],
  attempt: (profile: ModelProfile, profileIndex: number) => Promise<ModelFallbackAttemptOutcome>,
  taskType?: ModelTaskType
): Promise<ModelFallbackSequenceResult> {
  if (!profiles.length) throw new Error('没有可用的模型配置。')
  for (let profileIndex = 0; profileIndex < profiles.length; profileIndex += 1) {
    const profile = profiles[profileIndex]
    const outcome = await attempt(profile, profileIndex)
    const shouldFallback = outcome.terminal.type === 'error' && shouldTryModelFallback({
      failureKind: outcome.failureKind,
      outputChars: outcome.hasVisibleOutput ? outcome.outputChars : 0,
      aborted: outcome.aborted,
      hasNext: profileIndex + 1 < profiles.length,
      taskType
    })
    if (shouldFallback) continue
    return { profile, profileIndex, outcome }
  }
  throw new Error('模型备用序列异常结束。')
}
