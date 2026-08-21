/**
 * Kiro model catalog: the bootstrap models this provider ships (mirroring the
 * kiro-cli-verified menu), the authenticated management catalog, and the
 * id/capacity/reasoning metadata the harness resolves per exact model. The
 * management cache file is shared with pi-provider-kiro so both tools see one
 * catalog.
 * @module dsh-llm-kiro/models
 */

import type { ModelModality } from '@deepseek-ai/dsh-llm'
import { getKiroEffortConfig, type KiroEffortConfig } from './effort.ts'
import {
  fetchKiroModelCatalog,
  isCacheStale as isCacheStaleEntry,
  KIRO_MANAGEMENT_CACHE_SOURCE,
  KIRO_MANAGEMENT_CACHE_VERSION,
  readManagementCache,
  type ManagementModelsCache,
  writeManagementCache,
} from './management.ts'
import type { KiroCatalogModel } from './types.ts'

/** One model this adapter advertises or resolves. */
export interface KiroModel {
  /** Harness model id (dashed form, e.g. claude-sonnet-4-6). */
  id: string
  /** Exact wire model id accepted by the Kiro runtime (dotted form). */
  kiroModelId: string
  /** Selector label. */
  name: string
  /** Whether the model exposes reasoning content. */
  reasoning: boolean
  /** Combined request/response context capacity in tokens. */
  contextWindow: number
  /** Per-request output cap in tokens. */
  maxTokens: number
  /** Accepted request modalities. */
  inputModalities: readonly ModelModality[]
  /** Timeout for the first stream event, when the model needs a longer one. */
  firstTokenTimeoutMs?: number
  /** Authenticated effort schema, when the catalog disclosed one. */
  additionalModelRequestFieldsSchema?: Record<string, unknown>
}

/** Default context capacity when the catalog discloses none. */
export const DEFAULT_CONTEXT_WINDOW = 200_000
/** Default output cap when the catalog discloses none. */
export const DEFAULT_MAX_TOKENS = 8_192

const ZERO_CONTEXT_WINDOW = 1_000_000

