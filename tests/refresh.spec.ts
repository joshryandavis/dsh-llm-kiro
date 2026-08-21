/**
 * Token refresh tests with a stubbed fetch: OIDC and desktop endpoints, the
 * layered resolution chain, and 403 recovery.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { KIRO_DESKTOP_REFRESH_URL, recoverKiroCredential, refreshKiroToken, resolveUsableKiroCredential } from '../src/refresh.ts'
import type { KiroCredentials } from '../src/types.ts'

const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }))

vi.mock('node:child_process', () => ({ execFileSync: execFileSyncMock }))

const idcCreds: KiroCredentials = {
  access: 'expired-access',
  refresh: 'expired-refresh|client-1|secret-1|idc',
  expires: Date.now() - 60_000,
  clientId: 'client-1',
  clientSecret: 'secret-1',
  region: 'us-east-1',
  authMethod: 'idc',
}

const desktopCreds: KiroCredentials = {
  access: 'expired-access',
  refresh: 'expired-refresh|desktop',
  expires: Date.now() - 60_000,
  clientId: '',
  clientSecret: '',
  region: 'us-east-1',
  authMethod: 'desktop',
}

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

async function fixtureStore(): Promise<{ dir: string; dbPath: string; ssoCacheDir: string }> {
  root = await mkdtemp(join(tmpdir(), 'llm-kiro-refresh-'))
  const dbPath = join(root, 'data.sqlite3')
  const ssoCacheDir = join(root, 'sso-cache')
  await mkdir(ssoCacheDir, { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);')
  return { dir: root, dbPath, ssoCacheDir }
}

/** Isolated store paths: never touch the host machine's real kiro-cli or Kiro IDE credentials. */
function isolated(dbPath: string, ssoCacheDir: string): { dbPath: string; ssoCacheDir: string } {
  return { dbPath, ssoCacheDir }
}

