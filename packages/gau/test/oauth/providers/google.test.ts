import { describe, expect, it, vi } from 'vitest'
import { Google } from '../../../src/oauth/providers/google'

const mockTokens = {
  accessToken: () => 'test_access_token',
  accessTokenExpiresAt: () => new Date(Date.now() + 3600 * 1000),
  refreshToken: () => 'test_refresh_token',
}
const mockUser = { sub: '1234567890', name: 'Test User', email: 'test@example.com', email_verified: true, picture: 'https://example.com/avatar.png' }

vi.stubGlobal('fetch', vi.fn((url: string) => {
  if (url.includes('openidconnect.googleapis.com/v1/userinfo')) {
    return Promise.resolve(new Response(JSON.stringify(mockUser), {
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
      createAuthorizationURLWithPKCE = vi.fn(() => new URL('https://accounts.google.com/o/oauth2/v2/auth?mock=true'))
      validateAuthorizationCode = vi.fn(() => Promise.resolve(mockTokens))
    }),
  }
})

describe('google Provider', () => {
  const provider = Google({
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    redirectUri: 'http://localhost:5173/api/auth/callback/google',
  })

  it('should create an authorization URL', async () => {
    const url = await provider.getAuthorizationUrl('state', 'code-verifier')
    expect(url.toString()).toContain('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.toString()).toContain('mock=true')
  })

  it('should validate the callback and return user data', async () => {
    const { user, tokens } = await provider.validateCallback('code', 'code-verifier')

    expect(tokens.accessToken()).toBe('test_access_token')
    expect(user.id).toBe('1234567890')
    expect(user.name).toBe('Test User')
    expect(user.email).toBe('test@example.com')
    expect(user.emailVerified).toBe(true)
    expect(user.avatar).toBe('https://example.com/avatar.png')
    expect(user.raw).toEqual(mockUser)
  })
})
