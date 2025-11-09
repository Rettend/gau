import type { Auth } from '../../../src/core/createAuth'
import type { OAuthProvider } from '../../../src/oauth'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryAdapter } from '../../../src/adapters'
import { CALLBACK_URI_COOKIE_NAME, CSRF_COOKIE_NAME, PKCE_COOKIE_NAME } from '../../../src/core/cookies'
import { createAuth } from '../../../src/core/createAuth'
import { handleCallback } from '../../../src/core/handlers/callback'

describe('callback updates existing account tokens', () => {
  let auth: Auth

  const provider: OAuthProvider<'mock'> = {
    id: 'mock',
    requiresRedirectUri: true,
    getAuthorizationUrl: vi.fn(async () => new URL('https://example.com/auth')),
    validateCallback: vi.fn(async () => ({
      user: { id: 'prov-user', name: 'P', email: 'p@example.com', emailVerified: true, avatar: null, raw: {} },
      tokens: {
        data: {},
        accessToken: () => 'new-access',
        refreshToken: () => 'new-refresh',
        idToken: () => 'new-id',
        accessTokenExpiresAt: () => new Date(Date.now() + 3600 * 1000),
        accessTokenExpiresInSeconds: () => 3600,
        scopes: () => ['read'],
        hasScopes: () => true,
        hasRefreshToken: () => true,
        tokenType: () => 'Bearer',
      },
    })),
  }

  beforeEach(async () => {
    const adapter = MemoryAdapter()
    auth = createAuth({ adapter, providers: [provider], jwt: { secret: 's', algorithm: 'HS256' } })
    const user = await auth.createUser({ email: 'p@example.com' })
    await auth.linkAccount({ userId: user.id, provider: 'mock', providerAccountId: 'prov-user', accessToken: 'old', refreshToken: 'old-refresh', expiresAt: Math.floor(Date.now() / 1000) - 10 })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('updates account tokens for already linked account', async () => {
    const state = 'state'
    const req = new Request(`http://localhost/api/auth/callback/mock?code=c&state=${state}`)
    req.headers.set('Cookie', `${CSRF_COOKIE_NAME}=${state}; ${PKCE_COOKIE_NAME}=pkce; ${CALLBACK_URI_COOKIE_NAME}=uri`)
    const res = await handleCallback(req as any, auth, 'mock')
    expect(res.status).toBe(302)

    const accounts = await auth.getAccounts((await auth.getUserByEmail('p@example.com'))!.id)
    const acc = accounts.find(a => a.provider === 'mock')!
    expect(acc.accessToken).toBe('new-access')
    expect(acc.refreshToken).toBe('new-refresh')
    expect(acc.idToken).toBe('new-id')
  })
})
