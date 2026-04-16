import { afterEach, describe, expect, it, vi } from 'vitest'
import { Google } from '../../src/oauth/providers/google'
import { Microsoft } from '../../src/oauth/providers/microsoft'

describe('provider refreshAccessToken', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('google refreshAccessToken posts to token endpoint', async () => {
    const provider = Google({ clientId: 'id', clientSecret: 'secret' })
    const now = Math.floor(Date.now() / 1000)
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain('oauth2.googleapis.com/token')
      expect(init?.method).toBe('POST')
      return new Response(JSON.stringify({
        access_token: 'new',
        refresh_token: 'rotated',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'read',
      }), { headers: { 'Content-Type': 'application/json' } })
    }))

    const res = await provider.refreshAccessToken!('old')
    expect(res.accessToken).toBe('new')
    expect(res.refreshToken).toBe('rotated')
    expect(res.expiresAt! >= now).toBe(true)
    expect(res.tokenType).toBe('Bearer')
    expect(res.scope).toBe('read')
  })

  it('google refreshAccessToken falls back to previous refresh token', async () => {
    const provider = Google({ clientId: 'id', clientSecret: 'secret' })
    vi.stubGlobal('fetch', vi.fn(async () => {
      return new Response(JSON.stringify({
        access_token: 'new',
        expires_in: '60',
      }), { headers: { 'Content-Type': 'application/json' } })
    }))

    const res = await provider.refreshAccessToken!('old')
    expect(res.accessToken).toBe('new')
    expect(res.refreshToken).toBe('old')
    expect(typeof res.expiresAt).toBe('number')
    expect(res.idToken).toBe(null)
  })

  it('microsoft refreshAccessToken posts to tenant token endpoint', async () => {
    const provider = Microsoft({ clientId: 'id', clientSecret: 'secret' })
    const now = Math.floor(Date.now() / 1000)
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain('/oauth2/v2.0/token')
      expect(init?.method).toBe('POST')
      return new Response(JSON.stringify({
        access_token: 'new-ms',
        refresh_token: 'rotated-ms',
        expires_in: 1800,
        token_type: 'Bearer',
        scope: 'email',
        id_token: 'id',
      }), { headers: { 'Content-Type': 'application/json' } })
    }))

    const res = await provider.refreshAccessToken!('old')
    expect(res.accessToken).toBe('new-ms')
    expect(res.refreshToken).toBe('rotated-ms')
    expect(res.expiresAt! >= now).toBe(true)
    expect(res.tokenType).toBe('Bearer')
    expect(res.scope).toBe('email')
    expect(res.idToken).toBe('id')
  })

  it('microsoft refreshAccessToken uses scope override when provided', async () => {
    const provider = Microsoft({ clientId: 'id', clientSecret: 'secret' })
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = init?.body as URLSearchParams
      expect(body.get('scope')).toBe('offline_access User.ReadBasic.All')

      return new Response(JSON.stringify({
        access_token: 'new-ms',
      }), { headers: { 'Content-Type': 'application/json' } })
    }))

    const res = await provider.refreshAccessToken!('old', {
      scopes: ['offline_access', 'User.ReadBasic.All'],
    })
    expect(res.accessToken).toBe('new-ms')
    expect(res.refreshToken).toBe('old')
  })
})
