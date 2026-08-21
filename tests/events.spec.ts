import { describe, expect, it } from 'vitest'
import { parseKiroEvent } from '../src/events.ts'

describe('llm-kiro event parsing', () => {
  it('classifies content, thinking, and signature events', () => {
    expect(parseKiroEvent({ content: 'hi' })).toEqual({ type: 'content', data: 'hi' })
    expect(parseKiroEvent({ text: 'hmm' })).toEqual({ type: 'thinkingText', data: 'hmm' })
    expect(parseKiroEvent({ signature: 'sig' })).toEqual({ type: 'thinkingSignature', data: 'sig' })
  })

  it('classifies tool use events with string or object input', () => {
    expect(parseKiroEvent({ name: 'sh', toolUseId: 'c1', input: '{"x":1}', stop: true })).toEqual({
      type: 'toolUse',
      data: { name: 'sh', toolUseId: 'c1', input: '{"x":1}', stop: true },
    })
    expect(parseKiroEvent({ name: 'sh', toolUseId: 'c2', input: { x: 1 } })).toEqual({
      type: 'toolUse',
      data: { name: 'sh', toolUseId: 'c2', input: '{"x":1}' },
    })
    expect(parseKiroEvent({ name: 'sh', toolUseId: 'c3', input: {} })).toEqual({
      type: 'toolUse',
      data: { name: 'sh', toolUseId: 'c3', input: '' },
    })
    expect(parseKiroEvent({ input: 'fragment' })).toEqual({ type: 'toolUseInput', data: { input: 'fragment' } })
    expect(parseKiroEvent({ stop: true })).toEqual({ type: 'toolUseStop', data: { stop: true } })
  })

  it('classifies context usage, followup prompts, and usage events', () => {
    expect(parseKiroEvent({ contextUsagePercentage: 25 })).toEqual({
      type: 'contextUsage',
      data: { contextUsagePercentage: 25 },
    })
    expect(parseKiroEvent({ followupPrompt: 'want more?' })).toEqual({ type: 'followupPrompt', data: 'want more?' })
    expect(parseKiroEvent({ usage: { inputTokens: 4, outputTokens: 2 } })).toEqual({
      type: 'usage',
      data: { inputTokens: 4, outputTokens: 2 },
    })
    expect(parseKiroEvent({ usage: {} })).toEqual({ type: 'usage', data: {} })
  })

  it('classifies error events in both spellings', () => {
    expect(parseKiroEvent({ error: 'boom', message: 'detail' })).toEqual({
      type: 'error',
      data: { error: 'boom', message: 'detail' },
    })
    expect(parseKiroEvent({ Error: 'boom', reason: 'r' })).toEqual({
      type: 'error',
      data: { error: 'boom', message: 'r' },
    })
  })

  it('returns null for unrecognized payloads', () => {
    expect(parseKiroEvent({ something: 'else' })).toBeNull()
  })
})
