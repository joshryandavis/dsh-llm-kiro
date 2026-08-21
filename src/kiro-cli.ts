/**
 * Reads and writes credentials from the kiro-cli SQLite store and the Kiro
 * IDE token file. kiro-cli persists its OAuth tokens in an `auth_kv` table of
 * `data.sqlite3` under the platform application-support directory; the Kiro
 * IDE keeps its token at `~/.aws/sso/cache/kiro-auth-token.json` with the OIDC
 * client registration beside it. Both are ambient credential sources this
 * provider picks up so an existing kiro-cli or Kiro IDE login needs no second
 * sign-in.
 * @module dsh-llm-kiro/kiro-cli
 */

import { execFileSync, execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import type { KiroAuthMethod, KiroCredentials } from './types.ts'

const require = createRequire(import.meta.url)

/** Path overrides for non-standard homes; the plugin passes configured values through. */
export interface KiroStorePaths {
  /** kiro-cli SQLite database path; defaults to the platform application-support location. */
  dbPath?: string
  /** AWS SSO cache directory holding the Kiro IDE token; defaults to ~/.aws/sso/cache. */
  ssoCacheDir?: string
}

/** The auth_kv keys whose tokens this provider knows, per auth method. */
const TOKEN_KEYS: Record<KiroAuthMethod, readonly string[]> = {
  idc: ['kirocli:odic:token', 'codewhisperer:odic:token'],
  desktop: ['kirocli:social:token'],
}

/** Buffered expiry window: a token within this margin of expiry counts as expired. */
const EXPIRY_BUFFER_MS = 2 * 60 * 1000

/**
 * Resolve the kiro-cli database path for this platform, honoring an override.
 * @param paths - optional path overrides.
 * @returns the database path when the file exists, else undefined.
 */
export function getKiroCliDbPath(paths?: KiroStorePaths): string | undefined {
  if (paths?.dbPath) return existsSync(paths.dbPath) ? paths.dbPath : undefined
  const p = platform()
  let dbPath: string
  if (p === 'win32')
    dbPath = join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'kiro-cli', 'data.sqlite3')
  else if (p === 'darwin') dbPath = join(homedir(), 'Library', 'Application Support', 'kiro-cli', 'data.sqlite3')
  else dbPath = join(homedir(), '.local', 'share', 'kiro-cli', 'data.sqlite3')
  return existsSync(dbPath) ? dbPath : undefined
}

/** Load node:sqlite when this Node runtime provides it. */
function getNodeSqlite(): typeof import('node:sqlite') | undefined {
  try {
    return require('node:sqlite') as typeof import('node:sqlite')
  } catch {
    return undefined
  }
}

/**
 * Query the kiro-cli database, preferring node:sqlite and falling back to the
 * sqlite3 CLI. Returns the JSON array of rows as text, or undefined when the
 * query returned no rows or both engines failed.
 * @param dbPath - path to the kiro-cli database.
 * @param sql - the read-only SQL statement.
 * @returns the row JSON or undefined.
 */
