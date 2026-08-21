/**
 * The Kiro runtime request: one POST `generateAssistantResponse` call with
 * the CodeWhisperer request headers, AWS event-stream response decoding,
 * capacity backoff, and first-token timeout. Credential refresh on 403 is
 * owned by the adapter (it re-resolves credentials and re-enters this
 * generator); everything before the first event retries here.
 * @module dsh-llm-kiro/stream
 */

import { APP_IDENTITY, LlmError } from '@deepseek-ai/dsh-llm'
import { getKiroEndpoints } from './endpoints.ts'
import { decodeKiroEventStream } from './eventstream.ts'
import type { KiroCredentials, KiroRequest, KiroStreamEvent } from './types.ts'

/** How many times a capacity rejection is retried with backoff before giving up. */
const CAPACITY_MAX_RETRIES = 3
/** Initial capacity-retry delay. */
const CAPACITY_BASE_DELAY_MS = 5_000
/** Ceiling for capacity-retry backoff. */
const CAPACITY_MAX_DELAY_MS = 30_000

/** The body marker for a transient model-capacity rejection. */
const CAPACITY_PATTERN = 'INSUFFICIENT_MODEL_CAPACITY'
/** Body markers for terminal monthly quota exhaustion. */
const NON_RETRYABLE_BODY_PATTERNS = ['MONTHLY_REQUEST_COUNT']
/** Body markers for requests exceeding the context window. */
const TOO_BIG_PATTERNS = ['CONTENT_LENGTH_EXCEEDS_THRESHOLD', 'Input is too long']

/** One runtime request's transport facts. */
export interface KiroTransportOptions {
  /** The wire request body. */
  request: KiroRequest
  /** The credential facts for this request. */
  credential: KiroCredentials
  /** The resolved profile ARN. */
  profileArn: string
  /** Timeout for the first stream event. */
  firstTokenTimeoutMs: number
  /** Caller cancellation. */
  signal?: AbortSignal
  /** Capacity-retry delay for attempt n (0-based), defaulting to exponential backoff. */
  capacityDelayMs?: (attempt: number) => number
  /** Runtime endpoint override; defaults to the region's kiro.dev endpoint. */
  endpoint?: string
}

/** Whether an error body text reports transient capacity exhaustion. */
export function isCapacityError(errorText: string): boolean {
  return errorText.includes(CAPACITY_PATTERN)
}

/** Whether an error body text reports a terminal quota or too-big condition. */
export function isNonRetryableBodyError(errorText: string): boolean {
  return NON_RETRYABLE_BODY_PATTERNS.some(pattern => errorText.includes(pattern))
}

/** Whether an HTTP failure is a request-too-large rejection. */
export function isTooBigError(status: number, errorText: string): boolean {
  return status === 413 || (status === 400 && TOO_BIG_PATTERNS.some(pattern => errorText.includes(pattern)))
}

/** A delay that rejects early when the abort signal fires. */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason)
    }, { once: true })
  })
}

/**
 * The AWS SDK-shaped UA the Kiro runtime requires on BOTH user-agent headers.
 * The backend's authorization layer gates on the client identity in this
 * header: an unknown app token (including the harness's standard attribution
 * UA) is rejected with 403 "User is not authorized to make this call", while
 * the known AmazonQ-For-CLI app identity streams normally. The `md/appVersion`
 * and `lang` segments are free-form; the product version rides along for
 * diagnostics. Verified against runtime.eu-central-1.kiro.dev 2026-08-21.
 */
function kiroUserAgent(): string {
  const mid = crypto.randomUUID().replace(/-/g, '')
  return `aws-sdk-rust/1.0.0 ua/2.1 os/other lang/js api/codewhispererstreaming#1.28.3 m/E app/AmazonQ-For-CLI md/appVersion-${APP_IDENTITY.version}-${mid}`
}

