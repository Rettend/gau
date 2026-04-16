import { describe, expect, it, vi } from 'vitest'
import { Facebook } from '../../../src/oauth/providers/facebook'

const mockTokens = {
  accessToken: () => 'test_access_token',
  accessTokenExpiresAt: () => new Date(Date.now() + 3600 * 1000),
  refreshToken: () => 'test_refresh_token',
}

const mockUser = {
  id: '123',
  name: 'Test User',
  email: 'public@example.com',
  picture: { data: { url: 'https://example.com/avatar.png' } },
}

vi.stubGlobal('fetch', vi.fn((url: string) => {
  if (url.startsWith('https://graph.facebook.com/me')) {
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
      createAuthorizationURLWithPKCE = vi.fn(() => new URL('https://www.facebook.com/dialog/oauth?mock=true'))
      validateAuthorizationCode = vi.fn(() => Promise.resolve(mockTokens))
    }),
  }
})

describe('facebook Provider', () => {
  const provider = Facebook({
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    params: { display: 'page', auth_type: 'reauthenticate' },
  })

  it('should create an authorization URL', async () => {
    const url = await provider.getAuthorizationUrl('state', 'code-verifier')
    expect(url.toString()).toContain('https://www.facebook.com/dialog/oauth')
    expect(url.toString()).toContain('mock=true')
    expect(url.searchParams.get('display')).toBe('page')
    expect(url.searchParams.get('auth_type')).toBe('reauthenticate')
  })

  it('should validate the callback and return user data', async () => {
    const { user, tokens } = await provider.validateCallback('code', 'code-verifier')

    expect(tokens.accessToken()).toBe('test_access_token')
    expect(user.id).toBe('123')
    expect(user.name).toBe('Test User')
    expect(user.email).toBe('public@example.com')
    expect(user.emailVerified).toBe(true)
    expect(user.avatar).toBe('https://example.com/avatar.png')
    expect(user.raw).toEqual(mockUser)
  })

  it('applies default scopes and allows extra params', async () => {
    const url = await provider.getAuthorizationUrl('state', 'code-verifier', { params: { display: 'popup' } })
    expect(url.toString()).toContain('https://www.facebook.com/dialog/oauth')
    expect(url.toString()).toContain('mock=true')
    expect(url.searchParams.get('display')).toBe('popup')
    expect(url.searchParams.get('auth_type')).toBe('reauthenticate')
  })

  it('handles picture as string in response', async () => {
    ;(fetch as any).mockImplementationOnce((url: string) => {
      if (url.startsWith('https://graph.facebook.com/me')) {
        const mock = { ...mockUser, picture: 'https://example.com/pic.jpg' }
        return Promise.resolve(new Response(JSON.stringify(mock), { headers: { 'Content-Type': 'application/json' } }))
      }
      return Promise.reject(new Error(`Unhandled fetch mock for ${url}`))
    })

    const { user } = await provider.validateCallback('code', 'code-verifier')
    expect(user.avatar).toBe('https://example.com/pic.jpg')
  })
})
