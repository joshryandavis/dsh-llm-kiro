/**
 * Structured reasoning-effort handling for Kiro runtime requests. The
 * authenticated management catalog discloses each model's effort schema (the
 * `additionalModelRequestFields` enum); before discovery runs, known models
 * fall back to hardcoded ladders. The harness effort vocabulary is
 * `off`/`low`/`high`/`max`; the wire effort is whatever the model's schema
 * accepts.
 * @module dsh-llm-kiro/effort
 */

import type { KiroAdditionalModelRequestFields } from './types.ts'

/** The request field the Kiro runtime uses for one model's effort. */
export type KiroEffortField = 'reasoning' | 'output_config'

/** One model's effort ladder and transport, derived from its catalog schema. */
export interface KiroEffortConfig {
  field: KiroEffortField
  values: readonly string[]
  summarizedThinking: boolean
}

const GPT_EFFORT_VALUES = ['low', 'medium', 'high', 'xhigh'] as const
const CLAUDE_EXTENDED_EFFORT_VALUES = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const CLAUDE_MAX_EFFORT_VALUES = ['low', 'medium', 'high', 'max'] as const
const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const

const CLAUDE_EXTENDED_EFFORT_MODELS = new Set([
  'claude-opus-4.8',
  'claude-opus-4.7',
  'claude-sonnet-5',
  'claude-fable-5',
])
const CLAUDE_MAX_EFFORT_MODELS = new Set([
  'claude-opus-4.6',
  'claude-sonnet-4.6',
  'claude-opus-4.6-1m',
  'claude-sonnet-4.6-1m',
])

/** Whether a value is a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Derive the effort ladder and transport from an authenticated catalog
 * schema, when the schema discloses them.
 * @param schema - the model's additionalModelRequestFields schema.
 * @returns the effort config, or undefined when the schema has none.
 */
export function deriveKiroEffort(schema: unknown): KiroEffortConfig | undefined {
  if (!isRecord(schema) || !isRecord(schema.properties)) return undefined

  for (const field of ['reasoning', 'output_config'] as const) {
    const fieldSchema = schema.properties[field]
    if (!isRecord(fieldSchema) || !isRecord(fieldSchema.properties)) continue

    const effortSchema = fieldSchema.properties.effort
    if (!isRecord(effortSchema) || !Array.isArray(effortSchema.enum) || effortSchema.enum.length === 0) continue
    if (!effortSchema.enum.every(value => typeof value === 'string' && value.length > 0)) continue

    const thinkingSchema = schema.properties.thinking
    const displaySchema =
      isRecord(thinkingSchema) && isRecord(thinkingSchema.properties) ? thinkingSchema.properties.display : undefined
    const summarizedThinking =
      isRecord(displaySchema) && Array.isArray(displaySchema.enum) && displaySchema.enum.includes('summarized')

    return { field, values: [...new Set(effortSchema.enum as string[])], summarizedThinking }
  }
  return undefined
}

/**
 * Known-model ladder used before catalog metadata is available. Only the
 * models this provider ships know their ladder ahead of discovery; everything
 * else waits for the authenticated schema.
 * @param kiroModelId - the wire model id.
 * @returns the effort config, or undefined for an unknown model.
 */
export function fallbackKiroEffort(kiroModelId: string): KiroEffortConfig | undefined {
  const normalizedId = kiroModelId.toLowerCase().replace(/(\d)-(\d)/g, '$1.$2')
  if (normalizedId.startsWith('openai-gpt')) {
    return { field: 'reasoning', values: GPT_EFFORT_VALUES, summarizedThinking: false }
  }
  if (CLAUDE_EXTENDED_EFFORT_MODELS.has(normalizedId)) {
    return { field: 'output_config', values: CLAUDE_EXTENDED_EFFORT_VALUES, summarizedThinking: true }
  }
  if (CLAUDE_MAX_EFFORT_MODELS.has(normalizedId)) {
    return { field: 'output_config', values: CLAUDE_MAX_EFFORT_VALUES, summarizedThinking: false }
  }
  return undefined
}

/**
 * The effort config for one model: the catalog schema wins, the known-model
 * fallback fills in only its absence.
 * @param schema - the authenticated schema, when available.
 * @param kiroModelId - the wire model id.
 * @returns the effort config, or undefined when nothing discloses a ladder.
 */
export function getKiroEffortConfig(schema: unknown, kiroModelId: string): KiroEffortConfig | undefined {
  if (schema !== undefined) return deriveKiroEffort(schema)
  return fallbackKiroEffort(kiroModelId)
}

/**
 * Map a harness effort level to a value present in the model's Kiro enum,
 * rounding to the nearest available rung when the exact level is absent.
 * @param effort - the harness effort ('low' | 'high' | 'max').
 * @param config - the model's effort config.
 * @returns the wire effort value, or undefined when the model has no ladder.
 */
export function mapDshEffortToKiro(effort: 'low' | 'high' | 'max', config: KiroEffortConfig): string | undefined {
  if (config.values.length === 0) return undefined

  const target = effort
  if (config.values.includes(target)) return target

  const targetIndex = EFFORT_ORDER.indexOf(target as (typeof EFFORT_ORDER)[number])
  if (targetIndex >= 0) {
    for (let index = targetIndex; index < EFFORT_ORDER.length; index++) {
      const candidate = EFFORT_ORDER[index]
      if (candidate !== undefined && config.values.includes(candidate)) return candidate
    }
    for (let index = targetIndex - 1; index >= 0; index--) {
      const candidate = EFFORT_ORDER[index]
      if (candidate !== undefined && config.values.includes(candidate)) return candidate
    }
  }
  return config.values[0]
}

/**
 * Build the top-level Kiro runtime field for one requested harness effort.
 * @param config - the model's effort config.
 * @param effort - the harness effort.
 * @returns the wire fields, or undefined when nothing maps.
 */
export function buildKiroAdditionalModelRequestFields(
  config: KiroEffortConfig | undefined,
  effort: 'low' | 'high' | 'max' | undefined,
): KiroAdditionalModelRequestFields | undefined {
  if (!effort || !config) return undefined
  const wireEffort = mapDshEffortToKiro(effort, config)
  if (!wireEffort) return undefined

  return config.field === 'output_config'
    ? {
        output_config: { effort: wireEffort },
        thinking: {
          type: 'adaptive',
          ...(config.summarizedThinking ? { display: 'summarized' as const } : {}),
        },
      }
    : { reasoning: { effort: wireEffort } }
}
