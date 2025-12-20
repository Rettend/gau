import { describe, expect, it, vi } from 'vitest'
import { Discord } from '../../../src/oauth/providers/discord'

const mockTokens = {
  accessToken: () => 'test_access_token',
  accessTokenExpiresAt: () => new Date(Date.now() + 3600 * 1000),
  refreshToken: () => 'test_refresh_token',
}

const mockUser = {
  id: '1234567890',
  username: 'TestUser',
  discriminator: '0001',
  avatar: 'avatarhash',
  email: 'public@example.com',
  verified: true,
}

vi.stubGlobal('fetch', vi.fn((url: string) => {
  if (typeof url === 'string' && url.includes('/users/@me')) {
    return Promise.resolve(new Response(JSON.stringify(mockUser), {
      headers: { 'Content-Type': 'application/json' },
    }))
  }
  if (typeof url === 'string' && url.includes('/oauth2/token')) {
    const json = {
      access_token: 'new_access_token',
      token_type: 'Bearer',
      scope: 'identify email',
      expires_in: 3600,
      refresh_token: 'new_refresh_token',
    }
    return Promise.resolve(new Response(JSON.stringify(json), {
      headers: { 'Content-Type': 'application/json' },
    }))
  }
  return Promise.reject(new Error(`Unhandled fetch mock for ${url}`))
}))

vi.mock('arctic', async (importOriginal) => {
  const original = await importOriginal<typeof import('arctic')>()
  return {
    ...original,
    OAuth2Client: vi.fn(class {
      createAuthorizationURLWithPKCE = vi.fn(() => new URL('https://discord.com/api/oauth2/authorize?mock=true'))
      validateAuthorizationCode = vi.fn(() => Promise.resolve(mockTokens))
    }),
  }
})

describe('discord Provider', () => {
  const provider = Discord({
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
  })

  it('should create an authorization URL', async () => {
    const url = await provider.getAuthorizationUrl('state', 'code-verifier')
    expect(url.toString()).toContain('https://discord.com/api/oauth2/authorize')
    expect(url.toString()).toContain('mock=true')
  })

  it('should validate the callback and return user data', async () => {
    const { user, tokens } = await provider.validateCallback('code', 'code-verifier')

    expect(tokens.accessToken()).toBe('test_access_token')
    expect(user.id).toBe(mockUser.id)
    expect(user.name).toBe(mockUser.username)
    expect(user.email).toBe('public@example.com')
    expect(user.emailVerified).toBe(true)
    expect(user.avatar).toBe(`https://cdn.discordapp.com/avatars/${mockUser.id}/${mockUser.avatar}.png`)
    expect(user.raw).toEqual(mockUser)
  })

  it('refreshAccessToken returns rotated tokens and computes expiresAt', async () => {
    const refreshed = await provider.refreshAccessToken!('old_refresh_token')
    expect(refreshed.accessToken).toBe('new_access_token')
    expect(refreshed.refreshToken).toBe('new_refresh_token')
    expect(typeof refreshed.expiresAt === 'number' || refreshed.expiresAt === null).toBe(true)
    expect(refreshed.tokenType).toBe('Bearer')
    expect(refreshed.scope).toBe('identify email')
  })

  it('refreshAccessToken falls back to previous refresh token when not returned', async () => {
    void (fetch as any).mockImplementationOnce((url: string) => {
      if (url.includes('/oauth2/token')) {
        const json = {
          access_token: 'another_access_token',
          token_type: 'Bearer',
          scope: 'identify email',
          expires_in: 1800,
        }
        return Promise.resolve(new Response(JSON.stringify(json), {
          headers: { 'Content-Type': 'application/json' },
        }))
      }
      return Promise.reject(new Error(`Unhandled fetch mock for ${url}`))
    })

    const refreshed = await provider.refreshAccessToken!('previous_refresh')
    expect(refreshed.accessToken).toBe('another_access_token')
    expect(refreshed.refreshToken).toBe('previous_refresh')
  })
})