export function queryKiroCliDb(dbPath: string, sql: string): string | undefined {
  const sqlite = getNodeSqlite()
  if (sqlite) {
    try {
      const db = new sqlite.DatabaseSync(dbPath, { readOnly: true })
      try {
        const rows = db.prepare(sql).all() as unknown[]
        const result = JSON.stringify(rows)
        return result === '[]' ? undefined : result
      } finally {
        db.close()
      }
    } catch {
      // Fall through to the sqlite3 CLI fallback
    }
  }
  try {
    const result = execSync(`sqlite3 -json "${dbPath}" "${sql}"`, {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    return result === '[]' ? undefined : result || undefined
  } catch {
    return undefined
  }
}

/**
 * Execute a write statement against the kiro-cli database with the same
 * engine preference as {@link queryKiroCliDb}.
 * @param dbPath - path to the kiro-cli database.
 * @param sql - the write SQL statement.
 * @returns whether the statement executed successfully.
 */
export function execKiroCliDb(dbPath: string, sql: string): boolean {
  const sqlite = getNodeSqlite()
  if (sqlite) {
    try {
      const db = new sqlite.DatabaseSync(dbPath)
      try {
        db.exec(sql)
        return true
      } finally {
        db.close()
      }
    } catch {
      // Fall through to the sqlite3 CLI fallback
    }
  }
  try {
    execSync(`sqlite3 "${dbPath}"`, {
      input: sql,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return true
  } catch {
    return false
  }
}

/** Parse one stored token row into credential facts. */
interface StoredToken {
  access_token?: string
  refresh_token?: string
  expires_at?: string
  region?: string
  profile_arn?: string
  profileArn?: string
}

/**
 * Read the token stored under one auth_kv key, when it is usable.
 * @param dbPath - the kiro-cli database path.
 * @param tokenKey - the auth_kv key naming the token.
 * @param authMethod - the transport the token authenticates through.
 * @param allowExpired - whether to accept tokens past their buffered expiry.
 * @returns the credential facts, or undefined when the key holds nothing usable.
 */
export function tryKiroCliToken(
  dbPath: string,
  tokenKey: string,
  authMethod: KiroAuthMethod,
  allowExpired = false,
): KiroCredentials | undefined {
  const tokenResult = queryKiroCliDb(dbPath, `SELECT value FROM auth_kv WHERE key = '${tokenKey}'`)
  if (!tokenResult) return undefined
  const rows = JSON.parse(tokenResult) as Array<{ value: string }>
  if (!rows[0]?.value) return undefined
  const tokenData = JSON.parse(rows[0].value) as StoredToken
  if (!tokenData.access_token || !tokenData.refresh_token) return undefined
  let expiresAt = Date.now() + 3600000
  if (tokenData.expires_at) expiresAt = new Date(tokenData.expires_at).getTime()
  if (!allowExpired && Date.now() >= expiresAt - EXPIRY_BUFFER_MS) return undefined
  const region = tokenData.region || 'us-east-1'
  const profileArn = tokenData.profile_arn || tokenData.profileArn

  if (authMethod === 'desktop') {
    return {
      refresh: `${tokenData.refresh_token}|desktop`,
      access: tokenData.access_token,
      expires: expiresAt,
      clientId: '',
      clientSecret: '',
      region,
      authMethod: 'desktop',
      ...(profileArn ? { profileArn } : {}),
    }
  }

  // IDC tokens refresh through the SSO OIDC endpoint, which needs the device
  // registration credentials stored under a sibling key sharing the token's prefix.
  let clientId = ''
  let clientSecret = ''
  const keyPrefix = tokenKey.split(':')[0]
  const deviceResult = queryKiroCliDb(
    dbPath,
    `SELECT value FROM auth_kv WHERE key = '${keyPrefix}:odic:device-registration'`,
  )
  if (deviceResult) {
    try {
      const d = JSON.parse(JSON.parse(deviceResult)[0]?.value) as { client_id?: string; clientId?: string; client_secret?: string; clientSecret?: string }
      clientId = d.client_id || d.clientId || ''
      clientSecret = d.client_secret || d.clientSecret || ''
    } catch {
      // Malformed registration: refresh will fail later, pickup still works
    }
  }
  return {
    refresh: `${tokenData.refresh_token}|${clientId}|${clientSecret}|idc`,
    access: tokenData.access_token,
    expires: expiresAt,
    clientId,
    clientSecret,
    region,
    authMethod: 'idc',
    ...(profileArn ? { profileArn } : {}),
  }
}

/**
 * Read a valid (non-expired) kiro-cli credential: the IAM Identity Center
 * token first, then the desktop/social token.
 * @param paths - optional path overrides.
 * @returns the credential facts, or undefined when kiro-cli holds no usable token.
 */
export function getKiroCliCredentials(paths?: KiroStorePaths): KiroCredentials | undefined {
  const dbPath = getKiroCliDbPath(paths)
  if (!dbPath) return undefined
  try {
    const idcCreds = tryKiroCliToken(dbPath, 'kirocli:odic:token', 'idc')
    if (idcCreds) return idcCreds
    return tryKiroCliToken(dbPath, 'kirocli:social:token', 'desktop')
  } catch {
    return undefined
  }
}

/**
 * Like {@link getKiroCliCredentials} but accepts expired tokens carrying a
 * refresh token, so the caller can attempt a silent refresh before the device
 * flow.
 * @param paths - optional path overrides.
 * @returns the credential facts, expired included.
 */
export function getKiroCliCredentialsAllowExpired(paths?: KiroStorePaths): KiroCredentials | undefined {
  const dbPath = getKiroCliDbPath(paths)
  if (!dbPath) return undefined
  try {
    const idcCreds = tryKiroCliToken(dbPath, 'kirocli:odic:token', 'idc', true)
    if (idcCreds) return idcCreds
    return tryKiroCliToken(dbPath, 'kirocli:social:token', 'desktop', true)
  } catch {
    return undefined
  }
}

/** The Kiro IDE token file inside the SSO cache directory. */
function kiroIdeTokenPath(ssoCacheDir: string): string {
  return join(ssoCacheDir, 'kiro-auth-token.json')
}

/** The OIDC client registration file beside the IDE token, named by its hash. */
function kiroIdeClientPath(ssoCacheDir: string, clientIdHash: string): string {
  return join(ssoCacheDir, `${clientIdHash}.json`)
}

/**
 * Read the Kiro IDE token (and its OIDC client registration) written by the
 * Kiro IDE after every successful login, when usable.
 * @param allowExpired - whether to accept an expired access token for refresh.
 * @param paths - optional path overrides.
 * @returns the credential facts, or undefined when the IDE has no usable token.
 */
export function getKiroIdeCredentials(allowExpired: boolean, paths?: KiroStorePaths): KiroCredentials | undefined {
  const ssoCacheDir = paths?.ssoCacheDir ?? join(homedir(), '.aws', 'sso', 'cache')
  try {
    const tokenPath = kiroIdeTokenPath(ssoCacheDir)
    if (!existsSync(tokenPath)) return undefined

    const tokenData = JSON.parse(readTokenFile(tokenPath)) as {
      accessToken?: string
      refreshToken?: string
      expiresAt?: string
      region?: string
      clientIdHash?: string
    }
    if (!tokenData.accessToken || !tokenData.refreshToken) return undefined

    const expiresAt = new Date(tokenData.expiresAt ?? '').getTime()
    if (!Number.isFinite(expiresAt)) return undefined
    if (!allowExpired && Date.now() >= expiresAt - EXPIRY_BUFFER_MS) return undefined

    const region = tokenData.region ?? 'us-east-1'
    let clientId = ''
    let clientSecret = ''
    if (tokenData.clientIdHash) {
      const clientPath = kiroIdeClientPath(ssoCacheDir, tokenData.clientIdHash)
      if (existsSync(clientPath)) {
        try {
          const reg = JSON.parse(readTokenFile(clientPath)) as { clientId?: string; clientSecret?: string }
          clientId = reg.clientId ?? ''
          clientSecret = reg.clientSecret ?? ''
        } catch {
          // Ignore a malformed registration: the token still works until expiry
        }
      }
    }
    return {
      refresh: `${tokenData.refreshToken}|${clientId}|${clientSecret}|idc`,
      access: tokenData.accessToken,
      // The IDE token's expiry is real AWS expiry; buffer it for refresh lead time
      expires: expiresAt - EXPIRY_BUFFER_MS,
      clientId,
      clientSecret,
      region,
      authMethod: 'idc',
    }
  } catch {
    return undefined
  }
}

/** Read one JSON credential file as text. */
function readTokenFile(path: string): string {
  return readFileSync(path, 'utf-8')
}

/**
 * Write refreshed credential facts back into the kiro-cli database so both
 * consumers stay in sync. Only keys that already exist are updated; a store
 * this provider never seeded is left untouched.
 * @param creds - the refreshed credential facts.
 * @param paths - optional path overrides.
 */
export function saveKiroCliCredentials(creds: KiroCredentials, paths?: KiroStorePaths): void {
  const dbPath = getKiroCliDbPath(paths)
  if (!dbPath) return

  const rawRefreshToken = creds.refresh.split('|')[0] ?? ''
  // Our expires carries a 2-minute buffer; restore the approximate real expiry
  const expiresAt = new Date(creds.expires + EXPIRY_BUFFER_MS).toISOString()

  for (const key of TOKEN_KEYS[creds.authMethod] ?? []) {
    const existing = queryKiroCliDb(dbPath, `SELECT value FROM auth_kv WHERE key = '${key}'`)
    if (!existing) continue
    try {
      const rows = JSON.parse(existing) as Array<{ value: string }>
      if (!rows[0]?.value) continue
      const tokenData = JSON.parse(rows[0].value) as StoredToken
      tokenData.access_token = creds.access
      tokenData.refresh_token = rawRefreshToken
      tokenData.expires_at = expiresAt
      if (creds.region) tokenData.region = creds.region
      if (creds.profileArn) tokenData.profile_arn = creds.profileArn

      const escaped = JSON.stringify(tokenData).replace(/'/g, "''")
      execKiroCliDb(dbPath, `UPDATE auth_kv SET value = '${escaped}' WHERE key = '${key}';`)
    } catch {
      // Malformed stored row: nothing to update for this key
    }
  }
}

/**
 * Ask kiro-cli to refresh its own tokens, then re-read the database. Used as
 * the last refresh layer: kiro-cli owns the full device-code session state and
 * can rotate tokens this provider cannot.
 * @param paths - optional path overrides.
 * @returns the refreshed credential facts, or undefined when kiro-cli is not
 * installed or still holds nothing usable.
 */
export function refreshViaKiroCli(paths?: KiroStorePaths): KiroCredentials | undefined {
  try {
    execFileSync('kiro-cli', ['debug', 'refresh-auth-token'], {
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return getKiroCliCredentials(paths)
  } catch {
    return undefined
  }
}