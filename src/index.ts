/**
 * Register a {@link KiroAdapter} for the `kiro` provider route on `ctx.llm`,
 * with connection facts resolved per request instead of frozen at load: the
 * plugin layers its `cordis.yml` entry config under the optional
 * `llm-kiro` user-settings section (`ctx.settings`) and resolves the
 * credential through the ambient kiro-cli / Kiro IDE stores (with silent OAuth
 * refresh) or an optional credential reference (`ctx.credentials`), so a
 * changed region, catalog, or credential reaches the very next request
 * without restarting anything, while an in-flight stream keeps the facts it
 * started with.
 * @module @joshryandavis/dsh-llm-kiro
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { LlmError, resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { LlmDiscoveredModel, ModelModality, RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_FIRST_TOKEN_TIMEOUT_MS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  KiroAdapter,
  PROVIDER,
} from './adapter.ts'
import type { KiroConnectionOptions } from './adapter.ts'
import { DEFAULT_KIRO_REGION, getKiroRegionFromEndpoint, resolveApiRegion } from './endpoints.ts'
import { resolveUsableKiroCredential, recoverKiroCredential } from './refresh.ts'
import type { KiroStorePaths } from './kiro-cli.ts'
import { fetchKiroModelCatalog } from './management.ts'
import { bootstrapKiroModels, toHarnessModelId } from './models.ts'
import type { KiroModel } from './models.ts'
import type { KiroCredentials } from './types.ts'

export {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_FIRST_TOKEN_TIMEOUT_MS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  KiroAdapter,
  PROVIDER,
} from './adapter.ts'
export type { KiroAdapterOptions, KiroConnectionOptions } from './adapter.ts'
export type { KiroCredentials } from './types.ts'
export type * from './types.ts'

export const name = 'llm-kiro'
export const inject = ['llm']

const NS = settingsNamespace('llm-kiro')
const MODEL_MODALITIES = ['text', 'image'] as const satisfies readonly ModelModality[]

/** One advisory model entry accepted by configuration. */
export interface KiroModelConfig {
  /** Harness model id (dashed form, e.g. claude-sonnet-4-6). */
  id: string
  /** Exact wire model id; defaults to the dashed id with dots restored. */
  kiroModelId?: string
  /** Selector label; defaults to the bootstrap entry's name or the id. */
  name?: string
  /** Whether the model exposes reasoning content; defaults from the bootstrap entry. */
  reasoning?: boolean
  /** Combined context capacity in tokens; defaults from the bootstrap entry. */
  contextWindow?: number
  /** Per-request output cap; defaults from the bootstrap entry. */
  maxTokens?: number
  /** Accepted request modalities; defaults from the bootstrap entry. */
  inputModalities?: ModelModality[]
  /** First-event timeout override for this model. */
  firstTokenTimeoutMs?: number
}

/**
 * Plugin config, validated by the same-named schemastery schema and doubling
 * as the `llm-kiro` settings-section shape. Every field is optional in yml:
 * credentials come from the ambient kiro-cli / Kiro IDE stores when
 * `bearerTokenEnv` is absent, the region resolves from the credential, and
 * omitted reasoning effort resolves to `high`.
 */
