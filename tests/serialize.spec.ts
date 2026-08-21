import { describe, expect, it } from 'vitest'
import { CallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import {
  EMPTY_CONTENT_PLACEHOLDER,
  convertImagesToKiro,
  convertToolsToKiro,
  relocateDisplacedToolResults,
  sanitizeSurrogates,
  serializeKiroRequest,
  truncate,
  type EncodedKiroImage,
} from '../src/serialize.ts'

function request(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return { provider: 'kiro', model: 'claude-sonnet-4-6', messages: [], ...overrides }
}

function user(text: string): Message {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }) as Message
}

function assistant(text: string, toolCall?: { id: string; name: string; arguments: string }): Message {
  return createAssistantMessage({
    content: [
      ...(text ? [{ type: 'text' as const, text }] : []),
      ...(toolCall ? [{
        type: 'tool-call' as const,
        id: CallId(toolCall.id),
        name: toolCall.name,
        arguments: toolCall.arguments,
      }] : []),
    ],
    source: { provider: 'kiro', model: 'claude-sonnet-4-6' },
  })
}

function toolResult(callId: string, text: string, isError = false): Message {
  return createToolResultMessage({
    callId: CallId(callId),
    content: [{ type: 'text', text }],
    isError,
  }) as unknown as Message
}

const encoded = (): Map<string, EncodedKiroImage> => new Map([[
  'sha256:' + 'a'.repeat(64),
  { mediaType: 'image/png', data: 'AAAA' },
]])

