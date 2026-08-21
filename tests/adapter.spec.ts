/**
 * KiroAdapter transport tests against the scripted local mock server:
 * request shape, attribution headers, stream translation, auth-recovery,
 * capacity retries, timeouts, and error classification.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { KiroAdapter } from '../src/adapter.ts'
import type { KiroAdapterOptions, KiroConnectionOptions } from '../src/adapter.ts'
import type { KiroCredentials } from '../src/types.ts'
import { closeMockServers, mockServer, textEvents, thinkingTextEvents, toolCallEvents, type Behavior } from './mock-server.ts'
import { DEFAULT_FIRST_TOKEN_TIMEOUT_MS, DEFAULT_STREAM_IDLE_TIMEOUT_MS } from '../src/adapter.ts'

const credential: KiroCredentials = {
  access: 'token-1',
  refresh: 'refresh-1|c|s|idc',
  expires: Date.now() + 3600_000,
  clientId: 'c',
  clientSecret: 's',
  region: 'us-east-1',
  authMethod: 'idc',
  profileArn: 'arn:aws:codewhisperer:us-east-1:123:profile/test',
}

let lastMockURL: string | undefined

afterEach(() => {
  lastMockURL = undefined
})

async function serverWith(script: Behavior[]): Promise<ReturnType<typeof mockServer>> {
  const server = await mockServer(script)
  lastMockURL = server.url
  return server
}

function connection(overrides: Partial<KiroConnectionOptions> = {}): KiroConnectionOptions {
  return {
    ...(lastMockURL !== undefined ? { runtimeURL: lastMockURL } : {}),
    models: [
      { id: 'claude-sonnet-4-6', kiroModelId: 'claude-sonnet-4.6', name: 'Sonnet', reasoning: true, contextWindow: 200000, maxTokens: 65536, inputModalities: ['text', 'image'] },
      { id: 'glm-5', kiroModelId: 'glm-5', name: 'GLM 5', reasoning: true, contextWindow: 200000, maxTokens: 8192, inputModalities: ['text'] },
    ],
    defaultContextWindow: 200000,
    maxTokens: 8192,
    thinking: 'enabled',
    reasoningEffort: 'high',
    streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    firstTokenTimeoutMs: DEFAULT_FIRST_TOKEN_TIMEOUT_MS,
    retryPolicy: { mode: 'normal', maxRetries: 5 },
    allowKiroCliRefresh: true,
    ...overrides,
  }
}

function adapter(
  overrides: Partial<KiroAdapterOptions> = {},
  resolveCredential = vi.fn(async () => credential),
  recoverCredential = vi.fn(async () => undefined),
): KiroAdapter {
  return new KiroAdapter({
    options: () => connection(),
    resolveCredential,
    recoverCredential,
    ...overrides,
  })
}

function request(overrides: Record<string, unknown> = {}): any {
  return {
    provider: 'kiro',
    model: 'claude-sonnet-4-6',
    reasoningEffort: 'off',
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
    }],
    ...overrides,
  }
}

async function collect(chunks: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const chunk of chunks) out.push(chunk)
  return out
}

afterEach(async () => {
  await closeMockServers()
  vi.restoreAllMocks()
})

describe('llm-kiro adapter stream', () => {
  it('streams a text response with the attribution user-agent and request shape', async () => {
    const server = await serverWith([{ kind: 'eventstream', events: textEvents }])
    const chunks = await collect(adapter().stream(request()))
    expect(chunks).toContainEqual({ type: 'block-start', index: 0, blockType: 'text' })
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'hello' })
    expect(chunks).toContainEqual({ type: 'finish', reason: { kind: 'stop' } })
    // The runtime's client-identity gate requires the SDK-shaped UA on both
    // headers; the harness attribution UA is rejected with 403.
    expect(server.headers[0]?.['user-agent']).toMatch(/^aws-sdk-rust\/1\.0\.0 ua\/2\.1 os\/other lang\/js api\/codewhispererstreaming#1\.28\.3 m\/E app\/AmazonQ-For-CLI md\/appVersion-\S+$/)
    expect(server.headers[0]?.['x-amz-user-agent']).toBe(server.headers[0]?.['user-agent'])
    expect(server.headers[0]?.authorization).toBe('Bearer token-1')
    expect(server.headers[0]?.accept).toBe('application/vnd.amazon.eventstream')
    expect(server.headers[0]?.['x-amzn-codewhisperer-optout']).toBe('true')
    expect(server.headers[0]?.['x-amzn-kiro-agent-mode']).toBe('vibe')
    const body = server.requests[0] as Record<string, unknown>
    expect(body.profileArn).toBe('arn:aws:codewhisperer:us-east-1:123:profile/test')
    expect(body.agentMode).toBe('vibe')
    expect((body.conversationState as Record<string, unknown>).chatTriggerType).toBe('MANUAL')
    expect((body.conversationState as Record<string, unknown>).currentMessage).toMatchObject({
      userInputMessage: {
        content: 'hello',
        modelId: 'claude-sonnet-4.6',
        origin: 'KIRO_CLI',
      },
    })
  })

  it('streams thinking and tool calls with a tool-calls finish', async () => {
    const server = await serverWith([
      { kind: 'eventstream', events: thinkingTextEvents },
      { kind: 'eventstream', events: toolCallEvents },
    ])
    const thinking = await collect(adapter().stream(request({ model: 'glm-5' })))
    expect(thinking).toContainEqual({ type: 'block-start', index: 0, blockType: 'reasoning' })
    const tools = await collect(adapter().stream(request()))
    expect(tools).toContainEqual({ type: 'block-end', index: 0, block: expect.objectContaining({ type: 'tool-call' }) })
    expect(tools).toContainEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
    expect(server.requests).toHaveLength(2)
  })

  it('sends thinking markers and effort fields when reasoning is enabled', async () => {
    const server = await serverWith([{ kind: 'eventstream', events: textEvents }])
    await collect(adapter().stream(request({ reasoningEffort: 'max' })))
    const body = server.requests[0] as Record<string, unknown>
    const current = (body.conversationState as Record<string, unknown>).currentMessage as Record<string, unknown>
    const content = (current.userInputMessage as Record<string, unknown>).content as string
    expect(content).toContain('<thinking_mode>enabled</thinking_mode>')
    expect(content).toContain('<max_thinking_length>50000</max_thinking_length>')
    expect(body.additionalModelRequestFields).toBeDefined()
  })

  it('omits thinking markers when the effort is off', async () => {
    const server = await serverWith([{ kind: 'eventstream', events: textEvents }])
    await collect(adapter().stream(request({ reasoningEffort: 'off' })))
    const body = server.requests[0] as Record<string, unknown>
    const current = (body.conversationState as Record<string, unknown>).currentMessage as Record<string, unknown>
    expect((current.userInputMessage as Record<string, unknown>).content).not.toContain('<thinking_mode>')
    expect(body.additionalModelRequestFields).toBeUndefined()
  })

  it('recovers from a 403 with a rotated credential and retries once', async () => {
    const server = await serverWith([
      { kind: 'http-error', status: 403, body: 'Forbidden' },
      { kind: 'eventstream', events: textEvents },
    ])
    const recoverCredential = vi.fn(async () => ({ ...credential, access: 'token-2' }))
    const chunks = await collect(adapter({ recoverCredential }).stream(request()))
    expect(chunks.some(chunk => (chunk as { type: string }).type === 'finish')).toBe(true)
    expect(server.headers).toHaveLength(2)
    expect(server.headers[1]?.authorization).toBe('Bearer token-2')
  })

  it('fails with AUTH when recovery finds nothing new', async () => {
    const server = await serverWith([{ kind: 'http-error', status: 403, body: 'Forbidden' }])
    const error = await collect(adapter().stream(request())).catch(error => error)
    expect(error).toBeInstanceOf(LlmError)
    expect(error).toMatchObject({ code: 'AUTH' })
  })

  it('retries capacity rejections with backoff before streaming', async () => {
    const server = await serverWith([
      { kind: 'http-error', status: 429, body: 'INSUFFICIENT_MODEL_CAPACITY' },
      { kind: 'http-error', status: 429, body: 'INSUFFICIENT_MODEL_CAPACITY' },
      { kind: 'eventstream', events: textEvents },
    ])
    const chunks = await collect(adapter({ options: () => connection({ capacityDelayMs: () => 1 }) }).stream(request()))
    expect(chunks).toContainEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(server.requests).toHaveLength(3)
  })

  it('gives up on capacity after the retry budget', async () => {
    const server = await serverWith([
      { kind: 'http-error', status: 429, body: 'INSUFFICIENT_MODEL_CAPACITY' },
      { kind: 'http-error', status: 429, body: 'INSUFFICIENT_MODEL_CAPACITY' },
      { kind: 'http-error', status: 429, body: 'INSUFFICIENT_MODEL_CAPACITY' },
      { kind: 'http-error', status: 429, body: 'INSUFFICIENT_MODEL_CAPACITY' },
    ])
    await expect(collect(adapter({ options: () => connection({ capacityDelayMs: () => 1 }) }).stream(request())))
      .rejects.toMatchObject({ code: 'RATE_LIMIT' })
  })

  it('classifies quota, context-overflow, and server errors', async () => {
    await closeMockServers()
    const quota = await serverWith([{ kind: 'http-error', status: 429, body: 'MONTHLY_REQUEST_COUNT exceeded' }])
    await expect(collect(adapter().stream(request()))).rejects.toMatchObject({ code: 'QUOTA' })
    await closeMockServers()
    const big = await serverWith([{ kind: 'http-error', status: 400, body: 'Input is too long' }])
    await expect(collect(adapter().stream(request()))).rejects.toMatchObject({ code: 'CONTEXT_WINDOW_EXCEEDED' })
    await closeMockServers()
    const serverErr = await serverWith([{ kind: 'http-error', status: 500, body: 'boom' }])
    await expect(collect(adapter().stream(request()))).rejects.toMatchObject({ code: 'SERVER' })
  })

  it('maps caller abort to ABORTED', async () => {
    const controller = new AbortController()
    const server = await serverWith([{ kind: 'eventstream', events: [{ eventType: 'conversation', payload: { content: 'x' } }], stallAfterMs: 60_000 }])
    const pending = collect(adapter().stream(request({ signal: controller.signal }))).catch(error => error)
    setTimeout(() => controller.abort('test abort'), 50)
    const error = await pending
    expect(error).toMatchObject({ code: 'ABORTED' })
  })

  it('fails with TIMEOUT when the first token never arrives', async () => {
    const server = await serverWith([{ kind: 'eventstream', events: [], stallAfterMs: 60_000 }])
    await expect(collect(adapter({ options: () => connection({ firstTokenTimeoutMs: 50 }) }).stream(request())))
      .rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('fails with TIMEOUT on the idle watchdog', async () => {
    const server = await serverWith([{ kind: 'eventstream', events: [{ eventType: 'conversation', payload: { content: 'a' } }], stallAfterMs: 60_000 }])
    await expect(collect(adapter({ options: () => connection({ streamIdleTimeoutMs: 80 }) }).stream(request())))
      .rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('rejects image input without the attachment service or image capability', async () => {
    const imageMessage = {
      role: 'user',
      content: [{
        type: 'image',
        attachment: {
          attachmentId: AttachmentId('sha256:' + 'a'.repeat(64)),
          mediaType: 'image/png' as const,
          bytes: 3,
          width: 1,
          height: 1,
        },
      }],
    }
    await expect(collect(adapter().stream(request({ model: 'glm-5', messages: [imageMessage] }))))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    await expect(collect(adapter().stream(request({ messages: [imageMessage] }))))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
  })

  it('sends image bytes resolved through the attachment store', async () => {
    const store = {
      readImage: vi.fn(async (ref: ImageAttachmentRef) => ({
        ref,
        data: Uint8Array.of(1, 2, 3),
      })),
    } as unknown as AttachmentStore
    const server = await serverWith([{ kind: 'eventstream', events: textEvents }])
    const imageMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'what is this?' },
        {
          type: 'image',
          attachment: {
            attachmentId: AttachmentId('sha256:' + 'a'.repeat(64)),
            mediaType: 'image/png' as const,
            bytes: 3,
            width: 1,
            height: 1,
          },
        },
      ],
    }
    await collect(adapter({ resolveAttachments: () => store }).stream(request({ messages: [imageMessage] })))
    const body = server.requests[0] as Record<string, unknown>
    const current = (body.conversationState as Record<string, unknown>).currentMessage as Record<string, unknown>
    expect((current.userInputMessage as Record<string, unknown>).images).toEqual([
      { format: 'png', source: { bytes: 'AQID' } },
    ])
    expect(store.readImage).toHaveBeenCalledOnce()
  })

  it('resolves the profile through the management API when not provided', async () => {
    const server = await serverWith([{ kind: 'eventstream', events: textEvents }])
    const realFetch = globalThis.fetch.bind(globalThis)
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('List-Available-Profiles')) {
        return new Response(JSON.stringify({ profiles: [{ arn: 'arn:discovered' }] }), { status: 200 })
      }
      return realFetch(url, init)
    })
    vi.stubGlobal('fetch', fetchMock)
    const noProfile = vi.fn(async () => ({
      access: 'token-1',
      refresh: 'refresh-1|c|s|idc',
      expires: Date.now() + 3600_000,
      clientId: 'c',
      clientSecret: 's',
      region: 'us-east-1',
      authMethod: 'idc' as const,
    }))
    await collect(adapter({}, noProfile).stream(request()))
    const body = server.requests[0] as Record<string, unknown>
    expect(body.profileArn).toBe('arn:discovered')
    vi.unstubAllGlobals()
  })

  it('listModels and resolveModel expose catalog metadata', async () => {
    const inst = adapter()
    const models = await inst.listModels('kiro')
    expect(models.map(model => model.id)).toContain('claude-sonnet-4-6')
    const resolved = await inst.resolveModel('kiro', 'claude-sonnet-4-6')
    expect(resolved).toMatchObject({
      context: { contextWindow: 200000 },
      defaultMaxTokens: 65536,
      reasoning: { efforts: expect.any(Array), defaultEffort: expect.any(String) },
    })
    const passThrough = await inst.resolveModel('kiro', 'unknown-model')
    expect(passThrough).toMatchObject({ id: 'unknown-model', context: { contextWindow: 200000 } })
    const locked = adapter({ options: () => connection({ thinking: 'disabled' }) })
    const lockedResolved = await locked.resolveModel('kiro', 'claude-sonnet-4-6')
    expect(lockedResolved.reasoning).toEqual({
      efforts: [{ id: 'off', name: 'Off' }],
      defaultEffort: 'off',
    })
    expect(inst.providerInfo('kiro')).toEqual({ id: 'kiro', name: 'Kiro' })
    expect(inst.providerRetryPolicy('kiro')).toEqual({ mode: 'normal', maxRetries: 5 })
  })

  it('fails loud for an unknown model id on the wire', async () => {
    await expect(collect(adapter().stream(request({ model: 'totally-unknown' }))))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })
})