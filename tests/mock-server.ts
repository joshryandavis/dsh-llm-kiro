/**
 * Local Kiro runtime stand-in: replays scripted behaviors per request,
 * encoding event-stream responses with the same Smithy codec the provider
 * decodes. Each accepted request consumes one behavior.
 * @module tests/mock-server
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { EventStreamCodec } from '@smithy/core/event-streams'
import type { Message } from '@smithy/types'

/** One wire event the mock may emit. */
export interface KiroMockEvent {
  /** Event type header value; arbitrary for the provider's decode path. */
  eventType: string
  /** JSON payload body. */
  payload: Record<string, unknown>
}

/** One scripted behavior for the next request the mock server receives. */
export type Behavior =
  | { kind: 'eventstream'; events: KiroMockEvent[]; delayMs?: number; stallAfterMs?: number }
  | { kind: 'http-error'; status: number; body: string; headers?: Record<string, string> }
  | { kind: 'close-early'; events: KiroMockEvent[] }

export interface MockServer {
  url: string
  /** Bodies of received requests, in order. */
  requests: unknown[]
  /** Header bags of received requests, in order (parallel to requests). */
  headers: IncomingMessage['headers'][]
  script: Behavior[]
  close(): Promise<void>
}

const servers: Server[] = []

/** Close every server opened since the last call; run from each spec's afterEach. */
export async function closeMockServers(): Promise<void> {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => {
    server.closeAllConnections?.()
    server.close(() => { resolve() })
  })))
}

const codec = new EventStreamCodec(
  (input: Uint8Array) => new TextDecoder().decode(input),
  (input: string) => new TextEncoder().encode(input),
)

/** Encode one event-stream message. */
export function encodeEventStreamMessage(event: KiroMockEvent): Uint8Array {
  const message: Message = {
    headers: {
      ':message-type': { type: 'string', value: 'event' },
      ':event-type': { type: 'string', value: event.eventType },
      ':content-type': { type: 'string', value: 'application/json' },
    },
    body: new TextEncoder().encode(JSON.stringify(event.payload)),
  }
  return codec.encode(message)
}

/** A minimal complete text generation, reused by request-shape assertions. */
export const textEvents: KiroMockEvent[] = [
  { eventType: 'conversation', payload: { contextUsagePercentage: 12 } },
  { eventType: 'conversation', payload: { content: 'hello' } },
  { eventType: 'conversation', payload: { usage: { inputTokens: 10, outputTokens: 1 } } },
]

/** A thinking + text generation. */
export const thinkingTextEvents: KiroMockEvent[] = [
  { eventType: 'conversation', payload: { text: 'let me think' } },
  { eventType: 'conversation', payload: { signature: 'sig-123' } },
  { eventType: 'conversation', payload: { content: 'the answer' } },
  { eventType: 'conversation', payload: { usage: { inputTokens: 10, outputTokens: 2 } } },
]

/** A tool-call generation. */
export const toolCallEvents: KiroMockEvent[] = [
  { eventType: 'conversation', payload: { name: 'run_shell', toolUseId: 'call-1', input: '{"cmd":' } },
  { eventType: 'conversation', payload: { input: '"ls"' } },
  { eventType: 'conversation', payload: { stop: true } },
  { eventType: 'conversation', payload: { usage: { inputTokens: 10, outputTokens: 3 } } },
]

/** Local runtime stand-in: replays scripted behaviors per request. */
export async function mockServer(script: Behavior[]): Promise<MockServer> {
  const requests: unknown[] = []
  const headers: IncomingMessage['headers'][] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    request.on('end', () => {
      requests.push(JSON.parse(body))
      headers.push(request.headers)
      const behavior = script.shift()
      if (!behavior) {
        response.writeHead(500).end('mock script exhausted')
        return
      }
      if (behavior.kind === 'http-error') {
        response.writeHead(behavior.status, {
          'content-type': 'application/json',
          ...behavior.headers,
        })
        response.end(behavior.body)
        return
      }
      response.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream' })
      response.flushHeaders()
      const write = (index: number): void => {
        if (index >= behavior.events.length) {
          if (behavior.kind === 'eventstream' && behavior.stallAfterMs !== undefined) {
            // Hold the socket open: the provider's idle watchdog or abort
            // must tear it down.
            return
          }
          if (behavior.kind === 'eventstream') response.end()
          else response.destroy()
          return
        }
        response.write(Buffer.from(encodeEventStreamMessage(behavior.events[index])))
        setTimeout(() => { write(index + 1) }, behavior.kind === 'eventstream' ? behavior.delayMs ?? 0 : 5)
      }
      write(0)
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    headers,
    script,
    close: () => new Promise(resolve => {
      server.closeAllConnections?.()
      server.close(() => { resolve() })
    }),
  }
}