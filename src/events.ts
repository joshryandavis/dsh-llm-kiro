/**
 * Kiro stream event type definitions and JSON-to-typed-event mapping. Binary
 * framing is handled by the shared marshaller in eventstream.ts.
 * @module dsh-llm-kiro/events
 */

import type { KiroStreamEvent } from './types.ts'

/**
 * Classify one decoded event payload. The runtime multiplexes several event
 * kinds over one JSON object shape; this is the single mapping from wire
 * fields to the typed event union.
 * @param parsed - the decoded payload.
 * @returns the typed event, or null for an unrecognized payload.
 */
export function parseKiroEvent(parsed: Record<string, unknown>): KiroStreamEvent | null {
  if (parsed.content !== undefined) return { type: 'content', data: parsed.content as string }
  if (typeof parsed.text === 'string') return { type: 'thinkingText', data: parsed.text }
  if (typeof parsed.signature === 'string') return { type: 'thinkingSignature', data: parsed.signature }
  if (parsed.name && parsed.toolUseId) {
    const input =
      typeof parsed.input === 'string'
        ? parsed.input
        : parsed.input && typeof parsed.input === 'object' && Object.keys(parsed.input as Record<string, unknown>).length > 0
          ? JSON.stringify(parsed.input)
          : ''
    return {
      type: 'toolUse',
      data: {
        name: parsed.name as string,
        toolUseId: parsed.toolUseId as string,
        input,
        ...(parsed.stop !== undefined ? { stop: parsed.stop as boolean } : {}),
      },
    }
  }
  if (parsed.input !== undefined && !parsed.name) {
    return {
      type: 'toolUseInput',
      data: { input: typeof parsed.input === 'string' ? parsed.input : JSON.stringify(parsed.input) },
    }
  }
  if (parsed.stop !== undefined && parsed.contextUsagePercentage === undefined) {
    return { type: 'toolUseStop', data: { stop: parsed.stop as boolean } }
  }
  if (parsed.contextUsagePercentage !== undefined) {
    return { type: 'contextUsage', data: { contextUsagePercentage: parsed.contextUsagePercentage as number } }
  }
  if (parsed.followupPrompt !== undefined) return { type: 'followupPrompt', data: parsed.followupPrompt as string }
  if (parsed.error !== undefined || parsed.Error !== undefined) {
    const error = (parsed.error || parsed.Error || 'unknown') as string
    const message = (parsed.message || parsed.Message || parsed.reason) as string | undefined
    return {
      type: 'error',
      data: {
        error: typeof error === 'string' ? error : JSON.stringify(error),
        ...(message !== undefined ? { message } : {}),
      },
    }
  }
  if (parsed.usage !== undefined) {
    const u = parsed.usage as Record<string, unknown>
    return {
      type: 'usage',
      data: {
        ...(u.inputTokens !== undefined ? { inputTokens: u.inputTokens as number } : {}),
        ...(u.outputTokens !== undefined ? { outputTokens: u.outputTokens as number } : {}),
      },
    }
  }
  return null
}
