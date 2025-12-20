import { describe, expect, it, vi } from 'vitest'
import { GitHub } from '../../../src/oauth/providers/github'

const mockTokens = {
  accessToken: () => 'test_access_token',
  accessTokenExpiresAt: () => new Date(Date.now() + 3600 * 1000),
  refreshToken: () => 'test_refresh_token',
}
const mockUser = { id: 123, login: 'testuser', name: 'Test User', email: 'public@example.com', avatar_url: 'https://example.com/avatar.png' }
const mockEmails = [
  { email: 'unverified@example.com', primary: false, verified: false, visibility: 'private' },
  { email: 'verified-not-primary@example.com', primary: false, verified: true, visibility: 'public' },
  { email: 'primary-verified@example.com', primary: true, verified: true, visibility: 'public' },
]

vi.stubGlobal('fetch', vi.fn((url: string) => {
  if (url.includes('/user/emails')) {
    return Promise.resolve(new Response(JSON.stringify(mockEmails), {
      headers: { 'Content-Type': 'application/json' },
    }))
  }
  if (url.includes('/user')) {
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
      createAuthorizationURLWithPKCE = vi.fn(() => new URL('https://github.com/login/oauth/authorize?mock=true'))
      validateAuthorizationCode = vi.fn(() => Promise.resolve(mockTokens))
    }),
  }
})

describe('gitHub Provider', () => {
  const provider = GitHub({
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
  })

  it('should create an authorization URL', async () => {
    const url = await provider.getAuthorizationUrl('state', 'code-verifier')
    expect(url.toString()).toContain('https://github.com/login/oauth/authorize')
    expect(url.toString()).toContain('mock=true')
  })

  it('should validate the callback and return user data', async () => {
    const { user, tokens } = await provider.validateCallback('code', 'code-verifier')

    expect(tokens.accessToken()).toBe('test_access_token')
    expect(user.id).toBe('123')
    expect(user.name).toBe('Test User')
    expect(user.email).toBe('primary-verified@example.com')
    expect(user.emailVerified).toBe(true)
    expect(user.avatar).toBe('https://example.com/avatar.png')
    expect(user.raw).toEqual(mockUser)
  })
})