export interface Config {
  /** Kiro API region; the credential's own region wins when omitted. */
  region?: string
  /** Runtime endpoint override (gateway/proxy deployments); defaults to the region's kiro.dev endpoint. */
  runtimeURL?: string
  /** Profile ARN override; management discovery fills in when omitted. */
  profileArn?: string
  /** Credential reference for a static bearer token, bypassing ambient discovery. */
  bearerTokenEnv?: string
  /** Deployment thinking policy; 'disabled' limits every conversation request to off. */
  thinking?: 'enabled' | 'disabled'
  /** Default thinking effort (default high); 'off' disables thinking per request. */
  reasoningEffort?: 'off' | 'low' | 'high' | 'max'
  /** Default per-request output cap (default 8,192); a model's own cap and explicit request values win. */
  maxTokens?: number
  /** Positive context capacity used when the selected model has no exact value (default 200,000). */
  defaultContextWindow?: number
  /** Advisory models shown by discovery consumers; defaults to the bootstrap catalog. */
  models?: KiroModelConfig[]
  /** Maximum provider idle time while one stream read is outstanding (default five minutes). */
  streamIdleTimeoutMs?: number
  /** Maximum time to the first stream event (default 90 seconds). */
  firstTokenTimeoutMs?: number
  /** Provider-owned model-request retry policy; omission uses normal mode with five retries. */
  retryPolicy?: RetryPolicyConfig
  /** kiro-cli database path override for non-standard homes. */
  kiroCliDbPath?: string
  /** AWS SSO cache directory override for the Kiro IDE token. */
  ssoCacheDir?: string
  /** Whether 403 recovery may shell out to kiro-cli (default true). */
  allowKiroCliRefresh?: boolean
}

const kiroModel: z<KiroModelConfig> = z.object({
  id: z.string().required(),
  kiroModelId: z.string(),
  name: z.string(),
  reasoning: z.boolean(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  inputModalities: z.array(z.union(MODEL_MODALITIES)).min(1).default(['text']),
  firstTokenTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS),
})

export const Config: z<Config> = z.object({
  region: z.string(),
  runtimeURL: z.string(),
  profileArn: z.string(),
  bearerTokenEnv: z.string().role('credential-ref'),
  thinking: z.union(['enabled', 'disabled']),
  reasoningEffort: z.union(['off', 'low', 'high', 'max']),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  models: z.array(kiroModel).default(bootstrapKiroModels.map(model => ({
    id: model.id,
    kiroModelId: model.kiroModelId,
    name: model.name,
    reasoning: model.reasoning,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    inputModalities: [...model.inputModalities],
    ...(model.firstTokenTimeoutMs !== undefined ? { firstTokenTimeoutMs: model.firstTokenTimeoutMs } : {}),
  }))),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  firstTokenTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_FIRST_TOKEN_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
  kiroCliDbPath: z.string(),
  ssoCacheDir: z.string(),
  allowKiroCliRefresh: z.boolean().default(true),
})

/** Resolve, validate, and detach the advisory model catalog, inheriting bootstrap defaults. */
function resolveModels(models: readonly KiroModelConfig[] | undefined): KiroModel[] {
  const seen = new Set<string>()
  const configured = (models ?? bootstrapKiroModels).map(model => {
    const bootstrap = bootstrapKiroModels.find(entry => entry.id === model.id)
    const wireId = model.kiroModelId
      ?? bootstrap?.kiroModelId
      ?? model.id.replace(/(\d)-(\d)/g, '$1.$2')
    if (model.id.length === 0) throw new Error('llm-kiro: catalog model ids must be non-empty')
    if (seen.has(model.id)) throw new Error(`llm-kiro: duplicate catalog model "${model.id}"`)
    seen.add(model.id)
    if (model.contextWindow !== undefined
      && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) {
      throw new Error(`llm-kiro: catalog model "${model.id}" contextWindow must be a positive integer`)
    }
    if (model.maxTokens !== undefined
      && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) {
      throw new Error(`llm-kiro: catalog model "${model.id}" maxTokens must be a positive integer`)
    }
    const firstTokenTimeoutMs = model.firstTokenTimeoutMs ?? bootstrap?.firstTokenTimeoutMs
    const inputModalities = model.inputModalities ?? bootstrap?.inputModalities ?? ['text']
    if (inputModalities.length === 0) {
      throw new Error(`llm-kiro: catalog model "${model.id}" inputModalities must not be empty`)
    }
    if (inputModalities.some(modality => !MODEL_MODALITIES.includes(modality))) {
      throw new Error(`llm-kiro: catalog model "${model.id}" inputModalities must contain only "text" and "image"`)
    }
    if (new Set(inputModalities).size !== inputModalities.length) {
      throw new Error(`llm-kiro: catalog model "${model.id}" inputModalities must not contain duplicates`)
    }
    return {
      id: model.id,
      kiroModelId: wireId,
      name: model.name ?? bootstrap?.name ?? model.id,
      reasoning: model.reasoning ?? bootstrap?.reasoning ?? false,
      contextWindow: model.contextWindow ?? bootstrap?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: model.maxTokens ?? bootstrap?.maxTokens ?? DEFAULT_MAX_TOKENS,
      inputModalities: [...inputModalities],
      ...(firstTokenTimeoutMs !== undefined ? { firstTokenTimeoutMs } : {}),
      ...(bootstrap?.additionalModelRequestFieldsSchema
        ? { additionalModelRequestFieldsSchema: bootstrap.additionalModelRequestFieldsSchema }
        : {}),
    }
  })
  return configured
}

