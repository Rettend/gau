import type { Mocked } from 'vitest'
import type { OAuthProvider } from '../src/oauth'
import { vi } from 'vitest'
import { MemoryAdapter } from '../src/adapters'
import { createAuth } from '../src/core/createAuth'

export const mockProvider: Mocked<OAuthProvider<'mock'>> = {
  id: 'mock',
  requiresRedirectUri: true,
  getAuthorizationUrl: vi
    .fn()
    .mockResolvedValue(new URL('https://provider.com/auth')),
  validateCallback: vi
    .fn()
    .mockResolvedValue({
      user: {
        id: 'provider-user-id',
        name: 'Provider User',
        email: 'user@provider.com',
        emailVerified: true,
        avatar: 'https://avatar.url',
        raw: {},
      },
      tokens: {
        data: {},
        accessToken: () => 'access-token',
        refreshToken: () => 'refresh-token',
        idToken: () => 'id-token',
        accessTokenExpiresAt: () => new Date(Date.now() + 3600 * 1000),
        accessTokenExpiresInSeconds: () => 3600,
        scopes: () => ['read'],
        hasScopes: () => true,
        hasRefreshToken: () => true,
        tokenType: () => 'Bearer',
      },
    }),
  linkOnly: false,
}

export function setup() {
  vi.clearAllMocks()
  mockProvider.getAuthorizationUrl.mockResolvedValue(new URL('https://provider.com/auth'))
  mockProvider.validateCallback.mockResolvedValue({
    user: { id: 'provider-user-id', name: 'Provider User', email: 'user@provider.com', emailVerified: true, avatar: 'https://avatar.url', raw: {} },
    tokens: {
      data: {},
      accessToken: () => 'access-token',
      refreshToken: () => 'refresh-token',
      idToken: () => 'id-token',
      accessTokenExpiresAt: () => new Date(Date.now() + 3600 * 1000),
      accessTokenExpiresInSeconds: () => 3600,
      scopes: () => ['read'],
      hasScopes: () => true,
      hasRefreshToken: () => true,
      tokenType: () => 'Bearer',
    },
  })
  mockProvider.linkOnly = false

  const auth = createAuth({
    adapter: MemoryAdapter(),
    providers: [mockProvider],
    jwt: { secret: 'test-secret', algorithm: 'HS256', ttl: 3600 },
    trustHosts: ['trusted.app.com'],
  })

  return { auth, mockProvider }
}
