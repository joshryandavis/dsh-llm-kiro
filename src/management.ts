/**
 * Kiro management control plane: resolves the profile ARN and the model
 * catalog for one authenticated credential. The management endpoints are the
 * kiro.dev counterparts of the CodeWhisperer control-plane operations
 * (List-Available-Profiles, List-Available-Models, Get-Usage-Limits).
 * @module dsh-llm-kiro/management
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getKiroEndpoints } from './endpoints.ts'
import type { KiroListAvailableModelsResponse, KiroListAvailableProfilesResponse, KiroManagementAuth } from './types.ts'

const LIST_PROFILES_PATH = 'List-Available-Profiles'
const LIST_MODELS_PATH = 'List-Available-Models'

/** Management request timeout; one unreachable regional endpoint must not stall a request. */
const MANAGEMENT_TIMEOUT_MS = 20_000

/**
 * Management catalog cache location, shared with pi-provider-kiro. Computed
 * per call so credential-home resolution is always current.
 * @returns the cache file path.
 */
export function getKiroManagementCachePath(): string {
  return join(homedir(), '.kiro-management-models-cache.json')
}
/** Cache format version; bumped when the cached model shape changes. */
export const KIRO_MANAGEMENT_CACHE_VERSION = 2
/** Cache source tag validating a cache file belongs to this provider family. */
export const KIRO_MANAGEMENT_CACHE_SOURCE = 'kiro-management'

/** Cache TTL before the catalog is re-fetched. */
const CACHE_MAX_AGE_MS = 3600_000

/** One region's cached catalog. */
export interface ManagementCacheRegion {
  region: string
  fetchedAt: number
  models: Array<Record<string, unknown>>
}

/** The on-disk management cache document. */
export interface ManagementModelsCache {
  version: typeof KIRO_MANAGEMENT_CACHE_VERSION
  source: typeof KIRO_MANAGEMENT_CACHE_SOURCE
  regions: Record<string, ManagementCacheRegion>
}

const profileArnCache = new Map<string, string>()
const pendingProfileRequests = new Map<string, Promise<string>>()

/** HTTP failure of one management operation, with the response status retained. */
export class KiroManagementHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'KiroManagementHttpError'
  }
}

/**
 * Call one management operation. GET operations encode the body as query
 * parameters; POST operations send JSON.
 * @param auth - the credential facts for the call.
 * @param operation - human-readable operation name for diagnostics.
 * @param path - the endpoint path.
 * @param method - HTTP method.
 * @param body - the operation payload.
 * @returns the parsed response.
 */
