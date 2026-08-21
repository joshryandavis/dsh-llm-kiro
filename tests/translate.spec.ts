import { describe, expect, it } from 'vitest'
import { EMPTY_RESPONSE_CODE } from '@deepseek-ai/dsh-llm'
import { translate } from '../src/translate.ts'
import type { KiroStreamEvent } from '../src/types.ts'

async function collect(events: KiroStreamEvent[], contextWindow = 200_000) {
  const chunks: unknown[] = []
  for await (const chunk of translate(events, contextWindow)) chunks.push(chunk)
  return chunks
}

describe('llm-kiro translate', () => {
  it('translates a text response with usage', async () => {
    const chunks = await collect([
      { type: 'contextUsage', data: { contextUsagePercentage: 12 } },
      { type: 'content', data: 'hello' },
      { type: 'content', data: ' world' },
      { type: 'usage', data: { inputTokens: 24, outputTokens: 2 } },
    ])
    expect(chunks).toContainEqual({ type: 'block-start', index: 0, blockType: 'text' })
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'hello' })
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: ' world' })
    expect(chunks).toContainEqual({ type: 'block-end', index: 0, block: { type: 'text', text: 'hello world' } })
    expect(chunks).toContainEqual({ type: 'usage', usage: { inputTokens: 24, outputTokens: 2 } })
    expect(chunks).toContainEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('skips repeated content heartbeats and dedupes consecutive identical deltas', async () => {
    const chunks = await collect([
      { type: 'content', data: 'a' },
      { type: 'content', data: 'a' },
      { type: 'content', data: 'a' },
    ])
    const deltas = chunks.filter(chunk => (chunk as { type: string }).type === 'text-delta')
    expect(deltas).toHaveLength(1)
  })

  it('translates thinking into a reasoning block closed by the signature', async () => {
    const chunks = await collect([
      { type: 'thinkingText', data: 'hmm' },
      { type: 'thinkingText', data: ' more' },
      { type: 'thinkingSignature', data: 'sig' },
      { type: 'content', data: 'answer' },
    ])
    expect(chunks).toContainEqual({ type: 'block-start', index: 0, blockType: 'reasoning' })
    expect(chunks).toContainEqual({ type: 'reasoning-delta', index: 0, text: 'hmm' })
    expect(chunks).toContainEqual({ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'hmm more' } })
    expect(chunks).toContainEqual({ type: 'block-start', index: 1, blockType: 'text' })
    expect(chunks).toContainEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('translates a tool call stream into a tool-call block with a tool-calls finish', async () => {
    const chunks = await collect([
      { type: 'toolUse', data: { name: 'run_shell', toolUseId: 'call-1', input: '{"cmd":' } },
      { type: 'toolUseInput', data: { input: '"ls"' } },
      { type: 'toolUseStop', data: { stop: true } },
    ])
    expect(chunks).toContainEqual({ type: 'block-start', index: 0, blockType: 'tool-call' })
    expect(chunks).toContainEqual({
      type: 'tool-call-delta',
      index: 0,
      id: 'call-1',
      name: 'run_shell',
      argumentsDelta: '{"cmd":',
    })
    expect(chunks).toContainEqual({
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: 'call-1', name: 'run_shell', arguments: '{"cmd":"ls"' },
    })
    expect(chunks).toContainEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('closes an unstopped tool call at stream end', async () => {
    const chunks = await collect([
      { type: 'toolUse', data: { name: 'sh', toolUseId: 'c1', input: '' } },
    ])
    expect(chunks).toContainEqual({
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: 'c1', name: 'sh', arguments: '' },
    })
    expect(chunks).toContainEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('reports an error finish for an error event', async () => {
    const events = [
      { type: 'error' as const, data: { error: 'boom', message: 'detail' } },
    ]
    await expect(collect(events)).rejects.toThrow('boom: detail')
  })

  it('ignores followup prompts and reports empty responses as EMPTY_RESPONSE', async () => {
    const chunks = await collect([
      { type: 'followupPrompt', data: 'want more?' },
      { type: 'contextUsage', data: { contextUsagePercentage: 3 } },
    ])
    expect(chunks).toContainEqual({
      type: 'finish',
      reason: { kind: 'error', failure: expect.objectContaining({ code: EMPTY_RESPONSE_CODE }) },
    })
    const usage = chunks.find(chunk => (chunk as { type: string }).type === 'usage') as { usage: { inputTokens: number } }
    expect(usage.usage.inputTokens).toBe(6000)
  })

  it('emits usage before the finish chunk', async () => {
    const chunks = await collect([{ type: 'content', data: 'x' }])
    const usageIndex = chunks.findIndex(chunk => (chunk as { type: string }).type === 'usage')
    const finishIndex = chunks.findIndex(chunk => (chunk as { type: string }).type === 'finish')
    expect(usageIndex).toBeGreaterThanOrEqual(0)
    expect(finishIndex).toBeGreaterThan(usageIndex)
  })
})