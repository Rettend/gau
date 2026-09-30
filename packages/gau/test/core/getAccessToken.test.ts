import type { OAuthProvider } from '../../src/oauth'
import { describe, expect, it, vi } from 'vite-plus/test'
import { MemoryAdapter } from '../../src/adapters/memory/index'
import { createAuth } from '../../src/core/createAuth'

describe('auth.getAccessToken', () => {
  it('refreshes expired access token and rotates refresh token', async () => {
    const provider: OAuthProvider<'prov'> = {
      id: 'prov',
      requiresRedirectUri: false,
      getAuthorizationUrl: vi.fn(async () => new URL('https://example.com/auth')),
      validateCallback: vi.fn(async () => {
        throw new Error('not used')
      }),
      refreshAccessToken: vi.fn(async () => ({
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        tokenType: 'Bearer',
        scope: 'read',
      })),
    }

    const adapter = MemoryAdapter()
    const auth = createAuth({ adapter, providers: [provider], jwt: { secret: 's', algorithm: 'HS256' } })

    const user = await auth.createUser({ email: 't@example.com' })
    const expired = Math.floor(Date.now() / 1000) - 10
    await auth.linkAccount({ userId: user.id, provider: 'prov', providerAccountId: 'p1', accessToken: 'old', refreshToken: 'r1', expiresAt: expired })

    const updateSpy = vi.spyOn(adapter, 'updateAccount')

    const result = await auth.getAccessToken(user.id, 'prov')
    expect(result).not.toBeNull()
    expect(result!.accessToken).toBe('new-access')
    expect(provider.refreshAccessToken).toHaveBeenCalledWith('r1', expect.anything())
    expect(updateSpy).toHaveBeenCalled()

    const accounts = await auth.getAccounts(user.id)
    const acc = accounts.find(a => a.provider === 'prov')!
    expect(acc.accessToken).toBe('new-access')
    expect(acc.refreshToken).toBe('new-refresh')
  })

  it('returns current token when not expired and does not call refresh', async () => {
    const provider: OAuthProvider<'prov'> = {
      id: 'prov',
      requiresRedirectUri: false,
      getAuthorizationUrl: vi.fn(async () => new URL('https://example.com/auth')),
      validateCallback: vi.fn(async () => { throw new Error('not used') }),
    }
    const adapter = MemoryAdapter()
    const auth = createAuth({ adapter, providers: [provider], jwt: { secret: 's', algorithm: 'HS256' } })

    const user = await auth.createUser({ email: 'u@example.com' })
    const future = Math.floor(Date.now() / 1000) + 3600
    await auth.linkAccount({ userId: user.id, provider: 'prov', providerAccountId: 'p1', accessToken: 'alive', expiresAt: future })

    const result = await auth.getAccessToken(user.id, 'prov')
    expect(result).toEqual({ accessToken: 'alive', expiresAt: future })
  })
})
