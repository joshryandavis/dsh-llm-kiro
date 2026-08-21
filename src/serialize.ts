/**
 * Serialize harness conversation state into the Kiro runtime request. The
 * Kiro wire keeps an alternating user/assistant history whose entries carry
 * tool calls and tool results in their message contexts; this module rebuilds
 * that shape from harness messages, relocating displaced tool results,
 * merging adjacent same-role turns, stripping history images, and completing
 * the tool catalog with placeholder specs for tools referenced by history.
 * @module dsh-llm-kiro/serialize
 */

import type { GenerateOptions, Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ToolCallBlock } from '@deepseek-ai/dsh-llm'
import type {
  KiroAssistantResponseMessage,
  KiroHistoryEntry,
  KiroImage,
  KiroRequest,
  KiroToolResult,
  KiroToolSpec,
  KiroToolUse,
  KiroUserInputMessage,
  KiroUserInputMessageContext,
} from './types.ts'

/** Kiro's own non-empty-message invariant: a user message has content or tool results. */
export const EMPTY_CONTENT_PLACEHOLDER = 'Please proceed with the task.'

/** Per-tool-result character cap; longer results are truncated head and tail. */
export const TOOL_RESULT_LIMIT = 250_000

/** History character budget at the reference 200k context window, scaled per model. */
export const HISTORY_LIMIT = 850_000
/** The context window size HISTORY_LIMIT was calibrated for. */
export const HISTORY_LIMIT_CONTEXT_WINDOW = 200_000

/** One image encoded for the wire, resolved through the attachment store. */
export interface EncodedKiroImage {
  mediaType: string
  data: string
}

/** Whether one message is a tool-result carrier. */
export function isToolResultMessage(message: Message): boolean {
  return message.role === 'user' && firstToolResultBlock(message) !== undefined
}

/** The first tool-result block of one message, when it carries one. */
function firstToolResultBlock(message: Message): Extract<ContentBlock, { type: 'tool-result' }> | undefined {
  return message.content.find((block): block is Extract<ContentBlock, { type: 'tool-result' }> => block.type === 'tool-result')
}

/** Remove unpaired surrogates that would corrupt the wire JSON. */
export function sanitizeSurrogates(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
}

/** Truncate one tool result to the wire limit, keeping head and tail. */
export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text
  const half = Math.floor(limit / 2)
  return `${text.substring(0, half)}\n... [TRUNCATED] ...\n${text.substring(text.length - half)}`
}

/** Join the text blocks of one block list; reasoning and images are excluded. */
function blocksText(blocks: readonly ContentBlock[]): string {
  return blocks.map(block => (block.type === 'text' ? block.text : '')).join('')
}

/** Join the text blocks of one message. */
export function getContentText(message: Message): string {
  return blocksText(message.content)
}

/** Extract image blocks from one message, including those nested in tool results. */
function extractImageBlocks(message: Message): Extract<ContentBlock, { type: 'image' }>[] {
  const images: Array<Extract<ContentBlock, { type: 'image' }>> = []
  for (const block of message.content) {
    if (block.type === 'image') images.push(block)
    else if (block.type === 'tool-result') {
      for (const nested of block.content) if (nested.type === 'image') images.push(nested)
    }
  }
  return images
}

/** Convert encoded image payloads into wire image payloads. */
export function convertImagesToKiro(images: Array<{ mediaType: string; data: string }>): KiroImage[] {
  return images.map(image => ({
    format: image.mediaType.split('/')[1] || 'png',
    source: { bytes: image.data },
  }))
}

/**
 * Extract image blocks from one message and encode them through the
 * pre-resolved payload map; history images were stripped by the caller.
 * @param message - the harness message.
 * @param encodedImages - encoded payloads keyed by attachment id.
 * @returns the wire image payloads.
 * @throws Error when an image block has no encoded payload (the caller
 * resolved every block this conversation references).
 */