async function requestManagement<TResponse>(
  auth: KiroManagementAuth,
  operation: string,
  path: string,
  method: 'GET' | 'POST',
  body: Record<string, unknown>,
): Promise<TResponse> {
  const url = new URL(path, getKiroEndpoints(auth.region).management)
  const request: RequestInit = {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${auth.accessToken}`,
    },
    signal: AbortSignal.timeout(MANAGEMENT_TIMEOUT_MS),
  }
  if (method === 'GET') {
    for (const [name, value] of Object.entries(body)) {
      if (value !== undefined) url.searchParams.set(name, String(value))
    }
  } else {
    request.headers = { ...request.headers, 'Content-Type': 'application/json' }
    request.body = JSON.stringify(body)
  }

  let response: Response
  try {
    response = await fetch(url.toString(), request)
  } catch (error) {
    throw new Error(`Kiro management ${operation} request failed in ${auth.region}`, { cause: error })
  }
  return parseManagementResponse<TResponse>(response, operation, auth.region)
}

/** Cache key for one credential's profile discovery. */
function profileCacheKey(auth: KiroManagementAuth): string {
  const tokenHash = createHash('sha256').update(auth.accessToken).digest('base64url')
  return `${auth.region}:${tokenHash}`
}

/** Parse a management response, translating HTTP failures into {@link KiroManagementHttpError}. */
async function parseManagementResponse<TResponse>(
  response: Response,
  operation: string,
  region: string,
): Promise<TResponse> {
  if (!response.ok) {
    throw new KiroManagementHttpError(
      `Kiro management ${operation} failed in ${region}: ${response.status}`,
      response.status,
    )
  }
  try {
    return (await response.json()) as TResponse
  } catch (error) {
    throw new Error(`Kiro management ${operation} returned invalid JSON in ${region}`, { cause: error })
  }
}

/**
 * Resolve the profile ARN for one credential, caching by credential and
 * region and coalescing concurrent lookups.
 * @param auth - the credential facts.
 * @param providedArn - an already-known profile ARN to return without a call.
 * @returns the first profile ARN the management endpoint reports.
 */
export async function resolveKiroProfileArn(auth: KiroManagementAuth, providedArn?: string): Promise<string> {
  if (providedArn) return providedArn

  const key = profileCacheKey(auth)
  const cachedArn = profileArnCache.get(key)
  if (cachedArn) return cachedArn

  const pending = pendingProfileRequests.get(key)
  if (pending) return pending

  const request = (async () => {
    const response = await requestManagement<KiroListAvailableProfilesResponse>(
      auth,
      'ListAvailableProfiles',
      LIST_PROFILES_PATH,
      'POST',
      {},
    )
    const arn = response.profiles?.find(profile => profile.arn)?.arn
    if (!arn) {
      throw new Error(`Kiro management ListAvailableProfiles returned no profile in ${auth.region}`)
    }
    profileArnCache.set(key, arn)
    return arn
  })()
  pendingProfileRequests.set(key, request)

  try {
    return await request
  } finally {
    if (pendingProfileRequests.get(key) === request) pendingProfileRequests.delete(key)
  }
}

/** Forget cached profile ARNs; exported for tests and credential rotation. */
export function resetKiroProfileArnCache(): void {
  profileArnCache.clear()
  pendingProfileRequests.clear()
}

/**
 * List the models one profile may use.
 * @param auth - the credential facts.
 * @param profileArn - the profile ARN to list models for.
 * @returns the model catalog response.
 */
export async function listAvailableModels(
  auth: KiroManagementAuth,
  profileArn: string,
): Promise<KiroListAvailableModelsResponse> {
  const response = await requestManagement<KiroListAvailableModelsResponse>(
    auth,
    'ListAvailableModels',
    LIST_MODELS_PATH,
    'GET',
    {
      origin: 'KIRO_CLI',
      profileArn,
    },
  )

  if (!Array.isArray(response.models) || response.models.length === 0) {
    throw new Error(`Kiro management ListAvailableModels returned no models in ${auth.region}`)
  }
  if (response.models.some(model => !model || typeof model.modelId !== 'string' || !model.modelId)) {
    throw new Error(`Kiro management ListAvailableModels returned an invalid catalog in ${auth.region}`)
  }
  return response
}

/**
 * Fetch the authenticated model catalog for one credential, resolving the
 * profile ARN first.
 * @param auth - the credential facts.
 * @param providedProfileArn - an already-known profile ARN.
 * @returns the model catalog response.
 */
export async function fetchKiroModelCatalog(
  auth: KiroManagementAuth,
  providedProfileArn?: string,
): Promise<KiroListAvailableModelsResponse> {
  const profileArn = await resolveKiroProfileArn(auth, providedProfileArn)
  return listAvailableModels(auth, profileArn)
}

/** Whether a value is a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a value is a positive finite number. */
function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/** Validate one cached region entry. */
function isCachedRegion(value: unknown): value is ManagementCacheRegion {
  if (!isRecord(value) || typeof value.region !== 'string' || !isPositiveNumber(value.fetchedAt)) return false
  if (!Array.isArray(value.models) || value.models.length === 0) return false
  return value.models.every(model => isRecord(model) && typeof model.modelId === 'string')
}

/** Parse and validate the on-disk cache document. */
export function parseManagementCache(raw: string): ManagementModelsCache | undefined {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (
    !isRecord(value)
    || value.version !== KIRO_MANAGEMENT_CACHE_VERSION
    || value.source !== KIRO_MANAGEMENT_CACHE_SOURCE
    || !isRecord(value.regions)
  ) {
    return undefined
  }
  const regions: Record<string, ManagementCacheRegion> = {}
  for (const [region, rawEntry] of Object.entries(value.regions)) {
    if (!isCachedRegion(rawEntry) || rawEntry.region !== region) return undefined
    const modelIds = new Set<string>()
    for (const model of rawEntry.models) {
      if (typeof model.modelId !== 'string' || modelIds.has(model.modelId)) return undefined
      modelIds.add(model.modelId)
    }
    regions[region] = rawEntry
  }
  return { version: KIRO_MANAGEMENT_CACHE_VERSION, source: KIRO_MANAGEMENT_CACHE_SOURCE, regions }
}

/** Read the on-disk cache document, when present and valid. */
export function readManagementCache(): ManagementModelsCache | undefined {
  const cachePath = getKiroManagementCachePath()
  if (!existsSync(cachePath)) return undefined
  try {
    return parseManagementCache(readFileSync(cachePath, 'utf-8'))
  } catch {
    return undefined
  }
}

/** Atomically replace the on-disk cache document. */
export function writeManagementCache(cache: ManagementModelsCache): void {
  const cachePath = getKiroManagementCachePath()
  const temporaryPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporaryPath, JSON.stringify(cache, null, 2), 'utf-8')
    renameSync(temporaryPath, cachePath)
  } finally {
    rmSync(temporaryPath, { force: true })
  }
}

/**
 * Whether one region's cached catalog is absent or older than the TTL.
 * @param region - the Kiro API region.
 * @returns true when the catalog is due for a re-fetch.
 */
export function isCacheStale(region: string): boolean {
  const entry = readManagementCache()?.regions[region]
  return !entry || Date.now() - entry.fetchedAt > CACHE_MAX_AGE_MS
}