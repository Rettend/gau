import { describe, expect, it, vi } from 'vitest'
import { NULL_SESSION } from '../../src/core'
import { createRequestSessionCache, resolveServerSession } from '../../src/core/serverSession'

function createAuthStub(overrides: Record<string, unknown> = {}) {
  return {
    providerMap: new Map([['github', {}], ['google', {}]]),
    signJWT: vi.fn(),
    validateSession: vi.fn(),
    ...overrides,
  } as any
}

describe('serverSession helpers', () => {
  it('returns NULL_SESSION with configured providers when no token is present', async () => {
    const auth = createAuthStub()

    await expect(resolveServerSession(auth, new Request('http://localhost'))).resolves.toEqual({
      ...NULL_SESSION,
      providers: ['github', 'google'],
    })
  })

  it('shares one validation pass between cached server and client sessions', async () => {
    const auth = createAuthStub({
      validateSession: vi.fn().mockResolvedValue({
        user: { id: '1' },
        session: { id: 'jwt-token', sub: '1', iat: 111, exp: 222 },
        accounts: [{ provider: 'github', providerAccountId: '123', accessToken: 'secret-token' }],
      }),
    })

    const cache = createRequestSessionCache(auth, new Request('http://localhost', {
      headers: { Authorization: 'Bearer token-1' },
    }))

    const serverSession = await cache.getServerSession()
    const sameServerSession = await cache.getServerSession()
    const clientSession = await cache.getSession()

    expect(serverSession).toBe(sameServerSession)
    expect(serverSession.providers).toEqual(['github', 'google'])
    expect(clientSession.session).toEqual({ sub: '1', iat: 111, exp: 222 })
    expect(clientSession.session).not.toHaveProperty('id')
    expect(clientSession.accounts).toEqual([{ provider: 'github', providerAccountId: '123' }])
    expect(clientSession.providers).toEqual(['github', 'google'])
    expect(auth.validateSession).toHaveBeenCalledTimes(1)
    expect(auth.validateSession).toHaveBeenCalledWith('token-1')
  })

  it('reuses preloaded server sessions without revalidating', async () => {
    const auth = createAuthStub()
    const preloaded = {
      user: { id: '2' },
      session: { id: 'jwt-token', sub: '2', iat: 111, exp: 222 },
      accounts: [{ provider: 'google', providerAccountId: '456', accessToken: 'secret-token' }],
      providers: ['github', 'google'],
    }

    const cache = createRequestSessionCache(auth, new Request('http://localhost'), preloaded)

    await expect(cache.getServerSession()).resolves.toBe(preloaded)
    await expect(cache.getSession()).resolves.toEqual({
      user: { id: '2' },
      session: { sub: '2', iat: 111, exp: 222 },
      accounts: [{ provider: 'google', providerAccountId: '456' }],
      providers: ['github', 'google'],
    })
    expect(auth.validateSession).not.toHaveBeenCalled()
  })

  it('returns an isolated providers array for each resolved session', async () => {
    const auth = createAuthStub()

    const first = await resolveServerSession(auth, new Request('http://localhost'))
    first.providers?.push('discord' as any)

    await expect(resolveServerSession(auth, new Request('http://localhost'))).resolves.toEqual({
      ...NULL_SESSION,
      providers: ['github', 'google'],
    })
  })
})
