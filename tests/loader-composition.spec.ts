/**
 * Real-composition guard: LlmRuntime, settings-file, credentials-local, and
 * llm-kiro boot from a test-only cordis.yml through the actual Loader +
 * Include path. Credentials come from the ambient store (a fixture kiro-cli
 * database), and the runtime request lands on the scripted mock server.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import * as LlmKiro from '../src/index.ts'
import { DatabaseSync } from 'node:sqlite'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

const NS = settingsNamespace('llm-kiro')

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  await closeMockServers()
  vi.unstubAllEnvs()
})

async function loadComposition(options: { dbPath: string; ssoCacheDir: string; runtimeURL: string }): Promise<{ ctx: Context; settingsPath: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-llm-kiro-composition-'))
  vi.stubEnv('DSH_HOME', root)
  const settingsPath = join(root, 'settings.yaml')
  const credentialsPath = join(root, '.credentials.yaml')
  await writeFile(settingsPath, '# personal settings\n')
  await writeFile(credentialsPath, '\n', { mode: 0o600 })

  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: llm',
    "  name: 'test-llm-service'",
    '- id: settings',
    "  name: '@deepseek-ai/dsh-settings-file'",
    '  config:',
    '    path: ' + JSON.stringify(settingsPath),
    '    debounceMs: 10',
    '- id: credentials',
    "  name: '@deepseek-ai/dsh-credentials-local'",
    '  config:',
    '    path: ' + JSON.stringify(credentialsPath),
    '    debounceMs: 10',
    '- id: llm-kiro',
    "  name: 'llm-kiro'",
    '  config:',
    '    kiroCliDbPath: ' + JSON.stringify(options.dbPath),
    '    ssoCacheDir: ' + JSON.stringify(options.ssoCacheDir),
    '    runtimeURL: ' + JSON.stringify(options.runtimeURL),
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['test-llm-service', LlmRuntime],
    ['@deepseek-ai/dsh-settings-file', FileSettingsProvider],
    ['@deepseek-ai/dsh-credentials-local', LocalCredentialProvider],
    ['llm-kiro', LlmKiro],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error('unexpected Loader import: ' + specifier)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()
  return { ctx, settingsPath }
}

async function fixtureStore(): Promise<{ dbPath: string; ssoCacheDir: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-llm-kiro-store-'))
  const dbPath = join(root, 'data.sqlite3')
  const ssoCacheDir = join(root, 'sso-cache')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(ssoCacheDir, { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);')
  return { dbPath, ssoCacheDir }
}

describe('llm-kiro real dynamic composition', () => {
  it('boots from cordis.yml, picks up the ambient store, and streams', async () => {
    const { dbPath, ssoCacheDir } = await fixtureStore()
    const db = new DatabaseSync(dbPath)
    db.prepare('INSERT INTO auth_kv (key, value) VALUES (?, ?);').run('kirocli:odic:token', JSON.stringify({
      access_token: 'boot-token',
      refresh_token: 'boot-refresh',
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      region: 'us-east-1',
      profile_arn: 'arn:aws:codewhisperer:us-east-1:123:profile/test',
    }))
    const server = await mockServer([{ kind: 'eventstream', events: textEvents }])
    const { ctx } = await loadComposition({ dbPath, ssoCacheDir, runtimeURL: server.url })

    expect(ctx.get('settings')!.describe().map(entry => entry.ns)).toContain(NS)
    expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('kiro')
    expect(ctx.llm.listConfigurableProviders().map(provider => provider.provider)).toContain('kiro')
    await assemble(ctx, { model: 'claude-sonnet-4-6', messages: [] })
    expect(server.headers[0]?.authorization).toBe('Bearer boot-token')
  })

  it('advertises discovery for the llm-kiro namespace', async () => {
    const { dbPath, ssoCacheDir } = await fixtureStore()
    const server = await mockServer([{ kind: 'eventstream', events: textEvents }])
    const { ctx } = await loadComposition({ dbPath, ssoCacheDir, runtimeURL: server.url })
    const discovered = await ctx.llm.discoverModels(NS, { provider: 'kiro' })
    expect(discovered.some(model => model.id === 'claude-sonnet-4-6')).toBe(true)
  })
})