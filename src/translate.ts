/**
 * Translate Kiro stream events into the harness StreamChunk protocol: one
 * stateful harness block per reasoning, text, or tool-call index. Usage is
 * reported before the terminal finish; the finish reason derives from whether
 * tool calls were emitted.
 * @module dsh-llm-kiro/translate
 */

import { CallId, EMPTY_RESPONSE_CODE, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { KiroStreamEvent } from './types.ts'

/** One open block under assembly. */
interface OpenBlock {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  /** tool-call only */
  callId?: string
  name?: string
  /** Whether the block already emitted its block-end. */
  closed: boolean
}

/** Assemble the final ContentBlock for one open block. */
function closeBlock(block: OpenBlock): ContentBlock {
  switch (block.kind) {
    case 'text': return { type: 'text', text: block.text }
    case 'reasoning': return { type: 'reasoning', text: block.text }
    case 'tool-call': return {
      type: 'tool-call',
      id: CallId(block.callId ?? ''),
      name: block.name ?? '',
      arguments: block.text,
    }
  }
}

/**
 * Translate one runtime event stream into harness chunks. The stream must
 * end (done) for the terminal finish; an error event becomes an error finish.
 * @param events - the typed runtime events.
 * @param contextWindow - the model's context capacity, for the input estimate.
 * @returns the harness chunks.
 */
export async function* translate(events: AsyncIterable<KiroStreamEvent>, contextWindow: number): AsyncGenerator<StreamChunk> {
  let nextIndex = 0
  let textBlock: OpenBlock | undefined
  let reasoningBlock: OpenBlock | undefined
  const toolBlocks = new Map<string, OpenBlock>()
  const order: OpenBlock[] = []
  let emittedToolCalls = 0
  let sawAnyToolCalls = false
  let contextUsagePercentage: number | undefined
  let usageEvent: { inputTokens?: number; outputTokens?: number } | undefined
  let lastContentData: string | undefined

  const open = (kind: OpenBlock['kind']): OpenBlock => {
    const block: OpenBlock = { index: nextIndex++, kind, text: '', closed: false }
    order.push(block)
    return block
  }
  /** Close one block, emitting its block-end exactly once. */
  function* close(block: OpenBlock): Generator<StreamChunk> {
    if (block.closed) return
    block.closed = true
    yield { type: 'block-end', index: block.index, block: closeBlock(block) }
  }
  function* closeTool(block: OpenBlock): Generator<StreamChunk> {
    yield* close(block)
    toolBlocks.delete(block.callId ?? '')
    emittedToolCalls++
  }

  /** Close every still-open block in first-seen order; tool calls closed
   *  here were emitted without a stop event and still count as emitted. */
  function* closeAllOpen(): Generator<StreamChunk> {
    for (const block of order) {
      if (block.closed) continue
      if (block.kind === 'tool-call') emittedToolCalls++
      yield* close(block)
    }
  }

  /** Finish this stream with the given reason. */
  function* finish(reason: FinishReason): Generator<StreamChunk> {
    const usage: TokenUsage = {
      inputTokens: usageEvent?.inputTokens ?? Math.round((contextUsagePercentage ?? 0) / 100 * contextWindow),
      outputTokens: usageEvent?.outputTokens ?? 0,
    }
    yield { type: 'usage', usage }
    yield { type: 'finish', reason }
  }

  for await (const event of events) {
    switch (event.type) {
      case 'contextUsage': {
        contextUsagePercentage = event.data.contextUsagePercentage
        break
      }
      case 'thinkingText': {
        if (!reasoningBlock) {
          reasoningBlock = open('reasoning')
          yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
        }
        reasoningBlock.text += event.data
        yield { type: 'reasoning-delta', index: reasoningBlock.index, text: event.data }
        break
      }
      case 'thinkingSignature': {
        // The signature ends the thinking block; the harness block has no
        // signature slot, so the block simply closes here.
        if (reasoningBlock) {
          yield* close(reasoningBlock)
          reasoningBlock = undefined
        }
        break
      }
      case 'content': {
        // The backend may repeat the last content event as a heartbeat.
        if (event.data === lastContentData) continue
        lastContentData = event.data
        if (!textBlock) {
          textBlock = open('text')
          yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
        }
        textBlock.text += event.data
        yield { type: 'text-delta', index: textBlock.index, text: event.data }
        break
      }
      case 'toolUse': {
        const tc = event.data
        sawAnyToolCalls = true
        let block = toolBlocks.get(tc.toolUseId)
        if (!block) {
          block = open('tool-call')
          block.callId = tc.toolUseId
          block.name = tc.name
          toolBlocks.set(tc.toolUseId, block)
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        }
        block.text += tc.input
        yield { type: 'tool-call-delta', index: block.index, id: CallId(tc.toolUseId), ...(block.name !== undefined ? { name: block.name } : {}), argumentsDelta: tc.input }
        if (tc.stop) yield* closeTool(block)
        break
      }
      case 'toolUseInput': {
        const block = [...toolBlocks.values()].at(-1)
        if (block) {
          block.text += event.data.input
          yield { type: 'tool-call-delta', index: block.index, id: CallId(block.callId ?? ''), argumentsDelta: event.data.input }
        }
        break
      }
      case 'toolUseStop': {
        if (event.data.stop) {
          const block = [...toolBlocks.values()].at(-1)
          if (block) yield* closeTool(block)
        }
        break
      }
      case 'usage': {
        usageEvent = event.data
        break
      }
      case 'followupPrompt': {
        // Follow-up prompts are suggestions for the next user turn; the
        // harness loop does not consume them.
        break
      }
      case 'error': {
        throw new LlmError(
          `Kiro API stream error: ${event.data.message ? `${event.data.error}: ${event.data.message}` : event.data.error}`,
          'SERVER',
        )
      }
    }
  }

  yield* closeAllOpen()

  if (!textBlock && !reasoningBlock && !sawAnyToolCalls) {
    yield* finish({
      kind: 'error',
      failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
    })
    return
  }
  yield* finish(emittedToolCalls > 0 ? { kind: 'tool-calls' } : { kind: 'stop' })
}