import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryAdapter } from '../../../src/adapters'
import { CSRF_COOKIE_NAME, LINKING_TOKEN_COOKIE_NAME, PKCE_COOKIE_NAME } from '../../../src/core/cookies'
import { createAuth } from '../../../src/core/createAuth'
import { ErrorCodes } from '../../../src/core/errors'
import { handleCallback } from '../../../src/core/handlers/callback'
import { mockProvider } from '../../handler'

describe('callback linking options', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
  })

  it('rejects linking when emails differ and allowDifferentEmails is false', async () => {
    const auth = createAuth({
      adapter: MemoryAdapter(),
      providers: [mockProvider],
      jwt: { secret: 's', algorithm: 'HS256' },
      allowDifferentEmails: false,
    })

    // existing user has different email
    const existing = await auth.createUser({ email: 'primary@site.com', name: null, image: null })
    const sessionToken = await auth.createSession(existing.id)

    // provider returns different email
    mockProvider.validateCallback.mockResolvedValueOnce({
      user: { id: 'provider-user-id', name: 'Provider User', email: 'other@provider.com', emailVerified: true, avatar: 'https://avatar.url', raw: {} },
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

    const request = new Request('http://localhost/api/auth/callback/mock?code=c&state=state')
    request.headers.set('Cookie', `${LINKING_TOKEN_COOKIE_NAME}=${sessionToken}; ${CSRF_COOKIE_NAME}=state; ${PKCE_COOKIE_NAME}=pkce`)

    await expect(handleCallback(request, auth, 'mock')).rejects.toMatchObject({
      code: ErrorCodes.EMAIL_MISMATCH,
      status: 400,
    })

    const linked = await auth.getUserByAccount('mock', 'provider-user-id')
    expect(linked).toBeNull()
  })

  it('allows linking when emails differ by default (allowDifferentEmails=true)', async () => {
    const auth = createAuth({
      adapter: MemoryAdapter(),
      providers: [mockProvider],
      jwt: { secret: 's', algorithm: 'HS256' },
    })

    const existing = await auth.createUser({ email: 'primary@site.com' })
    const sessionToken = await auth.createSession(existing.id)

    mockProvider.validateCallback.mockResolvedValueOnce({
      user: { id: 'provider-user-id', name: 'Provider User', email: 'other@provider.com', emailVerified: true, avatar: 'https://avatar.url', raw: {} },
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

    const request = new Request('http://localhost/api/auth/callback/mock?code=c&state=state')
    request.headers.set('Cookie', `${LINKING_TOKEN_COOKIE_NAME}=${sessionToken}; ${CSRF_COOKIE_NAME}=state; ${PKCE_COOKIE_NAME}=pkce`)

    const response = await handleCallback(request, auth, 'mock')
    expect([200, 302]).toContain(response.status)

    const linked = await auth.getUserByAccount('mock', 'provider-user-id')
    expect(linked?.id).toBe(existing.id)
  })

  it('reuses the linking session across the callback flow', async () => {
    const auth = createAuth({
      adapter: MemoryAdapter(),
      providers: [mockProvider],
      jwt: { secret: 's', algorithm: 'HS256' },
    })

    const existing = await auth.createUser({ email: 'user@provider.com' })
    const sessionToken = await auth.createSession(existing.id)
    const validateSessionSpy = vi.spyOn(auth, 'validateSession')

    const request = new Request('http://localhost/api/auth/callback/mock?code=c&state=state')
    request.headers.set('Cookie', `${LINKING_TOKEN_COOKIE_NAME}=${sessionToken}; ${CSRF_COOKIE_NAME}=state; ${PKCE_COOKIE_NAME}=pkce`)

    const response = await handleCallback(request, auth, 'mock')
    expect([200, 302]).toContain(response.status)
    expect(validateSessionSpy).toHaveBeenCalledTimes(1)
  })

  it('updates missing name/image when updateUserInfoOnLink is true', async () => {
    const auth = createAuth({
      adapter: MemoryAdapter(),
      providers: [mockProvider],
      jwt: { secret: 's', algorithm: 'HS256' },
      updateUserInfoOnLink: true,
    })

    const existing = await auth.createUser({ email: 'user@provider.com', name: null, image: null, emailVerified: false })
    const sessionToken = await auth.createSession(existing.id)

    const request = new Request('http://localhost/api/auth/callback/mock?code=c&state=state')
    request.headers.set('Cookie', `${LINKING_TOKEN_COOKIE_NAME}=${sessionToken}; ${CSRF_COOKIE_NAME}=state; ${PKCE_COOKIE_NAME}=pkce`)

    const response = await handleCallback(request, auth, 'mock')
    expect([200, 302]).toContain(response.status)

    const updated = await auth.getUser(existing.id)
    expect(updated?.name).toBe('Provider User')
    expect(updated?.image).toBe('https://avatar.url')
  })

  it('fills missing fields even when updateUserInfoOnLink is false', async () => {
    const auth = createAuth({
      adapter: MemoryAdapter(),
      providers: [mockProvider],
      jwt: { secret: 's', algorithm: 'HS256' },
      updateUserInfoOnLink: false,
    })

    const existing = await auth.createUser({ email: 'user@provider.com', name: null, image: null })
    const sessionToken = await auth.createSession(existing.id)

    const request = new Request('http://localhost/api/auth/callback/mock?code=c&state=state')
    request.headers.set('Cookie', `${LINKING_TOKEN_COOKIE_NAME}=${sessionToken}; ${CSRF_COOKIE_NAME}=state; ${PKCE_COOKIE_NAME}=pkce`)

    const response = await handleCallback(request, auth, 'mock')
    expect([200, 302]).toContain(response.status)

    const updated = await auth.getUser(existing.id)
    expect(updated?.name).toBe('Provider User')
    expect(updated?.image).toBe('https://avatar.url')
  })

  it('overwrites name/image when updateUserInfoOnLink is true', async () => {
    const auth = createAuth({
      adapter: MemoryAdapter(),
      providers: [mockProvider],
      jwt: { secret: 's', algorithm: 'HS256' },
      updateUserInfoOnLink: true,
    })

    const existing = await auth.createUser({ email: 'user@provider.com', name: 'Old', image: 'old.png', emailVerified: false })
    const sessionToken = await auth.createSession(existing.id)

    const request = new Request('http://localhost/api/auth/callback/mock?code=c&state=state')
    request.headers.set('Cookie', `${LINKING_TOKEN_COOKIE_NAME}=${sessionToken}; ${CSRF_COOKIE_NAME}=state; ${PKCE_COOKIE_NAME}=pkce`)

    const response = await handleCallback(request, auth, 'mock')
    expect([200, 302]).toContain(response.status)

    const updated = await auth.getUser(existing.id)
    expect(updated?.name).toBe('Provider User')
    expect(updated?.image).toBe('https://avatar.url')
    // emailVerified should be lifted since provider email matches and is verified
    expect(updated?.emailVerified).toBe(true)
  })
})