function extractImages(message: Message, encodedImages: ReadonlyMap<string, EncodedKiroImage> | undefined): KiroImage[] {
  const payloads: KiroImage[] = []
  for (const block of extractImageBlocks(message)) {
    const encoded = encodedImages?.get(block.attachment.attachmentId)
    if (!encoded) {
      throw new Error(`llm-kiro: no encoded payload for attachment ${block.attachment.attachmentId}`)
    }
    payloads.push(...convertImagesToKiro([encoded]))
  }
  return payloads
}

/** Convert harness tool schemas into the wire tool catalog. */
export function convertToolsToKiro(tools: readonly ToolSchema[]): KiroToolSpec[] {
  return tools.map(tool => ({
    toolSpecification: {
      name: tool.name,
      description: tool.description,
      inputSchema: { json: tool.parameters },
    },
  }))
}

/**
 * Move each tool result to sit immediately after the assistant turn that
 * issued its tool call, matching by call id. Interleaved concurrent tool
 * executions can otherwise place a result behind a later assistant turn, a
 * shape the Kiro backend rejects with TOOL_USE_RESULT_MISMATCH.
 * @param messages - the harness conversation.
 * @returns the conversation with displaced results reordered.
 */
export function relocateDisplacedToolResults(messages: Message[]): Message[] {
  const out: Message[] = []
  const pending = [...messages]
  while (pending.length > 0) {
    const msg = pending.shift() as Message
    out.push(msg)
    if (msg.role !== 'assistant') continue
    for (const block of msg.content) {
      if (block.type !== 'tool-call') continue
      const id = (block as ToolCallBlock).id
      const at = pending.findIndex(candidate => firstToolResultBlock(candidate)?.toolCallId === id)
      if (at >= 0) out.push(...pending.splice(at, 1))
    }
  }
  return out
}

/** Convert one tool-result block into the wire result, truncating its text. */
function toKiroToolResult(block: Extract<ContentBlock, { type: 'tool-result' }>): KiroToolResult {
  return {
    content: [{ text: truncate(blocksText(block.content), TOOL_RESULT_LIMIT) }],
    status: block.isError ? 'error' : 'success',
    toolUseId: block.toolCallId,
  }
}