describe('llm-kiro serialize', () => {
  it('builds a single-turn request with the system prompt prepended', () => {
    const body = serializeKiroRequest(request({
      messages: [user('hello')],
      system: 'be brief',
      sessionId: 's-1' as never,
    }), 'claude-sonnet-4.6', 'be brief', 200000)
    expect(body).toMatchObject({
      conversationState: {
        chatTriggerType: 'MANUAL',
        agentTaskType: 'vibe',
        conversationId: 's-1',
        currentMessage: {
          userInputMessage: {
            content: 'be brief\n\nhello',
            modelId: 'claude-sonnet-4.6',
            origin: 'KIRO_CLI',
          },
        },
      },
      profileArn: '',
      agentMode: 'vibe',
    })
    expect(body.conversationState.history).toBeUndefined()
  })

  it('builds an alternating history with tool calls and tool results', () => {
    const body = serializeKiroRequest(request({
      messages: [
        user('count files'),
        assistant('', { id: 'call-1', name: 'run_shell', arguments: '{"cmd":"ls"}' }),
        toolResult('call-1', 'file1\nfile2'),
        user('thanks'),
      ],
      tools: [{
        name: 'run_shell',
        description: 'Run a shell command',
        parameters: { type: 'object', properties: {} },
      }],
    }), 'claude-sonnet-4.6', undefined, 200000)
    const history = body.conversationState.history!
    expect(history[0]).toEqual({
      userInputMessage: {
        content: 'count files',
        modelId: 'claude-sonnet-4.6',
        origin: 'KIRO_CLI',
      },
    })
    expect(history[1]).toEqual({
      assistantResponseMessage: {
        content: '',
        toolUses: [{ name: 'run_shell', toolUseId: 'call-1', input: { cmd: 'ls' } }],
      },
    })
    expect(history[2]).toEqual({
      userInputMessage: {
        content: '',
        modelId: 'claude-sonnet-4.6',
        origin: 'KIRO_CLI',
        userInputMessageContext: {
          toolResults: [{ content: [{ text: 'file1\nfile2' }], status: 'success', toolUseId: 'call-1' }],
        },
      },
    })
    // The tool catalog rides the current message; the final user message is
    // the current message.
    const current = body.conversationState.currentMessage.userInputMessage
    expect(current.content).toBe('thanks')
    expect(current.userInputMessageContext!.tools![0].toolSpecification.name).toBe('run_shell')
  })

  it('carries an error tool result status and merges consecutive results', () => {
    const body = serializeKiroRequest(request({
      messages: [
        assistant('', { id: 'c1', name: 'read', arguments: '{"p":"a"}' }),
        toolResult('c1', 'failed', true),
        toolResult('c1', 'more'),
      ],
    }), 'glm-5', undefined, 200000)
    const history = body.conversationState.history!
    expect(history[0].assistantResponseMessage!.toolUses).toEqual([{ name: 'read', toolUseId: 'c1', input: { p: 'a' } }])
    expect(body.conversationState.currentMessage.userInputMessage.userInputMessageContext!.toolResults).toEqual([
      { content: [{ text: 'failed' }], status: 'error', toolUseId: 'c1' },
      { content: [{ text: 'more' }], status: 'success', toolUseId: 'c1' },
    ])
  })

  it('places the tool-result payload on the current message when the tail is a result carrier', () => {
    const body = serializeKiroRequest(request({
      messages: [
        assistant('', { id: 'c1', name: 'read', arguments: '{}' }),
        toolResult('c1', 'output'),
      ],
    }), 'glm-5', undefined, 200000)
    const history = body.conversationState.history!
    expect(history).toHaveLength(1)
    expect(history[0].assistantResponseMessage!.toolUses).toEqual([{ name: 'read', toolUseId: 'c1', input: {} }])
    expect(body.conversationState.currentMessage.userInputMessage).toMatchObject({
      content: '',
      userInputMessageContext: {
        toolResults: [{ content: [{ text: 'output' }], status: 'success', toolUseId: 'c1' }],
      },
    })
  })

  it('folds a trailing assistant turn into history and sends a placeholder current message', () => {
    const body = serializeKiroRequest(request({
      messages: [
        user('do it'),
        assistant('', { id: 'c1', name: 'read', arguments: '{}' }),
      ],
    }), 'glm-5', undefined, 200000)
    expect(body.conversationState.history![1].assistantResponseMessage!.toolUses).toHaveLength(1)
    expect(body.conversationState.currentMessage.userInputMessage.content).toBe(EMPTY_CONTENT_PLACEHOLDER)
  })

  it('adds placeholder tool specs for tools referenced only in history', () => {
    const body = serializeKiroRequest(request({
      messages: [
        assistant('', { id: 'c1', name: 'old_tool', arguments: '{}' }),
        toolResult('c1', 'ok'),
      ],
    }), 'glm-5', undefined, 200000)
    const tools = body.conversationState.currentMessage.userInputMessage.userInputMessageContext!.tools!
    expect(tools.map(tool => tool.toolSpecification.name)).toContain('old_tool')
  })

  it('relocates displaced tool results to follow their issuing assistant', () => {
    const displaced = [
      assistant('first', { id: 'A', name: 'a', arguments: '{}' }),
      user('interjection'),
      assistant('second', { id: 'B', name: 'b', arguments: '{}' }),
      toolResult('A', 'a-out'),
      toolResult('B', 'b-out'),
    ]
    const relocated = relocateDisplacedToolResults(displaced)
    expect(relocated.map(message => {
      if (message.role === 'assistant') return 'assistant(tools)'
      if (message.content[0]?.type === 'tool-result') return 'result:' + message.content[0].toolCallId
      return 'user'
    })).toEqual(['assistant(tools)', 'result:A', 'user', 'assistant(tools)', 'result:B'])
  })

  it('sanitizes unpaired surrogates', () => {
    expect(sanitizeSurrogates('a\uD800b')).toBe('ab')
    expect(sanitizeSurrogates('\uDC00a')).toBe('a')
    expect(sanitizeSurrogates('emoji 🙈 ok')).toBe('emoji 🙈 ok')
  })

  it('truncates oversized tool results keeping head and tail', () => {
    const truncated = truncate('x'.repeat(300), 100)
    expect(truncated).toHaveLength(50 + '\n... [TRUNCATED] ...\n'.length + 50)
    expect(truncated.startsWith('x'.repeat(50))).toBe(true)
    expect(truncated.endsWith('x'.repeat(50))).toBe(true)
    expect(truncate('short', 100)).toBe('short')
  })

  it('converts tools and images to the wire shapes', () => {
    expect(convertToolsToKiro([{
      name: 't',
      description: 'd',
      parameters: { type: 'object' },
    }])).toEqual([{
      toolSpecification: { name: 't', description: 'd', inputSchema: { json: { type: 'object' } } },
    }])
    expect(convertImagesToKiro([{ mediaType: 'image/jpeg', data: 'QQ==' }])).toEqual([
      { format: 'jpeg', source: { bytes: 'QQ==' } },
    ])
  })

  it('encodes current-message images and strips history images', () => {
    const imageUser = createUserMessage({
      content: [
        { type: 'text', text: 'look' },
        {
          type: 'image',
          attachment: {
            attachmentId: 'sha256:' + 'a'.repeat(64) as unknown as import('@deepseek-ai/dsh-attachment').AttachmentId,
            mediaType: 'image/png',
            bytes: 3,
            width: 1,
            height: 1,
          },
        },
      ],
      source: { kind: 'user' },
    })
    const body = serializeKiroRequest(request({
      messages: [user('before'), imageUser],
    }), 'claude-sonnet-4.6', undefined, 200000, encoded())
    const history = body.conversationState.history!
    // History image stripped, text retained
    expect(history[0].userInputMessage!.images).toBeUndefined()
    expect(history[0].userInputMessage!.content).toBe('before')
    // Current message carries the image bytes
    expect(body.conversationState.currentMessage.userInputMessage.images).toEqual([
      { format: 'png', source: { bytes: 'AAAA' } },
    ])
  })

  it('throws a context-length error when history exceeds the model budget', () => {
    const bigText = 'x'.repeat(1_000_000)
    expect(() => serializeKiroRequest(request({
      messages: [user(bigText), user('now')],
    }), 'glm-5', undefined, 200_000)).toThrow('context_length_exceeded')
  })

  it('drops genuinely empty assistant turns and thinking-only turns stay on the wire', () => {
    const empty = createAssistantMessage({
      content: [],
      source: { provider: 'kiro', model: 'glm-5' },
    })
    const thinking = createAssistantMessage({
      content: [{ type: 'reasoning', text: 'think' }],
      source: { provider: 'kiro', model: 'glm-5' },
    })
    const body = serializeKiroRequest(request({
      messages: [empty, thinking, user('hi')],
    }), 'glm-5', undefined, 200000)
    // Both the empty turn and the thinking-only turn carry no text and no
    // tool uses, so sanitize drops them from the wire history.
    expect(body.conversationState.history).toBeUndefined()
    expect(body.conversationState.currentMessage.userInputMessage.content).toBe('hi')
  })
})