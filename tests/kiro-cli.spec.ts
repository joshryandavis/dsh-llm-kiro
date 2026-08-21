/**
 * kiro-cli store and Kiro IDE token tests against real SQLite fixtures in a
 * temp directory; the sqlite3-CLI fallback paths live in kiro-cli-cli.spec.ts.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import {
  getKiroCliCredentials,
  getKiroCliCredentialsAllowExpired,
  getKiroCliDbPath,
  getKiroIdeCredentials,
  queryKiroCliDb,
  execKiroCliDb,
  refreshViaKiroCli,
  saveKiroCliCredentials,
  tryKiroCliToken,
} from '../src/kiro-cli.ts'

const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }))

vi.mock('node:child_process', () => ({ execFileSync: execFileSyncMock }))

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

async function fixtureDb(): Promise<{ dir: string; dbPath: string }> {
  root = await mkdtemp(join(tmpdir(), 'llm-kiro-'))
  const dbPath = join(root, 'data.sqlite3')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);')
  return { dir: root, dbPath }
}

function insertToken(db: DatabaseSync, key: string, token: Record<string, unknown>): void {
  db.prepare('INSERT OR REPLACE INTO auth_kv (key, value) VALUES (?, ?);').run(key, JSON.stringify(token))
}

const idcToken = (expiresAt: string) => ({
  access_token: 'idc-access',
  refresh_token: 'idc-refresh',
  expires_at: expiresAt,
  region: 'us-west-2',
  profile_arn: 'arn:aws:codewhisperer:us-east-1:123:profile/p1',
})

describe('llm-kiro kiro-cli store', () => {
  it('resolves no database path when the file is absent', () => {
    expect(getKiroCliDbPath({ dbPath: '/nonexistent/nope.sqlite3' })).toBeUndefined()
  })

  it('reads an IDC token with its device registration', async () => {
    const { dbPath } = await fixtureDb()
    insertToken(new DatabaseSync(dbPath), 'kirocli:odic:token', idcToken(new Date(Date.now() + 3600_000).toISOString()))
    insertToken(new DatabaseSync(dbPath), 'kirocli:odic:device-registration', {
      client_id: 'client-1',
      client_secret: 'secret-1',
    })
    const creds = getKiroCliCredentials({ dbPath })
    expect(creds).toMatchObject({
      access: 'idc-access',
      refresh: 'idc-refresh|client-1|secret-1|idc',
      clientId: 'client-1',
      clientSecret: 'secret-1',
      region: 'us-west-2',
      authMethod: 'idc',
      profileArn: 'arn:aws:codewhisperer:us-east-1:123:profile/p1',
    })
  })

  it('falls back to the social token when no IDC token exists', async () => {
    const { dbPath } = await fixtureDb()
    insertToken(new DatabaseSync(dbPath), 'kirocli:social:token', {
      access_token: 'social-access',
      refresh_token: 'social-refresh',
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    })
    const creds = getKiroCliCredentials({ dbPath })
    expect(creds).toMatchObject({
      access: 'social-access',
      refresh: 'social-refresh|desktop',
      authMethod: 'desktop',
    })
    expect(creds!.profileArn).toBeUndefined()
  })

  it('skips tokens within the buffered expiry window unless allowed', async () => {
    const { dbPath } = await fixtureDb()
    const soon = new Date(Date.now() + 60_000).toISOString()
    insertToken(new DatabaseSync(dbPath), 'kirocli:odic:token', idcToken(soon))
    expect(getKiroCliCredentials({ dbPath })).toBeUndefined()
    expect(getKiroCliCredentialsAllowExpired({ dbPath })).toMatchObject({ access: 'idc-access' })
  })

  it('ignores malformed or incomplete stored rows', async () => {
    const { dbPath } = await fixtureDb()
    const db = new DatabaseSync(dbPath)
    insertToken(db, 'kirocli:odic:token', { access_token: 'no-refresh' })
    insertToken(db, 'kirocli:social:token', 'not json')
    insertToken(db, 'kirocli:odic:device-registration', 'not json')
    expect(getKiroCliCredentials({ dbPath })).toBeUndefined()
    expect(getKiroCliCredentialsAllowExpired({ dbPath })).toBeUndefined()
    expect(tryKiroCliToken(dbPath, 'kirocli:odic:token', 'idc', true)).toBeUndefined()
  })

  it('defaults missing expiry and region fields', async () => {
    const { dbPath } = await fixtureDb()
    insertToken(new DatabaseSync(dbPath), 'kirocli:odic:token', {
      access_token: 'a',
      refresh_token: 'r',
    })
    const creds = getKiroCliCredentials({ dbPath })
    expect(creds).toMatchObject({ region: 'us-east-1', expires: expect.any(Number) })
    expect(creds!.expires).toBeGreaterThan(Date.now())
  })

  it('writes back to both idc token keys', async () => {
    const { dbPath } = await fixtureDb()
    const db = new DatabaseSync(dbPath)
    const future = new Date(Date.now() + 3600_000).toISOString()
    insertToken(db, 'kirocli:odic:token', idcToken(future))
    insertToken(db, 'codewhisperer:odic:token', idcToken(future))
    const creds = getKiroCliCredentials({ dbPath })!
    saveKiroCliCredentials({ ...creds, access: 'rotated' }, { dbPath })
    for (const key of ['kirocli:odic:token', 'codewhisperer:odic:token']) {
      const stored = JSON.parse(db.prepare('SELECT value FROM auth_kv WHERE key = ?;').get(key)!.value as string)
      expect(stored.access_token).toBe('rotated')
    }
  })

  it('returns undefined when both engines fail', async () => {
    const { dbPath } = await fixtureDb()
    expect(queryKiroCliDb(join(dbPath, 'missing.sqlite3'), 'SELECT 1')).toBeUndefined()
    expect(execKiroCliDb(join(dbPath, 'missing.sqlite3'), 'SELECT 1')).toBe(false)
  })

  it('reads the Kiro IDE token with its client registration', async () => {
    root = await mkdtemp(join(tmpdir(), 'llm-kiro-'))
    const ssoCacheDir = join(root, '.aws', 'sso', 'cache')
    await mkdir(ssoCacheDir, { recursive: true })
    await writeFile(join(ssoCacheDir, 'kiro-auth-token.json'), JSON.stringify({
      accessToken: 'ide-access',
      refreshToken: 'ide-refresh',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      region: 'eu-west-1',
      clientIdHash: 'abc123',
    }))
    await writeFile(join(ssoCacheDir, 'abc123.json'), JSON.stringify({ clientId: 'ide-client', clientSecret: 'ide-secret' }))
    const creds = getKiroIdeCredentials(false, { ssoCacheDir })
    expect(creds).toMatchObject({
      access: 'ide-access',
      refresh: 'ide-refresh|ide-client|ide-secret|idc',
      clientId: 'ide-client',
      region: 'eu-west-1',
      authMethod: 'idc',
    })
    expect(creds!.expires).toBeLessThanOrEqual(new Date(new Date(Date.now() + 3600_000).toISOString()).getTime() - 2 * 60_000)
  })

  it('reads an expired IDE token only with allowExpired, tolerating a missing registration', async () => {
    root = await mkdtemp(join(tmpdir(), 'llm-kiro-'))
    const ssoCacheDir = join(root, '.aws', 'sso', 'cache')
    await mkdir(ssoCacheDir, { recursive: true })
    await writeFile(join(ssoCacheDir, 'kiro-auth-token.json'), JSON.stringify({
      accessToken: 'ide-access',
      refreshToken: 'ide-refresh',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    }))
    expect(getKiroIdeCredentials(false, { ssoCacheDir })).toBeUndefined()
    expect(getKiroIdeCredentials(true, { ssoCacheDir })).toMatchObject({ access: 'ide-access' })
  })

  it('ignores missing, malformed, or unparseable IDE token files', async () => {
    root = await mkdtemp(join(tmpdir(), 'llm-kiro-'))
    const ssoCacheDir = join(root, '.aws', 'sso', 'cache')
    await mkdir(ssoCacheDir, { recursive: true })
    expect(getKiroIdeCredentials(false, { ssoCacheDir })).toBeUndefined()
    await writeFile(join(ssoCacheDir, 'kiro-auth-token.json'), 'not json')
    expect(getKiroIdeCredentials(false, { ssoCacheDir })).toBeUndefined()
    await writeFile(join(ssoCacheDir, 'kiro-auth-token.json'), JSON.stringify({ accessToken: 'a' }))
    expect(getKiroIdeCredentials(false, { ssoCacheDir })).toBeUndefined()
    await writeFile(join(ssoCacheDir, 'kiro-auth-token.json'), JSON.stringify({
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: 'garbage',
    }))
    expect(getKiroIdeCredentials(false, { ssoCacheDir })).toBeUndefined()
    await writeFile(join(ssoCacheDir, 'kiro-auth-token.json'), JSON.stringify({
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      clientIdHash: 'hash',
    }))
    await writeFile(join(ssoCacheDir, 'hash.json'), 'not json')
    expect(getKiroIdeCredentials(false, { ssoCacheDir })).toMatchObject({ access: 'a' })
  })

  it('refreshes via kiro-cli when available and returns nothing when it is not', async () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('ENOENT')
    })
    expect(refreshViaKiroCli()).toBeUndefined()
    const { dbPath } = await fixtureDb()
    insertToken(new DatabaseSync(dbPath), 'kirocli:odic:token', idcToken(new Date(Date.now() + 3600_000).toISOString()))
    execFileSyncMock.mockImplementation(() => undefined as never)
    expect(refreshViaKiroCli({ dbPath })).toMatchObject({ access: 'idc-access' })
  })

  it('write-back only touches keys that already exist', async () => {
    const { dbPath } = await fixtureDb()
    saveKiroCliCredentials({
      access: 'a',
      refresh: 'r|desktop',
      expires: Date.now(),
      clientId: '',
      clientSecret: '',
      region: 'us-east-1',
      authMethod: 'desktop',
    }, { dbPath })
    const db = new DatabaseSync(dbPath)
    expect(db.prepare('SELECT COUNT(*) AS n FROM auth_kv').get()).toEqual({ n: 0 })
  })

  it('write-back skips a malformed stored row and updates the matching key', async () => {
    const { dbPath } = await fixtureDb()
    const db = new DatabaseSync(dbPath)
    insertToken(db, 'kirocli:social:token', 'not json')
    insertToken(db, 'kirocli:odic:token', idcToken(new Date(Date.now() + 3600_000).toISOString()))
    saveKiroCliCredentials({
      access: 'rotated',
      refresh: 'rotated-refresh|client-1|secret-1|idc',
      expires: Date.now() + 3600_000,
      clientId: 'client-1',
      clientSecret: 'secret-1',
      region: 'us-east-1',
      authMethod: 'idc',
      profileArn: 'arn:aws:codewhisperer:us-east-1:123:profile/p1',
    }, { dbPath })
    const stored = JSON.parse(db.prepare("SELECT value FROM auth_kv WHERE key = 'kirocli:odic:token'").get()!.value as string)
    expect(stored.access_token).toBe('rotated')
    expect(stored.refresh_token).toBe('rotated-refresh')
    expect(stored.profile_arn).toBe('arn:aws:codewhisperer:us-east-1:123:profile/p1')
  })
})