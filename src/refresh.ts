/**
 * Kiro token refresh. IDC (Builder ID / IAM Identity Center) tokens refresh
 * through the AWS SSO OIDC `/token` endpoint with a `refresh_token` grant;
 * desktop (Google/GitHub social) tokens refresh through the Kiro desktop auth
 * service. Refreshed tokens are written back to the kiro-cli store so both
 * consumers share one credential generation.
 * @module dsh-llm-kiro/refresh
 */

import type { KiroCredentials } from './types.ts'
import { getKiroCliCredentials, getKiroCliCredentialsAllowExpired, getKiroIdeCredentials, refreshViaKiroCli, saveKiroCliCredentials, type KiroStorePaths } from './kiro-cli.ts'

/** Refresh lead time subtracted from access-token expiry at refresh time. */
const EXPIRES_BUFFER_MS = 5 * 60 * 1000

/** Kiro desktop auth refresh endpoint template; {region} is the API region. */
export const KIRO_DESKTOP_REFRESH_URL = 'https://prod.{region}.auth.desktop.kiro.dev/refreshToken'

/** The AWS SSO OIDC token endpoint for one region. */
function oidcTokenEndpoint(region: string): string {
  return `https://oidc.${region}.amazonaws.com/token`
}

/** Response of the AWS SSO OIDC token endpoint for a refresh grant. */
interface OidcTokenResponse {
  accessToken?: string
  refreshToken?: string
  expiresIn?: number
  error?: string
}

/** Response of the Kiro desktop refresh endpoint. */
interface DesktopRefreshResponse {
  accessToken?: string
  refreshToken?: string
  expiresIn?: number
  profileArn?: string
  error?: string
}

/**
 * Refresh one credential through its own transport. The packed `refresh`
 * string carries the refresh token and, for IDC, the client registration.
 * @param credentials - the credential facts to refresh.
 * @returns the refreshed credential facts.
 * @throws Error when the refresh endpoint rejects the request.
 */
export async function refreshKiroToken(credentials: KiroCredentials): Promise<KiroCredentials> {
  const parts = credentials.refresh.split('|')
  const refreshToken = parts[0] ?? ''
  const authMethod = (parts[parts.length - 1] ?? 'idc') as KiroCredentials['authMethod']
  const region = credentials.region || 'us-east-1'

  if (authMethod === 'desktop') {
    const url = KIRO_DESKTOP_REFRESH_URL.replace('{region}', region)
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    })
    if (!response.ok) throw new Error(`Kiro desktop token refresh failed: ${response.status}`)
    const data = (await response.json()) as DesktopRefreshResponse
    if (!data.accessToken) throw new Error('Kiro desktop token refresh: missing accessToken')
    return {
      refresh: `${data.refreshToken || refreshToken}|desktop`,
      access: data.accessToken,
      expires: Date.now() + (data.expiresIn ?? 3600) * 1000 - EXPIRES_BUFFER_MS,
      clientId: '',
      clientSecret: '',
      region,
      authMethod: 'desktop',
      ...(data.profileArn || credentials.profileArn ? { profileArn: data.profileArn || credentials.profileArn } : {}),
    }
  }

  const clientId = parts[1] ?? ''
  const clientSecret = parts[2] ?? ''
  const response = await fetch(oidcTokenEndpoint(region), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, clientSecret, refreshToken, grantType: 'refresh_token' }),
  })
  if (!response.ok) throw new Error(`Kiro IDC token refresh failed: ${response.status}`)
  const data = (await response.json()) as OidcTokenResponse
  if (!data.accessToken) throw new Error(`Kiro IDC token refresh: ${data.error ?? 'missing accessToken'}`)
  return {
    refresh: `${data.refreshToken || refreshToken}|${clientId}|${clientSecret}|idc`,
    access: data.accessToken,
    expires: Date.now() + (data.expiresIn ?? 3600) * 1000 - EXPIRES_BUFFER_MS,
    clientId,
    clientSecret,
    region,
    authMethod: 'idc',
  }
}

/**
 * Resolve a usable credential before a request, refreshing expired ambient
 * tokens silently. Prefers a fresh kiro-cli or Kiro IDE credential, then
 * attempts a direct refresh of an expired one, writing the result back to
 * kiro-cli.
 * @param paths - optional credential store path overrides.
 * @returns a valid credential, or undefined when nothing can be refreshed.
 */
export async function resolveUsableKiroCredential(paths?: KiroStorePaths): Promise<KiroCredentials | undefined> {
  // Layer 0: the Kiro IDE token — the freshest source, covering IdC logins.
  const ideCreds = getKiroIdeCredentials(false, paths)
  if (ideCreds) return ideCreds

  // Layer 1: a valid kiro-cli token (IdC preferred, social fallback).
  const cliCreds = getKiroCliCredentials(paths)
  if (cliCreds) return cliCreds

  // Layer 2: an expired IDE token with a refresh token — silent OIDC refresh.
  const expiredIdeCreds = getKiroIdeCredentials(true, paths)
  if (expiredIdeCreds) {
    try {
      return await refreshKiroToken(expiredIdeCreds)
    } catch {
      // Fall through to the kiro-cli refresh layer
    }
  }

  // Layer 3: an expired kiro-cli token — silent refresh with write-back.
  const expiredCliCreds = getKiroCliCredentialsAllowExpired(paths)
  if (expiredCliCreds) {
    try {
      const refreshed = await refreshKiroToken(expiredCliCreds)
      saveKiroCliCredentials(refreshed, paths)
      return refreshed
    } catch {
      // Fall through to the kiro-cli owned refresh
    }
  }

  // Layer 4: let kiro-cli rotate its own tokens.
  return refreshViaKiroCli(paths)
}

/**
 * Recover a usable credential after the runtime rejected one with 403. The
 * rejected token may be stale because another process rotated it, so the
 * store is re-read first; a still-rejected generation falls back to a direct
 * refresh and then to kiro-cli's own refresh.
 * @param rejected - the credential the runtime rejected.
 * @param paths - optional credential store path overrides.
 * @param allowKiroCliRefresh - whether the final layer may shell out to kiro-cli.
 * @returns a credential that is not the rejected generation, or undefined.
 */
export async function recoverKiroCredential(
  rejected: KiroCredentials,
  paths?: KiroStorePaths,
  allowKiroCliRefresh = true,
): Promise<KiroCredentials | undefined> {
  const stored = getKiroCliCredentials(paths) ?? getKiroIdeCredentials(false, paths)
  if (stored && stored.access !== rejected.access) return stored

  const expired = getKiroCliCredentialsAllowExpired(paths) ?? getKiroIdeCredentials(true, paths)
  if (expired) {
    try {
      const refreshed = await refreshKiroToken(expired)
      saveKiroCliCredentials(refreshed, paths)
      return refreshed
    } catch {
      // Fall through to the kiro-cli owned refresh
    }
  }
  return allowKiroCliRefresh ? refreshViaKiroCli(paths) : undefined
}