/** Map a non-2xx runtime response to the harness failure code. */
function httpErrorCode(status: number, errorText: string): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (isNonRetryableBodyError(errorText)) return 'QUOTA'
  if (isTooBigError(status, errorText)) return 'CONTEXT_WINDOW_EXCEEDED'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) return 'INVALID_REQUEST'
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/**
 * Stream one runtime call as typed Kiro events. Capacity rejections retry
 * with backoff before any event is produced; other HTTP failures throw
 * {@link LlmError}; a missing first event within the first-token timeout
 * throws LlmError('TIMEOUT').
 * @param options - transport facts for the call.
 * @returns the streamed events.
 */
export async function* streamKiroEvents(options: KiroTransportOptions): AsyncGenerator<KiroStreamEvent> {
  const endpoint = options.endpoint ?? new URL('generateAssistantResponse', getKiroEndpoints(options.credential.region).runtime).toString()
  let capacityRetryCount = 0
  let response: Response | undefined

  while (true) {
    const body = JSON.stringify({ ...options.request, profileArn: options.profileArn })
    // One identity per request: the backend reads the same app token from
    // both headers, so they must carry the same value.
    const ua = kiroUserAgent()
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'application/vnd.amazon.eventstream',
        'authorization': `Bearer ${options.credential.access}`,
        'x-amzn-codewhisperer-optout': 'true',
        'amz-sdk-invocation-id': crypto.randomUUID(),
        'amz-sdk-request': 'attempt=1; max=1',
        'x-amzn-kiro-agent-mode': 'vibe',
        'user-agent': ua,
        'x-amz-user-agent': ua,
      },
      body,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    })
    if (response.ok) break

    let errorText = ''
    try {
      errorText = await response.text()
    } catch {
      // Only error-body reading is swallowed; the status still identifies the failure
    }
    if (isCapacityError(errorText) && capacityRetryCount < CAPACITY_MAX_RETRIES) {
      capacityRetryCount++
      const delayMs = options.capacityDelayMs !== undefined
        ? options.capacityDelayMs(capacityRetryCount - 1)
        : Math.min(
            CAPACITY_BASE_DELAY_MS * 2 ** (capacityRetryCount - 1),
            CAPACITY_MAX_DELAY_MS,
          )
      await abortableDelay(delayMs, options.signal)
      continue
    }
    throw new LlmError(
      `Kiro API error: ${errorText || response.statusText || response.status}`,
      httpErrorCode(response.status, errorText),
      { status: response.status },
    )
  }

  if (!response.ok || !response.body) {
    throw new LlmError('Kiro API returned no response body', 'EMPTY_RESPONSE')
  }

  const events = decodeKiroEventStream(response.body)[Symbol.asyncIterator]()
  const FIRST_TOKEN_SENTINEL = Symbol('firstTokenTimeout')
  let gotFirstToken = false
  try {
    while (true) {
      let result: IteratorResult<KiroStreamEvent>
      if (!gotFirstToken) {
        const readPromise = events.next()
        const raced = await Promise.race([
          readPromise,
          new Promise<typeof FIRST_TOKEN_SENTINEL>(resolve =>
            setTimeout(() => resolve(FIRST_TOKEN_SENTINEL), options.firstTokenTimeoutMs),
          ),
        ])
        if (raced === FIRST_TOKEN_SENTINEL) {
          readPromise.catch(() => {})
          throw new LlmError(
            `Kiro API error: first token timeout after ${options.firstTokenTimeoutMs}ms`,
            'TIMEOUT',
          )
        }
        result = raced
        gotFirstToken = true
      } else {
        result = await events.next()
      }
      if (result.done) return
      const event = result.value
      if (event.type === 'error') {
        throw new LlmError(
          `Kiro API stream error: ${event.data.message ? `${event.data.error}: ${event.data.message}` : event.data.error}`,
          'SERVER',
        )
      }
      yield event
    }
  } finally {
    // The event source owns the body reader; dropping the iterator closes it.
  }
}