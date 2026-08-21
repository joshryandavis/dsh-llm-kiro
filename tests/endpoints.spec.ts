import { describe, expect, it } from 'vitest'
import { DEFAULT_KIRO_REGION, getKiroEndpoints, getKiroRegionFromEndpoint, resolveApiRegion } from '../src/endpoints.ts'

describe('llm-kiro endpoints', () => {
  it('maps SSO regions to their Kiro API regions', () => {
    expect(resolveApiRegion('us-west-2')).toBe('us-east-1')
    expect(resolveApiRegion('eu-west-1')).toBe('eu-central-1')
    expect(resolveApiRegion('ap-northeast-1')).toBe('us-east-1')
  })

  it('passes unmapped regions through and defaults absent regions', () => {
    expect(resolveApiRegion('ap-southeast-3')).toBe('ap-southeast-3')
    expect(resolveApiRegion(undefined)).toBe(DEFAULT_KIRO_REGION)
  })

  it('builds management and runtime endpoints for one region', () => {
    expect(getKiroEndpoints('eu-central-1')).toEqual({
      region: 'eu-central-1',
      management: 'https://management.eu-central-1.kiro.dev/',
      runtime: 'https://runtime.eu-central-1.kiro.dev/',
    })
  })

  it('reads the region back out of a kiro.dev endpoint', () => {
    expect(getKiroRegionFromEndpoint('https://runtime.us-east-1.kiro.dev/')).toBe('us-east-1')
    expect(getKiroRegionFromEndpoint('https://management.eu-central-1.kiro.dev/')).toBe('eu-central-1')
  })

  it('rejects non-kiro.dev endpoints and malformed URLs', () => {
    expect(getKiroRegionFromEndpoint('https://api.deepseek.com')).toBeUndefined()
    expect(getKiroRegionFromEndpoint('not a url')).toBeUndefined()
  })
})