/**
 * The one explicit resolve step from raw config to validated connection
 * facts. Programmatic construction may bypass Schemastery normalization, so
 * every default and bound is re-judged here.
 * @param config - raw plugin config or resolved settings snapshot.
 * @returns validated connection facts.
 */
export function resolveAdapterOptions(config: Config): KiroConnectionOptions {
  if (config.thinking === 'disabled'
    && config.reasoningEffort !== undefined
    && config.reasoningEffort !== 'off') {
    throw new Error('llm-kiro: only reasoningEffort "off" can be configured when thinking is disabled')
  }
  if (config.defaultContextWindow !== undefined
    && (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0)) {
    throw new Error('llm-kiro: defaultContextWindow must be a positive integer')
  }
  if (config.maxTokens !== undefined
    && (!Number.isSafeInteger(config.maxTokens) || config.maxTokens <= 0)) {
    throw new Error('llm-kiro: maxTokens must be a positive safe integer')
  }
  if (config.region !== undefined && config.region.trim().length === 0) {
    throw new Error('llm-kiro: region must be a non-empty string')
  }
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs)
    || streamIdleTimeoutMs <= 0
    || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `llm-kiro: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  const firstTokenTimeoutMs = config.firstTokenTimeoutMs ?? DEFAULT_FIRST_TOKEN_TIMEOUT_MS
  if (!Number.isFinite(firstTokenTimeoutMs)
    || firstTokenTimeoutMs <= 0
    || firstTokenTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `llm-kiro: firstTokenTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  const kiroStorePaths: KiroStorePaths | undefined =
    config.kiroCliDbPath !== undefined || config.ssoCacheDir !== undefined
      ? {
          ...(config.kiroCliDbPath !== undefined ? { dbPath: config.kiroCliDbPath } : {}),
          ...(config.ssoCacheDir !== undefined ? { ssoCacheDir: config.ssoCacheDir } : {}),
        }
      : undefined
  return {
    ...config.region !== undefined ? { region: config.region } : {},
    ...config.runtimeURL !== undefined ? { runtimeURL: config.runtimeURL } : {},
    ...config.profileArn !== undefined ? { profileArn: config.profileArn } : {},
    ...config.bearerTokenEnv !== undefined ? { bearerTokenEnv: credentialRef(config.bearerTokenEnv) } : {},
    models: resolveModels(config.models),
    maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    thinking: config.thinking ?? 'enabled',
    reasoningEffort: config.reasoningEffort ?? 'high',
    streamIdleTimeoutMs,
    firstTokenTimeoutMs,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-kiro: retryPolicy'),
    ...(kiroStorePaths ? { kiroStorePaths } : {}),
    allowKiroCliRefresh: config.allowKiroCliRefresh ?? true,
  }
}

/** The models this adapter knows today, as discovery metadata. */
function discoveredFromModels(models: readonly KiroModel[]): LlmDiscoveredModel[] {
  return models.map(model => ({
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  }))
}

