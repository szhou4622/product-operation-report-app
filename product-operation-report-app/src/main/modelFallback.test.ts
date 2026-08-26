import { describe, expect, it } from 'vitest'
import { shouldTryModelFallback } from './modelFallback'

describe('task-scoped model fallback', () => {
  it('allows zero-output provider recovery for cleaning and every report module', () => {
    expect(shouldTryModelFallback({
      taskType: 'source_clean',
      failureKind: 'provider_error',
      outputChars: 0,
      aborted: false,
      hasNext: true
    })).toBe(true)
    expect(shouldTryModelFallback({
      taskType: 'module_platform_audience',
      failureKind: 'provider_error',
      outputChars: 0,
      aborted: false,
      hasNext: true
    })).toBe(true)
    expect(shouldTryModelFallback({
      taskType: 'module_audience_sp_scene',
      failureKind: 'provider_error',
      outputChars: 0,
      aborted: false,
      hasNext: true
    })).toBe(true)
    for (const taskType of [
      'module_product_info',
      'module_material_review',
      'module_selling_points',
      'module_voc'
    ] as const) {
      expect(shouldTryModelFallback({
        taskType,
        failureKind: 'provider_error',
        outputChars: 0,
        aborted: false,
        hasNext: true
      })).toBe(true)
    }
    expect(shouldTryModelFallback({
      taskType: 'final_part',
      failureKind: 'provider_error',
      outputChars: 0,
      aborted: false,
      hasNext: true
    })).toBe(false)
  })

  it('never switches after partial output, user stop, or a security rejection', () => {
    expect(shouldTryModelFallback({
      taskType: 'module_platform_audience',
      failureKind: 'provider_error',
      outputChars: 8,
      aborted: false,
      hasNext: true
    })).toBe(false)
    expect(shouldTryModelFallback({
      taskType: 'module_platform_audience',
      failureKind: 'provider_error',
      outputChars: 0,
      aborted: true,
      hasNext: true
    })).toBe(false)
    expect(shouldTryModelFallback({
      taskType: 'module_platform_audience',
      failureKind: 'safety',
      outputChars: 0,
      aborted: false,
      hasNext: true
    })).toBe(false)
  })
})