/** Parse one tool call's raw JSON arguments; malformed model output degrades to an empty object. */
function parseToolArguments(block: ToolCallBlock): Record<string, unknown> {
  try {
    const parsed = JSON.parse(block.arguments) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

/**
 * Convert one assistant message into the wire assistant entry. Reasoning is
 * deliberately not serialized into the text channel; a turn that carried only
 * reasoning stays on the wire with empty content, and only a genuinely empty
 * turn drops (undefined).
 * @param message - the harness assistant message.
 * @returns the wire entry, or undefined when the turn carried nothing.
 */
function toKiroAssistant(message: Message): KiroAssistantResponseMessage | undefined {
  let armContent = ''
  const armToolUses: KiroToolUse[] = []
  let armHadBlocks = false
  for (const block of message.content) {
    if (block.type === 'text') {
      armContent += block.text
      armHadBlocks = true
    } else if (block.type === 'reasoning') {
      armHadBlocks = true
    } else if (block.type === 'tool-call') {
      armToolUses.push({
        name: block.name,
        toolUseId: block.id,
        input: parseToolArguments(block),
      })
      armHadBlocks = true
    }
  }
  if (!armContent && armToolUses.length === 0 && !armHadBlocks) return undefined
  return {
    content: armContent,
    ...(armToolUses.length > 0 ? { toolUses: armToolUses } : {}),
  }
}

/**
 * Build the wire history and identify the current message group. The system
 * prompt is prepended to the first user message of the conversation, which is
 * the only place the Kiro wire can carry it.
 * @param messages - the harness conversation (results already relocated).
 * @param wireModelId - the exact wire model id.
 * @param system - the effective system prompt (thinking markers included).
 * @param encodedImages - encoded image payloads keyed by attachment id.
 * @returns the history entries, whether the system prompt was prepended, and
 * the index of the first message of the current group.
 */
export function buildHistory(
  messages: Message[],
  wireModelId: string,
  system?: string,
  encodedImages?: ReadonlyMap<string, EncodedKiroImage>,
): { history: KiroHistoryEntry[]; systemPrepended: boolean; currentMsgStartIdx: number } {
  const history: KiroHistoryEntry[] = []
  let systemPrepended = false
  const withSystem = (content: string): string => {
    if (!system || systemPrepended) return content
    systemPrepended = true
    return `${system}\n\n${content}`
  }

  let currentMsgStartIdx = messages.length - 1
  while (currentMsgStartIdx > 0) {
    const current = messages[currentMsgStartIdx]
    if (current === undefined || !isToolResultMessage(current)) break
    currentMsgStartIdx--
  }
  const current = messages[currentMsgStartIdx]
  if (current?.role === 'assistant'
    && !current.content.some(block => block.type === 'tool-call')) {
    currentMsgStartIdx++
  }

  const historyMessages = messages.slice(0, currentMsgStartIdx)

  for (let i = 0; i < historyMessages.length; i++) {
    const msg = historyMessages[i]
    if (msg === undefined) continue
    if (isToolResultMessage(msg)) {
      const toolResults: KiroToolResult[] = []
      let j = i
      while (j < historyMessages.length) {
        const carrier = historyMessages[j]
        if (carrier === undefined || !isToolResultMessage(carrier)) break
        for (const block of toolResultBlocks(carrier)) toolResults.push(toKiroToolResult(block))
        j++
      }
      i = j - 1
      const lastEntryForTr = history[history.length - 1]
      const prevTr = lastEntryForTr?.userInputMessage
      if (prevTr) {
        if (!prevTr.userInputMessageContext) prevTr.userInputMessageContext = {}
        prevTr.userInputMessageContext.toolResults = [
          ...(prevTr.userInputMessageContext.toolResults ?? []),
          ...toolResults,
        ]
      } else {
        history.push({
          userInputMessage: {
            content: '',
            modelId: wireModelId,
            origin: 'KIRO_CLI',
            userInputMessageContext: { toolResults },
          },
        })
      }
    } else if (msg.role === 'user') {
      const content = withSystem(getContentText(msg))
      const images = extractImages(msg, encodedImages)
      const uim: KiroUserInputMessage = {
        content: sanitizeSurrogates(content),
        modelId: wireModelId,
        origin: 'KIRO_CLI',
        ...(images.length > 0 ? { images } : {}),
      }
      const lastEntryForUim = history[history.length - 1]
      const prevUim = lastEntryForUim?.userInputMessage
      if (prevUim) {
        // Merge consecutive user turns into one entry to keep alternation.
        prevUim.content = prevUim.content && uim.content ? `${prevUim.content}\n\n${uim.content}` : prevUim.content || uim.content
        if (uim.images) prevUim.images = [...(prevUim.images ?? []), ...uim.images]
      } else {
        history.push({ userInputMessage: uim })
      }
    } else {
      const arm = toKiroAssistant(msg)
      if (!arm) continue
      history.push({ assistantResponseMessage: arm })
    }
  }
  return { history, systemPrepended, currentMsgStartIdx }
}

/** Tool-result blocks inside one message, flattened. */
function toolResultBlocks(message: Message): Array<Extract<ContentBlock, { type: 'tool-result' }>> {
  return message.content.filter((block): block is Extract<ContentBlock, { type: 'tool-result' }> => block.type === 'tool-result')
}

/** Every tool name referenced by the history's assistant entries. */
function extractToolNamesFromHistory(history: KiroHistoryEntry[]): Set<string> {
  const names = new Set<string>()
  for (const entry of history) {
    for (const tu of entry.assistantResponseMessage?.toolUses ?? []) {
      if (tu.name) names.add(tu.name)
    }
  }
  return names
}

/**
 * Complete the wire tool catalog with placeholder specs for tool names the
 * history references but the request does not declare; the backend rejects a
 * history that uses tools with no catalog entry.
 * @param tools - the declared tool catalog.
 * @param history - the wire history entries.
 * @returns the completed catalog.
 */
export function addPlaceholderTools(tools: KiroToolSpec[], history: KiroHistoryEntry[]): KiroToolSpec[] {
  const historyNames = extractToolNamesFromHistory(history)
  if (historyNames.size === 0) return tools
  const existing = new Set(tools.map(tool => tool.toolSpecification?.name).filter(Boolean))
  const missing = Array.from(historyNames).filter(name => !existing.has(name))
  if (missing.length === 0) return tools
  return [
    ...tools,
    ...missing.map(name => ({
      toolSpecification: {
        name,
        description: 'Tool',
        inputSchema: { json: { type: 'object' as const, properties: {} } },
      },
    })),
  ]
}

/** Strip images from history entries; earlier turns already processed them. */
export function stripHistoryImages(history: KiroHistoryEntry[]): KiroHistoryEntry[] {
  return history.map(entry => {
    const uim = entry.userInputMessage
    if (!uim?.images) return entry
    const { images: _images, ...rest } = uim
    return { ...entry, userInputMessage: rest }
  })
}

/**
 * Sanitize the wire history against the backend's structural rules: strip a
 * leading entry that would open with tool results, drop assistant entries
 * with neither content nor tool uses, and pair tool-result carriers with the
 * assistant that issued them.
 * @param history - the built history entries.
 * @returns the sanitized entries.
 */
export function sanitizeHistory(history: KiroHistoryEntry[]): KiroHistoryEntry[] {
  let sanitized = history
  while (
    sanitized.length > 0
    && (!sanitized[0]?.userInputMessage || sanitized[0].userInputMessage.userInputMessageContext?.toolResults)
  ) {
    sanitized = sanitized.slice(1)
  }
  const result: KiroHistoryEntry[] = []
  for (let i = 0; i < sanitized.length; i++) {
    const m = sanitized[i]
    if (!m) continue
    if (m.assistantResponseMessage && !m.assistantResponseMessage.toolUses && !m.assistantResponseMessage.content) {
      continue
    }
    if (m.assistantResponseMessage?.toolUses) {
      const next = sanitized[i + 1]
      if (next?.userInputMessage?.userInputMessageContext?.toolResults) result.push(m)
    } else if (m.userInputMessage?.userInputMessageContext?.toolResults) {
      const prev = result[result.length - 1]
      if (prev?.assistantResponseMessage?.toolUses) result.push(m)
    } else {
      result.push(m)
    }
  }
  return result
}

/** Synthesize tool uses for tool results whose issuing assistant is absent. */
export function injectSyntheticToolCalls(history: KiroHistoryEntry[]): KiroHistoryEntry[] {
  const validIds = new Set<string>()
  for (const entry of history) {
    for (const tu of entry.assistantResponseMessage?.toolUses ?? []) {
      if (tu.toolUseId) validIds.add(tu.toolUseId)
    }
  }
  const result: KiroHistoryEntry[] = []
  for (const entry of history) {
    const toolResults = entry.userInputMessage?.userInputMessageContext?.toolResults
    if (toolResults) {
      const orphaned = toolResults.filter(toolResult => !validIds.has(toolResult.toolUseId))
      if (orphaned.length > 0) {
        result.push({
          assistantResponseMessage: {
            content: 'Tool calls were made.',
            toolUses: orphaned.map(toolResult => ({ name: 'unknown_tool', toolUseId: toolResult.toolUseId, input: {} })),
          },
        })
        for (const toolResult of orphaned) validIds.add(toolResult.toolUseId)
      }
    }
    result.push(entry)
  }
  return result
}

/** Prepare the built history for the wire. */
export function prepareHistory(history: KiroHistoryEntry[]): KiroHistoryEntry[] {
  return injectSyntheticToolCalls(sanitizeHistory(stripHistoryImages(history)))
}

/**
 * Serialize one conversation into the Kiro runtime request body. The returned
 * body's `profileArn` is empty; the adapter fills it after credential and
 * profile resolution.
 * @param options - the harness request.
 * @param wireModelId - the exact wire model id.
 * @param system - the effective system prompt (thinking markers included).
 * @param contextWindow - the model's context capacity, for the history budget.
 * @param optionsImages - encoded image payloads keyed by attachment id.
 * @returns the wire request body.
 * @throws Error with a context_length_exceeded message when history exceeds the budget.
 */
export function serializeKiroRequest(
  options: GenerateOptions,
  wireModelId: string,
  system: string | undefined,
  contextWindow: number,
  optionsImages?: ReadonlyMap<string, EncodedKiroImage>,
): KiroRequest {
  const normalized = relocateDisplacedToolResults(options.messages)
  const { history: rawHistory, systemPrepended, currentMsgStartIdx } = buildHistory(normalized, wireModelId, system, optionsImages)
  const history = prepareHistory(rawHistory)
  const dynamicHistoryLimit = Math.floor((contextWindow / HISTORY_LIMIT_CONTEXT_WINDOW) * HISTORY_LIMIT)
  const size = JSON.stringify(history).length
  if (size > dynamicHistoryLimit) {
    throw new Error(
      `Kiro API error: context_length_exceeded (local history ${size} chars exceeds the ${dynamicHistoryLimit}-char limit)`,
    )
  }

  const currentMessages = normalized.slice(currentMsgStartIdx)
  const firstMsg = currentMessages[0]
  let currentContent = ''
  const currentToolResults: KiroToolResult[] = []
  let currentImages: KiroImage[] | undefined
  const encodedImages = optionsImages

  const collectToolResults = (messages: Message[]): void => {
    for (const message of messages) {
      if (!isToolResultMessage(message)) continue
      for (const block of toolResultBlocks(message)) currentToolResults.push(toKiroToolResult(block))
      const images = extractImages(message, encodedImages)
      if (images.length > 0) {
        currentImages = currentImages ? [...currentImages, ...images] : images
      }
    }
  }

  if (firstMsg?.role === 'assistant') {
    // The current assistant turn is outbound history too; its tool results
    // are the payload of this request.
    const arm = toKiroAssistant(firstMsg)
    if (arm) {
      const lastEntryForArm = history[history.length - 1]
      const prevArm = lastEntryForArm?.assistantResponseMessage
      if (history.length > 0 && !lastEntryForArm?.userInputMessage && prevArm) {
        prevArm.content = prevArm.content && arm.content ? `${prevArm.content}\n\n${arm.content}` : prevArm.content || arm.content
        if (arm.toolUses) prevArm.toolUses = [...(prevArm.toolUses ?? []), ...arm.toolUses]
      } else {
        history.push({ assistantResponseMessage: arm })
      }
    }
    collectToolResults(currentMessages.slice(1))
  } else if (firstMsg && isToolResultMessage(firstMsg)) {
    collectToolResults(currentMessages)
  } else if (firstMsg?.role === 'user') {
    const content = getContentText(firstMsg)
    currentContent = system && !systemPrepended ? `${system}\n\n${content}` : content
    const images = extractImages(firstMsg, encodedImages)
    if (images.length > 0) currentImages = images
    // Defensive: tool results trailing a plain user message still reach the payload.
    collectToolResults(currentMessages.slice(1))
  }
  if (currentContent === '' && currentToolResults.length === 0) currentContent = EMPTY_CONTENT_PLACEHOLDER

  const baseTools = convertToolsToKiro(options.tools ?? [])
  const finalTools = history.length > 0 ? addPlaceholderTools(baseTools, history) : baseTools
  let uimc: KiroUserInputMessageContext | undefined
  if (currentToolResults.length > 0 || finalTools.length > 0) {
    uimc = {}
    if (currentToolResults.length > 0) uimc.toolResults = currentToolResults
    if (finalTools.length > 0) uimc.tools = finalTools
  }

  return {
    conversationState: {
      chatTriggerType: 'MANUAL',
      agentTaskType: 'vibe',
      conversationId: options.sessionId ?? crypto.randomUUID(),
      currentMessage: {
        userInputMessage: {
          content: sanitizeSurrogates(currentContent),
          modelId: wireModelId,
          origin: 'KIRO_CLI',
          ...(currentImages ? { images: currentImages } : {}),
          ...(uimc ? { userInputMessageContext: uimc } : {}),
        },
      },
      ...(history.length > 0 ? { history } : {}),
    },
    profileArn: '',
    agentMode: 'vibe',
  }
}