export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  let lastRaw: Config | undefined
  let lastGood: KiroConnectionOptions | undefined
  const options = (): KiroConnectionOptions => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const next = resolveAdapterOptions(raw)
      lastRaw = raw
      lastGood = next
      return next
    } catch (error) {
      if (lastGood === undefined) throw error
      lastRaw = raw
      ctx.logger.error('llm-kiro: keeping the last good configuration after an invalid settings section')
      ctx.logger.error(error)
      return lastGood
    }
  }
  options()

  const resolveAmbientCredential = async (connection: KiroConnectionOptions): Promise<KiroCredentials> => {
    const credential = await resolveUsableKiroCredential(connection.kiroStorePaths)
    if (!credential) {
      throw new LlmError(
        `llm-kiro: no Kiro credentials for provider route "${PROVIDER}"; sign in with kiro-cli (run 'kiro-cli login')`
        + ' or the Kiro IDE, or configure bearerTokenEnv in the llm-kiro settings section',
        'MISSING_CREDENTIAL',
      )
    }
    return credential
  }

  const resolveCredential = async (connection: KiroConnectionOptions): Promise<KiroCredentials> => {
    if (connection.bearerTokenEnv === undefined) return resolveAmbientCredential(connection)
    const ref = connection.bearerTokenEnv
    const credentials = ctx.get('credentials')
    let value: string | undefined
    if (credentials !== undefined) {
      value = (await credentials.resolve(ref))?.value
    } else {
      value = launchEnvironmentOf(ctx).get(ref)?.value
    }
    if (value === undefined || value.length === 0) {
      throw new LlmError(
        `llm-kiro: no bearer token for provider route "${PROVIDER}"; store ${ref} through the credentials`
        + ' service (the web Models page writes it), or export it in the launching environment',
        'MISSING_CREDENTIAL',
      )
    }
    return {
      access: value.trim(),
      refresh: '',
      expires: Number.POSITIVE_INFINITY,
      clientId: '',
      clientSecret: '',
      region: resolveApiRegion(connection.region),
      authMethod: 'idc',
      ...(connection.profileArn ? { profileArn: connection.profileArn } : {}),
    }
  }

  const recoverCredential = async (
    rejected: KiroCredentials,
    connection: KiroConnectionOptions,
  ): Promise<KiroCredentials | undefined> => {
    if (connection.bearerTokenEnv !== undefined) return undefined
    return recoverKiroCredential(rejected, connection.kiroStorePaths, connection.allowKiroCliRefresh)
  }

  const adapter = new KiroAdapter({
    options,
    resolveCredential,
    recoverCredential,
    resolveAttachments: () => ctx.get('attachments'),
  })
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'Kiro', settingsNs: NS, settingsPath: [] },
  ])
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  let registeredPolicy = options().retryPolicy
  const ensureRegistrationFacts = (): void => {
    const policy = options().retryPolicy
    if (deepEqualJson(policy, registeredPolicy)) return
    registration.replace([PROVIDER])
    registeredPolicy = policy
  }

  // Interrogating an endpoint is a configuration-time action over a draft. A
  // draft naming the kiro route answers from the adapter's own knowledge; a
  // draft with an endpoint and a key interrogates the management API once.
  ctx.llm.registerModelDiscovery(NS, async request => {
    if (request.provider === PROVIDER) return discoveredFromModels(options().models)
    const apiKey = request.apiKey ?? (await resolveCredential(options())).access
    const region = request.baseURL !== undefined
      ? getKiroRegionFromEndpoint(request.baseURL) ?? DEFAULT_KIRO_REGION
      : resolveApiRegion(options().region)
    const catalog = await fetchKiroModelCatalog({ accessToken: apiKey, region })
    return catalog.models.map(model => ({
      id: toHarnessModelId(model.modelId),
      ...(typeof model.displayName === 'string' && model.displayName.length > 0 ? { name: model.displayName } : {}),
      ...(model.tokenLimits?.maxInputTokens !== undefined ? { contextWindow: model.tokenLimits.maxInputTokens } : {}),
      ...(model.tokenLimits?.maxOutputTokens !== undefined ? { maxTokens: model.tokenLimits.maxOutputTokens } : {}),
    }))
  })

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source
    },
    onChange: ensureRegistrationFacts,
  })
}
