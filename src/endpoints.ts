/**
 * Kiro API region and endpoint resolution. SSO regions map to the Kiro API
 * regions that serve them; every endpoint derives from one resolved region.
 * @module dsh-llm-kiro/endpoints
 */

/** SSO region to Kiro API region mapping observed from the kiro.dev sign-in surface. */
const API_REGION_MAP: Record<string, string> = {
  'us-west-1': 'us-east-1',
  'us-west-2': 'us-east-1',
  'us-east-2': 'us-east-1',
  'ap-southeast-1': 'us-east-1',
  'ap-southeast-2': 'us-east-1',
  'ap-northeast-1': 'us-east-1',
  'ap-south-1': 'us-east-1',
  'eu-west-1': 'eu-central-1',
  'eu-west-2': 'eu-central-1',
  'eu-west-3': 'eu-central-1',
  'eu-north-1': 'eu-central-1',
  'eu-south-1': 'eu-central-1',
  'eu-south-2': 'eu-central-1',
  'eu-central-2': 'eu-central-1',
}

/** The default Kiro API region when nothing discloses one. */
export const DEFAULT_KIRO_REGION = 'us-east-1'

/**
 * Resolve the Kiro API region for one SSO region. Unmapped regions pass
 * through unchanged; an absent region falls back to the default.
 * @param ssoRegion - the SSO/OIDC region a credential was minted in.
 * @returns the Kiro API region serving that SSO region.
 */
export function resolveApiRegion(ssoRegion: string | undefined): string {
  if (!ssoRegion) return DEFAULT_KIRO_REGION
  return API_REGION_MAP[ssoRegion] ?? ssoRegion
}

/** The management and runtime endpoints for one Kiro API region. */
export interface KiroEndpoints {
  region: string
  management: string
  runtime: string
}

/**
 * Build the kiro.dev endpoints for one region.
 * @param region - the Kiro API region.
 * @returns management and runtime base URLs for that region.
 */
export function getKiroEndpoints(region: string): KiroEndpoints {
  return {
    region,
    management: `https://management.${region}.kiro.dev/`,
    runtime: `https://runtime.${region}.kiro.dev/`,
  }
}

/**
 * Read the region out of a kiro.dev endpoint URL, when the URL is one.
 * @param endpoint - a management or runtime base URL.
 * @returns the region, or undefined for a non-kiro.dev URL.
 */
export function getKiroRegionFromEndpoint(endpoint: string): string | undefined {
  try {
    const [service, region, ...suffix] = new URL(endpoint).hostname.split('.')
    const domain = suffix.join('.')
    if ((service === 'management' || service === 'runtime') && domain === 'kiro.dev') return region
    return undefined
  } catch {
    return undefined
  }
}