describe('llm-kiro refresh', () => {
  it('refreshes an IDC token through the SSO OIDC token endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      accessToken: 'fresh-access',
      refreshToken: 'fresh-refresh',
      expiresIn: 3600,
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const refreshed = await refreshKiroToken(idcCreds)
    expect(refreshed).toMatchObject({
      access: 'fresh-access',
      refresh: 'fresh-refresh|client-1|secret-1|idc',
      authMethod: 'idc',
    })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://oidc.us-east-1.amazonaws.com/token')
    expect(JSON.parse(init.body as string)).toEqual({
      clientId: 'client-1',
      clientSecret: 'secret-1',
      refreshToken: 'expired-refresh',
      grantType: 'refresh_token',
    })
  })

  it('refreshes a desktop token through the Kiro desktop endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      accessToken: 'fresh-access',
      expiresIn: 7200,
      profileArn: 'arn:aws:codewhisperer:us-east-1:123:profile/p1',
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const refreshed = await refreshKiroToken(desktopCreds)
    expect(refreshed).toMatchObject({
      access: 'fresh-access',
      refresh: 'expired-refresh|desktop',
      authMethod: 'desktop',
      profileArn: 'arn:aws:codewhisperer:us-east-1:123:profile/p1',
    })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(KIRO_DESKTOP_REFRESH_URL.replace('{region}', 'us-east-1'))
    expect(JSON.parse(init.body as string)).toEqual({ refreshToken: 'expired-refresh' })
  })

  it('throws when the refresh endpoints reject or omit an access token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 400 })))
    await expect(refreshKiroToken(idcCreds)).rejects.toThrow('Kiro IDC token refresh failed: 400')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })))
    await expect(refreshKiroToken(desktopCreds)).rejects.toThrow('missing accessToken')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 200 })))
    await expect(refreshKiroToken(idcCreds)).rejects.toThrow('invalid_grant')
  })

  it('resolves a valid kiro-cli credential without network activity', async () => {
    const { dbPath, ssoCacheDir } = await fixtureStore()
    const db = new DatabaseSync(dbPath)
    db.prepare('INSERT INTO auth_kv (key, value) VALUES (?, ?);').run('kirocli:odic:token', JSON.stringify({
      access_token: 'valid-access',
      refresh_token: 'valid-refresh',
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    }))
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const credential = await resolveUsableKiroCredential(isolated(dbPath, ssoCacheDir))
    expect(credential).toMatchObject({ access: 'valid-access' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('prefers the Kiro IDE token over the kiro-cli store', async () => {
    const { dir, dbPath } = await fixtureStore()
    const ssoCacheDir = join(dir, 'sso-cache')
    await mkdir(ssoCacheDir, { recursive: true })
    await writeFile(join(ssoCacheDir, 'kiro-auth-token.json'), JSON.stringify({
      accessToken: 'ide-valid',
      refreshToken: 'ide-refresh',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    }))
    const db = new DatabaseSync(dbPath)
    db.prepare('INSERT INTO auth_kv (key, value) VALUES (?, ?);').run('kirocli:odic:token', JSON.stringify({
      access_token: 'cli-valid',
      refresh_token: 'cli-refresh',
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    }))
    const credential = await resolveUsableKiroCredential({ dbPath, ssoCacheDir })
    expect(credential).toMatchObject({ access: 'ide-valid' })
  })

  it('silently refreshes an expired IDE token', async () => {
    const { dir } = await fixtureStore()
    const ssoCacheDir = join(dir, 'sso-cache')
    await mkdir(ssoCacheDir, { recursive: true })
    await writeFile(join(ssoCacheDir, 'kiro-auth-token.json'), JSON.stringify({
      accessToken: 'expired-ide',
      refreshToken: 'ide-refresh',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      clientIdHash: 'h1',
    }))
    await writeFile(join(ssoCacheDir, 'h1.json'), JSON.stringify({ clientId: 'ide-client', clientSecret: 'ide-secret' }))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      accessToken: 'refreshed-ide',
      refreshToken: 'rotated',
      expiresIn: 3600,
    }), { status: 200 })))
    // The kiro-cli store must not leak the host machine's real token: pass a
    // dbPath that does not exist so the kiro-cli layers are skipped.
    const credential = await resolveUsableKiroCredential(isolated(join(dir, 'no-such-db.sqlite3'), ssoCacheDir))
    expect(credential).toMatchObject({ access: 'refreshed-ide' })
  })

  it('refreshes an expired kiro-cli token and writes it back', async () => {
    const { dbPath, ssoCacheDir } = await fixtureStore()
    const db = new DatabaseSync(dbPath)
    db.prepare('INSERT INTO auth_kv (key, value) VALUES (?, ?);').run('kirocli:odic:token', JSON.stringify({
      access_token: 'expired-cli',
      refresh_token: 'cli-refresh',
      expires_at: new Date(Date.now() - 60_000).toISOString(),
      region: 'us-east-1',
    }))
    db.prepare('INSERT INTO auth_kv (key, value) VALUES (?, ?);').run('kirocli:odic:device-registration', JSON.stringify({
      client_id: 'client-1',
      client_secret: 'secret-1',
    }))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      accessToken: 'refreshed-cli',
      refreshToken: 'rotated',
      expiresIn: 3600,
    }), { status: 200 })))
    const credential = await resolveUsableKiroCredential(isolated(dbPath, ssoCacheDir))
    expect(credential).toMatchObject({ access: 'refreshed-cli' })
    const stored = JSON.parse(db.prepare("SELECT value FROM auth_kv WHERE key = 'kirocli:odic:token'").get()!.value as string)
    expect(stored.access_token).toBe('refreshed-cli')
    expect(stored.refresh_token).toBe('rotated')
  })

  it('falls back to the kiro-cli owned refresh when direct refresh fails', async () => {
    const { dbPath, ssoCacheDir } = await fixtureStore()
    const db = new DatabaseSync(dbPath)
    db.prepare('INSERT INTO auth_kv (key, value) VALUES (?, ?);').run('kirocli:odic:token', JSON.stringify({
      access_token: 'expired-cli',
      refresh_token: 'cli-refresh',
      expires_at: new Date(Date.now() - 60_000).toISOString(),
      region: 'us-east-1',
    }))
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })))
    execFileSyncMock.mockImplementation(() => {
      throw new Error('kiro-cli missing')
    })
    expect(await resolveUsableKiroCredential(isolated(dbPath, ssoCacheDir))).toBeUndefined()
  })

  it('recovers a rotated credential from the store on 403', async () => {
    const { dbPath, ssoCacheDir } = await fixtureStore()
    const db = new DatabaseSync(dbPath)
    db.prepare('INSERT INTO auth_kv (key, value) VALUES (?, ?);').run('kirocli:odic:token', JSON.stringify({
      access_token: 'rotated-by-kiro-cli',
      refresh_token: 'new-refresh',
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    }))
    const recovered = await recoverKiroCredential({ ...idcCreds, access: 'rejected-old' }, isolated(dbPath, ssoCacheDir))
    expect(recovered).toMatchObject({ access: 'rotated-by-kiro-cli' })
  })

  it('refreshes directly when the store still holds the rejected token', async () => {
    const { dbPath, ssoCacheDir } = await fixtureStore()
    const db = new DatabaseSync(dbPath)
    db.prepare('INSERT INTO auth_kv (key, value) VALUES (?, ?);').run('kirocli:odic:token', JSON.stringify({
      access_token: 'rejected-old',
      refresh_token: 'still-refresh',
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      region: 'us-east-1',
    }))
    db.prepare('INSERT INTO auth_kv (key, value) VALUES (?, ?);').run('kirocli:odic:device-registration', JSON.stringify({
      client_id: 'client-1',
      client_secret: 'secret-1',
    }))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      accessToken: 'direct-refreshed',
      expiresIn: 3600,
    }), { status: 200 })))
    const recovered = await recoverKiroCredential({ ...idcCreds, access: 'rejected-old' }, isolated(dbPath, ssoCacheDir))
    expect(recovered).toMatchObject({ access: 'direct-refreshed' })
    const stored = JSON.parse(db.prepare("SELECT value FROM auth_kv WHERE key = 'kirocli:odic:token'").get()!.value as string)
    expect(stored.access_token).toBe('direct-refreshed')
  })

  it('returns undefined when nothing can recover', async () => {
    const { dbPath, ssoCacheDir } = await fixtureStore()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })))
    execFileSyncMock.mockImplementation(() => {
      throw new Error('kiro-cli missing')
    })
    const recovered = await recoverKiroCredential({ ...idcCreds, access: 'rejected-old' }, isolated(dbPath, ssoCacheDir), true)
    expect(recovered).toBeUndefined()
  })

  it('skips the kiro-cli layer when disallowed', async () => {
    const { dir } = await fixtureStore()
    execFileSyncMock.mockImplementation(() => {
      throw new Error('should not be called')
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })))
    const recovered = await recoverKiroCredential(
      desktopCreds,
      isolated(join(dir, 'no-such-db.sqlite3'), join(dir, 'sso-cache')),
      false,
    )
    expect(recovered).toBeUndefined()
    expect(execFileSyncMock).not.toHaveBeenCalled()
  })
})