/** The bootstrap catalog, mirroring the kiro-cli-verified model menu. */
const BOOTSTRAP: Array<Omit<KiroModel, 'kiroModelId' | 'inputModalities'> & { inputModalities?: readonly ModelModality[]; kiroModelId: string }> = [
  { id: 'claude-opus-4-8', kiroModelId: 'claude-opus-4.8', name: 'Claude Opus 4.8', reasoning: true, contextWindow: ZERO_CONTEXT_WINDOW, maxTokens: 128000, firstTokenTimeoutMs: 180_000 },
  { id: 'claude-opus-4-7', kiroModelId: 'claude-opus-4.7', name: 'Claude Opus 4.7', reasoning: true, contextWindow: ZERO_CONTEXT_WINDOW, maxTokens: 128000, firstTokenTimeoutMs: 180_000 },
  { id: 'claude-opus-4-6', kiroModelId: 'claude-opus-4.6', name: 'Claude Opus 4.6', reasoning: true, contextWindow: ZERO_CONTEXT_WINDOW, maxTokens: 32768 },
  { id: 'claude-sonnet-5', kiroModelId: 'claude-sonnet-5', name: 'Claude Sonnet 5', reasoning: true, contextWindow: ZERO_CONTEXT_WINDOW, maxTokens: 65536 },
  { id: 'claude-sonnet-4-6', kiroModelId: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6', reasoning: true, contextWindow: ZERO_CONTEXT_WINDOW, maxTokens: 65536 },
  { id: 'claude-sonnet-4-5', kiroModelId: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5', reasoning: true, contextWindow: 200000, maxTokens: 65536 },
  { id: 'claude-sonnet-4', kiroModelId: 'claude-sonnet-4', name: 'Claude Sonnet 4', reasoning: true, contextWindow: 200000, maxTokens: 65536 },
  { id: 'claude-haiku-4-5', kiroModelId: 'claude-haiku-4.5', name: 'Claude Haiku 4.5', reasoning: false, contextWindow: 200000, maxTokens: 65536 },
  { id: 'claude-fable-5', kiroModelId: 'claude-fable-5', name: 'Claude Fable 5', reasoning: true, contextWindow: ZERO_CONTEXT_WINDOW, maxTokens: 65536 },
  { id: 'deepseek-3-2', kiroModelId: 'deepseek-3.2', name: 'DeepSeek 3.2', reasoning: true, contextWindow: 164000, maxTokens: 8192 },
  { id: 'minimax-m2-5', kiroModelId: 'minimax-m2.5', name: 'MiniMax M2.5', reasoning: false, contextWindow: 196000, maxTokens: 8192 },
  { id: 'minimax-m2-1', kiroModelId: 'minimax-m2.1', name: 'MiniMax M2.1', reasoning: false, contextWindow: 196000, maxTokens: 8192 },
  { id: 'glm-5', kiroModelId: 'glm-5', name: 'GLM 5', reasoning: true, contextWindow: 200000, maxTokens: 8192 },
  { id: 'qwen3-coder-next', kiroModelId: 'qwen3-coder-next', name: 'Qwen3 Coder Next', reasoning: true, contextWindow: 256000, maxTokens: 8192 },
  { id: 'auto', kiroModelId: 'auto', name: 'Auto', reasoning: true, contextWindow: ZERO_CONTEXT_WINDOW, maxTokens: 65536 },
]

/** The shipped bootstrap catalog, with modalities filled in. */
export const bootstrapKiroModels: readonly KiroModel[] = BOOTSTRAP.map(model => ({
  ...model,
  inputModalities: model.inputModalities ?? (model.id.startsWith('claude-') ? ['text', 'image'] as const : ['text'] as const),
}))

/** Known wire model ids: the bootstrap set, extended by discovery. */
export const KIRO_MODEL_IDS = new Set(bootstrapKiroModels.map(model => model.kiroModelId))

/** Convert a wire model id (claude-sonnet-4.6) to the harness id (claude-sonnet-4-6). */
export function toHarnessModelId(kiroModelId: string): string {
  return kiroModelId.replace(/(\d)\.(\d)/g, '$1-$2')
}

/** Humanize a dashed id into a display name. */
function humanizeModelId(modelId: string): string {
  return modelId
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/** Models with known reasoning-family fallback when the schema is absent. */
const REASONING_FAMILY_MARKERS = ['opus', 'sonnet', 'fable', 'coder', 'deepseek', 'gpt', 'glm', 'qwen']

/** Whether the id suggests a reasoning-capable family, used only pre-discovery. */
function hasReasoningFamilyFallback(modelId: string): boolean {
  const normalizedId = modelId.toLowerCase()
  return normalizedId === 'auto' || REASONING_FAMILY_MARKERS.some(marker => normalizedId.includes(marker))
}

/** Whether a value is a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Map an authenticated management catalog into harness models, merging
 * bootstrap metadata for known ids and deriving capacities and ladders from
 * the catalog's token limits and effort schema.
 * @param catalogModels - the authenticated catalog.
 * @param region - the Kiro API region the catalog was fetched from.
 * @returns the harness model list.
 * @throws Error when the catalog is empty or carries invalid ids.
 */
export function mapKiroCatalogModels(catalogModels: KiroCatalogModel[], region: string): KiroModel[] {
  if (catalogModels.length === 0) {
    throw new Error(`Kiro management catalog returned no models in ${region}`)
  }

  const seen = new Set<string>()
  return catalogModels.map(catalogModel => {
    const kiroModelId = catalogModel.modelId
    if (!kiroModelId || kiroModelId.trim() !== kiroModelId) {
      throw new Error(`Kiro management catalog returned an invalid model ID in ${region}`)
    }
    const id = toHarnessModelId(kiroModelId)
    if (seen.has(id)) {
      throw new Error(`Kiro management catalog contains conflicting model ID ${id} in ${region}`)
    }
    seen.add(id)

    const existing = bootstrapKiroModels.find(model => model.id === id)
    const schema = catalogModel.additionalModelRequestFieldsSchema ?? undefined
    if (schema !== undefined && !isRecord(schema)) {
      throw new Error(`Kiro management catalog model ${kiroModelId} has an invalid request-fields schema`)
    }
    const tokenLimits = catalogModel.tokenLimits
    if (tokenLimits !== undefined && !isRecord(tokenLimits)) {
      throw new Error(`Kiro management catalog model ${kiroModelId} has invalid token limits`)
    }
    const maxInputTokens = tokenLimits?.maxInputTokens
    const maxOutputTokens = tokenLimits?.maxOutputTokens
    if ((maxInputTokens !== undefined && (!Number.isFinite(maxInputTokens) || maxInputTokens <= 0))
      || (maxOutputTokens !== undefined && (!Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0))) {
      throw new Error(`Kiro management catalog model ${kiroModelId} has invalid token limits`)
    }
    const catalogName =
      typeof catalogModel.displayName === 'string' && catalogModel.displayName.length > 0
        ? catalogModel.displayName
        : undefined
    const isClaude = id.startsWith('claude-')
    const effortConfig = getKiroEffortConfig(schema, kiroModelId)

    return {
      id,
      kiroModelId,
      name: catalogName ?? existing?.name ?? humanizeModelId(id),
      reasoning:
        (schema !== undefined && effortConfig !== undefined) || (schema === undefined && hasReasoningFamilyFallback(id)),
      inputModalities: existing ? [...existing.inputModalities] : isClaude ? ['text', 'image'] as const : ['text'] as const,
      contextWindow: maxInputTokens ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: maxOutputTokens ?? DEFAULT_MAX_TOKENS,
      ...(existing?.firstTokenTimeoutMs ? { firstTokenTimeoutMs: existing.firstTokenTimeoutMs } : {}),
      ...(schema ? { additionalModelRequestFieldsSchema: schema } : {}),
    }
  })
}

/** Rebuild the known-id set from the bootstrap list plus every cached region. */
function refreshKnownModelIds(): void {
  KIRO_MODEL_IDS.clear()
  for (const model of bootstrapKiroModels) KIRO_MODEL_IDS.add(model.kiroModelId)
  const cache = readManagementCache()
  if (!cache) return
  for (const entry of Object.values(cache.regions)) {
    for (const model of entry.models) {
      if (typeof model.modelId === 'string') KIRO_MODEL_IDS.add(model.modelId)
    }
  }
}

/**
 * The current catalog for one region: the cached authenticated catalog, or
 * the bootstrap list when discovery has not run or the cache is absent.
 * @param region - the Kiro API region.
 * @returns the harness model list for that region.
 */
export function getCachedModels(region: string): KiroModel[] {
  const entry = readManagementCache()?.regions[region]
  if (!entry) return [...bootstrapKiroModels]
  const mapped = mapKiroCatalogModels(entry.models as unknown as KiroCatalogModel[], region)
  return mapped.length > 0 ? mapped : [...bootstrapKiroModels]
}

/**
 * Fetch and cache the authenticated catalog for one credential, merging with
 * the existing cache document.
 * @param accessToken - the bearer token.
 * @param region - the Kiro API region.
 * @param profileArn - an already-known profile ARN.
 */
export async function updateKiroModelsCache(accessToken: string, region: string, profileArn?: string): Promise<void> {
  const response = await fetchKiroModelCatalog({ accessToken, region }, profileArn)
  // The cache stores the raw catalog (wire modelId fields); reads map it.
  mapKiroCatalogModels(response.models, region)
  const existingCache = readManagementCache()
  const cache: ManagementModelsCache = existingCache ?? {
    version: KIRO_MANAGEMENT_CACHE_VERSION,
    source: KIRO_MANAGEMENT_CACHE_SOURCE,
    regions: {},
  }
  cache.regions[region] = {
    region,
    fetchedAt: Date.now(),
    models: response.models as unknown as Array<Record<string, unknown>>,
  }
  writeManagementCache(cache)
  refreshKnownModelIds()
}

/**
 * Resolve the exact wire model id for one harness model id. Catalog ids win;
 * unknown ids normalize dashes to dots and pass through only when discovery
 * has seen them.
 * @param modelId - the harness model id.
 * @returns the wire model id.
 * @throws Error when the model id is unknown everywhere.
 */
export function resolveKiroModelId(modelId: string): string {
  const bootstrap = bootstrapKiroModels.find(model => model.id === modelId)
  if (bootstrap) return bootstrap.kiroModelId

  refreshKnownModelIds()
  const normalizedId = modelId.replace(/(\d)-(\d)/g, '$1.$2')
  if (!KIRO_MODEL_IDS.has(normalizedId)) {
    throw new Error(`llm-kiro: unknown Kiro model id "${modelId}"`)
  }
  return normalizedId
}

/**
 * Whether one region's cached catalog is absent or stale.
 * @param region - the Kiro API region.
 * @returns true when a re-fetch is due.
 */
export function isCacheStale(region: string): boolean {
  return isCacheStaleEntry(region)
}

/** Resolve the effort config for one wire model id, schema first. */
export function kiroEffortFor(kiroModelId: string, schema?: Record<string, unknown>): KiroEffortConfig | undefined {
  return getKiroEffortConfig(schema, kiroModelId)
}