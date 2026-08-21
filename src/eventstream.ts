/**
 * AWS event-stream framing for the Kiro runtime response. The runtime answers
 * `generateAssistantResponse` with a binary event stream (Smithy framing with
 * headers and CRC checks); @smithy/core's marshaller handles chunk
 * reassembly, CRC validation, and payload deserialization. This module owns
 * the single marshaller instance and the JSON payload extraction.
 * @module dsh-llm-kiro/eventstream
 */

import { UniversalEventStreamMarshaller } from '@smithy/core/event-streams'
import type { Message } from '@smithy/types'
import { parseKiroEvent } from './events.ts'
import type { KiroStreamEvent } from './types.ts'

/** The shared marshaller instance; state-free after construction. */
export const kiroEventStreamMarshaller = new UniversalEventStreamMarshaller({
  utf8Encoder: (input: Uint8Array) => new TextDecoder().decode(input),
  utf8Decoder: (input: string) => new TextEncoder().encode(input),
})

/** Read every chunk of one response body. */
async function* bodyChunks(body: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const bodyReader = body.getReader()
  try {
    while (true) {
      const { done, value } = await bodyReader.read()
      if (done) return
      yield value
    }
  } finally {
    bodyReader.releaseLock()
  }
}

/**
 * Decode one runtime response body into Kiro stream events. Each wire message
 * carries a header-name payload; the payload's JSON body becomes one event.
 * @param body - the response body stream.
 * @returns the decoded events in arrival order.
 */
export async function* decodeKiroEventStream(body: ReadableStream<Uint8Array>): AsyncGenerator<KiroStreamEvent> {
  const utf8Decoder = new TextDecoder()
  const eventStream = kiroEventStreamMarshaller.deserialize(bodyChunks(body), async (event: Record<string, Message>) => {
    const entry = Object.entries(event)[0]
    if (!entry) throw new Error('Received an empty event stream message')
    const [key, msg] = entry
    const parsed = JSON.parse(utf8Decoder.decode(msg.body)) as Record<string, unknown>
    return { [key]: parsed } as Record<string, unknown>
  })
  for await (const value of eventStream) {
    const payload = Object.values(value as Record<string, unknown>)[0] as Record<string, unknown> | undefined
    if (!payload) continue
    const event = parseKiroEvent(payload)
    if (event) yield event
  }
}
