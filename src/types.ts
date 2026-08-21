/**
 * Kiro wire vocabulary: the runtime and management request/response types and
 * the resolved credential facts the adapter consumes. Types only — no runtime
 * code. The wire format is the AWS CodeWhisperer streaming protocol served by
 * the kiro.dev management and runtime endpoints; field names follow the wire.
 * @module dsh-llm-kiro/types
 */

/** Credential transport method backing one resolved Kiro credential. */
export type KiroAuthMethod = 'idc' | 'desktop'

/**
 * Resolved Kiro credential facts for one request. The packed `refresh` string
 * is `<refreshToken>|<clientId>|<clientSecret>|<authMethod>`; the pipe-delimited
 * form keeps one opaque value on the wire boundary while refresh still knows
 * which endpoint and client registration to use. `clientId`/`clientSecret`
 * are empty for desktop (social) tokens, which refresh through the Kiro
 * desktop endpoint instead of AWS SSO OIDC.
 */
export interface KiroCredentials {
  /** Bearer token sent on management and runtime requests. */
  access: string
  /** Packed refresh facts; see the interface docs. */
  refresh: string
  /** Absolute expiry of `access` in ms, already buffered for refresh lead time. */
  expires: number
  /** OIDC client registration id (idc tokens only). */
  clientId: string
  /** OIDC client registration secret (idc tokens only). */
  clientSecret: string
  /** Kiro API region the token authenticates in. */
  region: string
  /** Which transport produced the token; see {@link KiroAuthMethod}. */
  authMethod: KiroAuthMethod
  /** Profile ARN carried by the credential when the store disclosed one. */
  profileArn?: string
}

/** One image attached to a Kiro user message; bytes are base64. */
export interface KiroImage {
  /** Image format without the mime type prefix (png, jpeg, ...). */
  format: string
  /** Base64-encoded image bytes. */
  source: { bytes: string }
}

/** One tool invocation recorded on an assistant history message. */
export interface KiroToolUse {
  name: string
  toolUseId: string
  input: Record<string, unknown>
}

/** The result of one tool invocation, sent back inside a user message context. */
export interface KiroToolResult {
  content: Array<{ text: string }>
  status: 'success' | 'error'
  toolUseId: string
}

/** Tool schema declared on the current user message context. */
export interface KiroToolSpec {
  toolSpecification: { name: string; description: string; inputSchema: { json: Record<string, unknown> } }
}

/** Context carried by one current user message: tool results and/or the tool catalog. */
export interface KiroUserInputMessageContext {
  toolResults?: KiroToolResult[]
  tools?: KiroToolSpec[]
}

/** The current message of a Kiro conversation request. */
export interface KiroUserInputMessage {
  content: string
  modelId: string
  /** Origin token the kiro.dev backend accepts; always KIRO_CLI. */
  origin: 'KIRO_CLI'
  images?: KiroImage[]
  userInputMessageContext?: KiroUserInputMessageContext
}

/** One assistant turn of the conversation history. */
export interface KiroAssistantResponseMessage {
  content: string
  toolUses?: KiroToolUse[]
}

/**
 * One conversation history entry: exactly one of the two message slots is
 * present. Entries alternate user/assistant by construction.
 */
export interface KiroHistoryEntry {
  userInputMessage?: KiroUserInputMessage
  assistantResponseMessage?: KiroAssistantResponseMessage
}

/** Structured reasoning-effort fields understood by the Kiro runtime. */
export type KiroAdditionalModelRequestFields =
  | { reasoning: { effort: string } }
  | { output_config: { effort: string }; thinking: { type: 'adaptive'; display?: 'summarized' } }

/** Request body for POST {runtime}/generateAssistantResponse. */
export interface KiroRequest {
  conversationState: {
    chatTriggerType: 'MANUAL'
    agentTaskType: 'vibe'
    conversationId: string
    currentMessage: { userInputMessage: KiroUserInputMessage }
    history?: KiroHistoryEntry[]
  }
  additionalModelRequestFields?: KiroAdditionalModelRequestFields
  profileArn: string
  agentMode: 'vibe'
}

/** One parsed payload of the runtime event stream, before chunk translation. */
export type KiroStreamEvent =
  | { type: 'content'; data: string }
  | { type: 'thinkingText'; data: string }
  | { type: 'thinkingSignature'; data: string }
  | { type: 'toolUse'; data: { name: string; toolUseId: string; input: string; stop?: boolean } }
  | { type: 'toolUseInput'; data: { input: string } }
  | { type: 'toolUseStop'; data: { stop: boolean } }
  | { type: 'contextUsage'; data: { contextUsagePercentage: number } }
  | { type: 'followupPrompt'; data: string }
  | { type: 'usage'; data: { inputTokens?: number; outputTokens?: number } }
  | { type: 'error'; data: { error: string; message?: string } }

/** One model entry of the authenticated management catalog. */
export interface KiroCatalogModel {
  modelId: string
  displayName?: string
  tokenLimits?: {
    maxInputTokens?: number
    maxOutputTokens?: number
    [key: string]: unknown
  }
  additionalModelRequestFieldsSchema?: Record<string, unknown> | null
  [key: string]: unknown
}

/** Response of the List-Available-Models management operation. */
export interface KiroListAvailableModelsResponse {
  models: KiroCatalogModel[]
  [key: string]: unknown
}

/** Response of the List-Available-Profiles management operation. */
export interface KiroListAvailableProfilesResponse {
  profiles?: Array<{ arn?: string; [key: string]: unknown }>
}

/** Auth facts one management operation needs. */
export interface KiroManagementAuth {
  accessToken: string
  region: string
}
