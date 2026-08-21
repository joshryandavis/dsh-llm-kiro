/**
 * Model catalog tests: bootstrap resolution, authenticated-catalog mapping,
 * and the shared management cache. The cache path derives from os.homedir(),
 * which this spec stubs to a temp directory.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const { homeVar } = vi.hoisted(() => ({ homeVar: { value: '' } }))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return { ...actual, homedir: () => homeVar.value }
})

import {
  bootstrapKiroModels,
  getCachedModels,
  isCacheStale,
  KIRO_MODEL_IDS,
  mapKiroCatalogModels,
  resolveKiroModelId,
  toHarnessModelId,
  updateKiroModelsCache,
} from '../src/models.ts'
import { readManagementCache } from '../src/management.ts'
import type { KiroCatalogModel } from '../src/types.ts'

let home: string | undefined

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'llm-kiro-models-'))
  homeVar.value = home
})

afterEach(async () => {
  if (home !== undefined) await rm(join(home, '.kiro-management-models-cache.json'), { force: true })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const catalogModel = (modelId: string, extra: Partial<KiroCatalogModel> = {}): KiroCatalogModel => ({
  modelId,
  displayName: `Model ${modelId}`,
  tokenLimits: { maxInputTokens: 123456, maxOutputTokens: 4321 },
  ...extra,
})

describe('llm-kiro models', () => {
  it('ships the bootstrap catalog with dashed harness ids', () => {
    expect(bootstrapKiroModels.length).toBeGreaterThan(10)
    expect(bootstrapKiroModels.find(model => model.id === 'claude-sonnet-4-6')).toMatchObject({
      kiroModelId: 'claude-sonnet-4.6',
      reasoning: true,
      contextWindow: 1000000,
    })
    expect(bootstrapKiroModels.find(model => model.id === 'deepseek-3-2')).toMatchObject({
      kiroModelId: 'deepseek-3.2',
      contextWindow: 164000,
      inputModalities: ['text'],
    })
    expect(bootstrapKiroModels.find(model => model.id === 'claude-haiku-4-5')).toMatchObject({ reasoning: false })
  })

  it('converts dotted wire ids to dashed harness ids', () => {
    expect(toHarnessModelId('claude-sonnet-4.6')).toBe('claude-sonnet-4-6')
    expect(toHarnessModelId('glm-5')).toBe('glm-5')
  })

  it('resolves wire ids from the bootstrap catalog and normalizes unknown dotted input', () => {
    expect(resolveKiroModelId('claude-sonnet-4-6')).toBe('claude-sonnet-4.6')
    expect(resolveKiroModelId('claude-sonnet-4.6')).toBe('claude-sonnet-4.6')
    expect(() => resolveKiroModelId('nope-model')).toThrow('unknown Kiro model id')
  })

  it('maps an authenticated catalog, merging bootstrap metadata', () => {
    const mapped = mapKiroCatalogModels([
      catalogModel('claude-sonnet-4.6', { additionalModelRequestFieldsSchema: null }),
      catalogModel('brand-new-model'),
    ], 'us-east-1')
    expect(mapped.find(model => model.id === 'claude-sonnet-4-6')).toMatchObject({
      name: 'Model claude-sonnet-4.6',
      contextWindow: 123456,
      maxTokens: 4321,
      inputModalities: ['text', 'image'],
      reasoning: true,
    })
    expect(mapped.find(model => model.id === 'brand-new-model')).toMatchObject({
      name: 'Model brand-new-model',
      contextWindow: 123456,
      maxTokens: 4321,
      inputModalities: ['text'],
      reasoning: false,
    })
  })

  it('maps an authenticated catalog with an effort schema disclosing reasoning', () => {
    const mapped = mapKiroCatalogModels([
      {
        modelId: 'openai-gpt-x',
        displayName: 'GPT X',
        additionalModelRequestFieldsSchema: {
          properties: { reasoning: { properties: { effort: { enum: ['low', 'high'] } } } },
        },
      },
    ], 'us-east-1')
    expect(mapped[0]).toMatchObject({ reasoning: true })
  })

  it('rejects invalid catalogs', () => {
    expect(() => mapKiroCatalogModels([], 'us-east-1')).toThrow('no models')
    expect(() => mapKiroCatalogModels([{ modelId: ' spaced ' }], 'us-east-1')).toThrow('invalid model ID')
    expect(() => mapKiroCatalogModels([{ modelId: 'a' }, { modelId: 'a' }], 'us-east-1')).toThrow('conflicting model ID')
    expect(() => mapKiroCatalogModels([{ modelId: 'a', additionalModelRequestFieldsSchema: 'bad' }], 'us-east-1')).toThrow('invalid request-fields schema')
    expect(() => mapKiroCatalogModels([{ modelId: 'a', tokenLimits: 'bad' }], 'us-east-1')).toThrow('invalid token limits')
    expect(() => mapKiroCatalogModels([{ modelId: 'a', tokenLimits: { maxInputTokens: -1 } }], 'us-east-1')).toThrow('invalid token limits')
  })

  it('caches the authenticated catalog per region and serves it', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('List-Available-Profiles')) {
        return new Response(JSON.stringify({ profiles: [{ arn: 'arn:1' }] }), { status: 200 })
      }
      return new Response(JSON.stringify({
        models: [catalogModel('claude-sonnet-4.6'), catalogModel('brand-new-model')],
      }), { status: 200 })
    }))
    await updateKiroModelsCache('token', 'us-east-1')
    const cached = getCachedModels('us-east-1')
    expect(cached.find(model => model.id === 'brand-new-model')).toBeDefined()
    expect(isCacheStale('us-east-1')).toBe(false)
    expect(isCacheStale('eu-central-1')).toBe(true)
    const cache = readManagementCache()
    expect(cache?.regions['us-east-1']).toBeDefined()
    // The discovered id joins the known-id set
    expect(KIRO_MODEL_IDS.has('brand-new-model')).toBe(true)
    vi.unstubAllGlobals()
  })

  it('serves the bootstrap catalog before discovery and tolerates cache corruption', async () => {
    expect(getCachedModels('ap-southeast-1')).toEqual(bootstrapKiroModels)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(home!, '.kiro-management-models-cache.json'), 'not json')
    expect(getCachedModels('ap-southeast-1')).toEqual(bootstrapKiroModels)
  })
})