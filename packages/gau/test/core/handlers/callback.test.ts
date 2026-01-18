import type { Auth } from '../../../src/core/createAuth'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryAdapter } from '../../../src/adapters'
import {
  CALLBACK_URI_COOKIE_NAME,
  CSRF_COOKIE_NAME,
  PKCE_COOKIE_NAME,
  SESSION_COOKIE_NAME,
} from '../../../src/core/cookies'
import { createAuth } from '../../../src/core/createAuth'
import { ErrorCodes } from '../../../src/core/errors'
import { handleCallback } from '../../../src/core/handlers/callback'
import { mockProvider, setup } from '../../handler'

describe('callback handler', () => {
  let auth: Auth

  beforeEach(() => {
    ({ auth } = setup())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should create a new user, link account, and set session cookie', async () => {
    const state = 'state123'
    const code = 'code123'
    const request = new Request(`http://localhost/api/auth/callback/mock?code=${code}&state=${state}`)
    request.headers.set('Cookie', `${CSRF_COOKIE_NAME}=${state}; ${PKCE_COOKIE_NAME}=pkce; ${CALLBACK_URI_COOKIE_NAME}=uri`)

    const response = await handleCallback(request, auth, 'mock')

    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe('/')

    const cookies = response.headers.getSetCookie()
    expect(cookies.some(c => c.startsWith(SESSION_COOKIE_NAME))).toBe(true)
    expect(cookies.some(c => c.startsWith(CSRF_COOKIE_NAME) && c.includes('Max-Age=0'))).toBe(true)
    expect(cookies.some(c => c.startsWith(PKCE_COOKIE_NAME) && c.includes('Max-Age=0'))).toBe(true)
    expect(cookies.some(c => c.startsWith(CALLBACK_URI_COOKIE_NAME) && c.includes('Max-Age=0'))).toBe(true)

    const user = await auth.getUserByEmail('user@provider.com')
    expect(user).not.toBeNull()
    expect(user?.name).toBe('Provider User')
  })

  it('should link to an existing user by email', async () => {
    const existingUser = await auth.createUser({ email: 'user@provider.com', name: 'Existing User' })
    const state = 'state123'
    const code = 'code123'
    const request = new Request(`http://localhost/api/auth/callback/mock?code=${code}&state=${state}`)
    request.headers.set('Cookie', `${CSRF_COOKIE_NAME}=${state}; ${PKCE_COOKIE_NAME}=pkce; ${CALLBACK_URI_COOKIE_NAME}=uri`)

    await handleCallback(request, auth, 'mock')

    const linkedUser = await auth.getUserByAccount('mock', 'provider-user-id')
    expect(linkedUser).not.toBeNull()
    expect(linkedUser?.id).toBe(existingUser.id)
  })

  it('should link to an existing user with unverified email if autoLink is always', async () => {
    auth.autoLink = 'always'
    const existingUser = await auth.createUser({ email: 'user@provider.com', name: 'Existing User', emailVerified: false })
    const state = 'state123'
    const code = 'code123'
    const request = new Request(`http://localhost/api/auth/callback/mock?code=${code}&state=${state}`)
    request.headers.set('Cookie', `${CSRF_COOKIE_NAME}=${state}; ${PKCE_COOKIE_NAME}=pkce; ${CALLBACK_URI_COOKIE_NAME}=uri`)

    await handleCallback(request, auth, 'mock')

    const linkedUser = await auth.getUserByAccount('mock', 'provider-user-id')
    expect(linkedUser).not.toBeNull()
    expect(linkedUser?.id).toBe(existingUser.id)
    const updatedUser = await auth.getUser(existingUser.id)
    expect(updatedUser?.emailVerified).toBe(true)
  })

  it('should return 500 if user creation fails', async () => {
    vi.spyOn(auth, 'createUser').mockRejectedValueOnce(new Error('DB error'))
    const state = 'state123'
    const code = 'code123'
    const request = new Request(`http://localhost/api/auth/callback/mock?code=${code}&state=${state}`)
    request.headers.set('Cookie', `${CSRF_COOKIE_NAME}=${state}; ${PKCE_COOKIE_NAME}=pkce;`)

    await expect(handleCallback(request, auth, 'mock')).rejects.toMatchObject({
      code: ErrorCodes.USER_CREATE_FAILED,
      status: 500,
    })
  })

  it('should return 500 if account linking fails', async () => {
    vi.spyOn(auth, 'linkAccount').mockRejectedValueOnce(new Error('DB error'))
    const state = 'state123'
    const code = 'code123'
    const request = new Request(`http://localhost/api/auth/callback/mock?code=${code}&state=${state}`)
    request.headers.set('Cookie', `${CSRF_COOKIE_NAME}=${state}; ${PKCE_COOKIE_NAME}=pkce;`)

    await expect(handleCallback(request, auth, 'mock')).rejects.toMatchObject({
      code: ErrorCodes.ACCOUNT_LINK_FAILED,
      status: 500,
    })
  })

  it('returns 409 when autoLink=false and verified email already exists', async () => {
    auth.autoLink = false
    await auth.createUser({ email: 'user@provider.com', name: 'Existing', emailVerified: true })

    const state = 'state-conflict'
    const request = new Request(`http://localhost/api/auth/callback/mock?code=c&state=${state}`)
    request.headers.set('Cookie', `${CSRF_COOKIE_NAME}=${state}; ${PKCE_COOKIE_NAME}=pkce; ${CALLBACK_URI_COOKIE_NAME}=uri`)

    await expect(handleCallback(request, auth, 'mock')).rejects.toMatchObject({
      code: ErrorCodes.EMAIL_ALREADY_EXISTS,
      status: 409,
    })
  })

  it('stores null email when provider email is unverified to avoid unique collisions', async () => {
    const state = 'state-unverified'
    const request = new Request(`http://localhost/api/auth/callback/mock?code=c&state=${state}`)
    request.headers.set('Cookie', `${CSRF_COOKIE_NAME}=${state}; ${PKCE_COOKIE_NAME}=pkce; ${CALLBACK_URI_COOKIE_NAME}=uri`)

    mockProvider.validateCallback.mockResolvedValueOnce({
      user: { id: 'provider-user-id', name: 'Provider User', email: 'unverified@example.com', emailVerified: false, avatar: 'https://avatar.url', raw: {} },
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

    const response = await handleCallback(request, auth, 'mock')
    expect([200, 302]).toContain(response.status)

    const linked = await auth.getUserByAccount('mock', 'provider-user-id')
    expect(linked).not.toBeNull()
    const stored = await auth.getUser(linked!.id)
    expect(stored?.email ?? null).toBeNull()
  })

  it('creates and links when autoLink=false, verified email, and no existing user', async () => {
    auth.autoLink = false
    const state = 'state-create'
    const request = new Request(`http://localhost/api/auth/callback/mock?code=c&state=${state}`)
    request.headers.set('Cookie', `${CSRF_COOKIE_NAME}=${state}; ${PKCE_COOKIE_NAME}=pkce; ${CALLBACK_URI_COOKIE_NAME}=uri`)

    const response = await handleCallback(request, auth, 'mock')
    expect([200, 302]).toContain(response.status)

    const linked = await auth.getUserByAccount('mock', 'provider-user-id')
    expect(linked).not.toBeNull()
    expect(linked?.email).toBe('user@provider.com')
    expect(linked?.emailVerified).toBe(true)
  })

  it('links by email when autoLink=always even if provider email is unverified/null', async () => {
    auth.autoLink = 'always'
    const existing = await auth.createUser({ email: 'user@provider.com', name: 'Exists', emailVerified: false })

    mockProvider.validateCallback.mockResolvedValueOnce({
      user: { id: 'provider-user-id', name: 'Provider User', email: 'user@provider.com', emailVerified: null, avatar: 'https://avatar.url', raw: {} },
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

    const state = 'state-always'
    const request = new Request(`http://localhost/api/auth/callback/mock?code=c&state=${state}`)
    request.headers.set('Cookie', `${CSRF_COOKIE_NAME}=${state}; ${PKCE_COOKIE_NAME}=pkce; ${CALLBACK_URI_COOKIE_NAME}=uri`)

    const response = await handleCallback(request, auth, 'mock')
    expect([200, 302]).toContain(response.status)

    const linked = await auth.getUserByAccount('mock', 'provider-user-id')
    expect(linked?.id).toBe(existing.id)
  })

  it('does not auto-link when autoLink=verifiedEmail and provider email is unverified/null', async () => {
    auth.autoLink = 'verifiedEmail'
    const existing = await auth.createUser({ email: 'user@provider.com', name: 'Exists', emailVerified: false })

    mockProvider.validateCallback.mockResolvedValueOnce({
      user: { id: 'provider-user-id', name: 'Provider User', email: 'user@provider.com', emailVerified: null, avatar: 'https://avatar.url', raw: {} },
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

    const state = 'state-verifiedEmail'
    const request = new Request(`http://localhost/api/auth/callback/mock?code=c&state=${state}`)
    request.headers.set('Cookie', `${CSRF_COOKIE_NAME}=${state}; ${PKCE_COOKIE_NAME}=pkce; ${CALLBACK_URI_COOKIE_NAME}=uri`)

    const response = await handleCallback(request, auth, 'mock')
    expect([200, 302]).toContain(response.status)

    const linked = await auth.getUserByAccount('mock', 'provider-user-id')
    expect(linked).not.toBeNull()
    expect(linked!.id).not.toBe(existing.id)
    expect(linked!.email ?? null).toBeNull()
  })

  it('should return 400 if provider is not found during callback', async () => {
    const request = new Request('http://localhost/api/auth/callback/unknown-provider?code=c&state=s')
    await expect(handleCallback(request, auth, 'unknown-provider')).rejects.toMatchObject({
      code: ErrorCodes.PROVIDER_NOT_FOUND,
    })
  })

  it('should return friendly HTML page for missing code or state (user cancelled)', async () => {
    const request = new Request('http://localhost/api/auth/callback/mock')
    const response = await handleCallback(request, auth, 'mock')
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    const html = await response.text()
    expect(html).toContain('Authentication Cancelled')
  })

  it('should return 403 for invalid CSRF token', async () => {
    const request = new Request('http://localhost/api/auth/callback/mock?code=c&state=s')
    request.headers.set('Cookie', `${CSRF_COOKIE_NAME}=wrong-state`)
    await expect(handleCallback(request, auth, 'mock')).rejects.toMatchObject({
      code: ErrorCodes.CSRF_INVALID,
      status: 403,
    })
  })

  it('should return 400 for missing PKCE verifier', async () => {
    const request = new Request('http://localhost/api/auth/callback/mock?code=c&state=s')
    request.headers.set('Cookie', `${CSRF_COOKIE_NAME}=s`)
    await expect(handleCallback(request, auth, 'mock')).rejects.toMatchObject({
      code: ErrorCodes.PKCE_MISSING,
    })
  })

  it('should handle malformed redirectTo in state gracefully', async () => {
    const state = `state123.not-base64`
    const request = new Request(`http://localhost/api/auth/callback/mock?code=c&state=${state}`)
    request.headers.set('Cookie', `${CSRF_COOKIE_NAME}=state123; ${PKCE_COOKIE_NAME}=pkce`)

    const response = await handleCallback(request, auth, 'mock')
    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe('/') // falls back to root
  })

  it('should return HTML for mobile redirects', async () => {
    const state = `state123.${btoa('https://mobile.app/callback')}`
    const request = new Request(`http://localhost/api/auth/callback/mock?code=c&state=${state}`)
    request.headers.set('Cookie', `${CSRF_COOKIE_NAME}=state123; ${PKCE_COOKIE_NAME}=pkce; __gau-client-challenge=challenge`)

    const response = await handleCallback(request, auth, 'mock')
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toContain('text/html')

    const html = await response.text()
    expect(html).toContain('const url = "https://mobile.app/callback?code=')
  })

  it('should return HTML for desktop/mobile redirects', async () => {
    const state = `state123.${btoa('gau://callback')}`
    const request = new Request(`http://localhost/api/auth/callback/mock?code=c&state=${state}`)
    request.headers.set('Cookie', `${CSRF_COOKIE_NAME}=state123; ${PKCE_COOKIE_NAME}=pkce; __gau-client-challenge=challenge`)

    const response = await handleCallback(request, auth, 'mock')
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toContain('text/html')

    const html = await response.text()
    expect(html).toContain('const url = "gau://callback?code=')
    expect(html).toContain('window.location.href = url;')
  })

  it('should handle redirect=false on callback', async () => {
    const state = 'state123'
    const code = 'code123'
    const request = new Request(`http://localhost/api/auth/callback/mock?code=${code}&state=${state}&redirect=false`)
    request.headers.set('Cookie', `${CSRF_COOKIE_NAME}=${state}; ${PKCE_COOKIE_NAME}=pkce;`)

    const response = await handleCallback(request, auth, 'mock')
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.user).toBeDefined()
    expect(body.user.email).toBe('user@provider.com')
  })

  it('clears temporary cookies and linking token on early return when invalid linking token', async () => {
    const state = 'state123'
    const request = new Request(`http://localhost/api/auth/callback/mock?code=c&state=${state}`)
    request.headers.set('Cookie', [
      `${CSRF_COOKIE_NAME}=${state}`,
      `${PKCE_COOKIE_NAME}=pkce`,
      `${CALLBACK_URI_COOKIE_NAME}=uri`,
      `__gau-linking-token=stale-token`,
      `__gau-provider-options=${btoa(JSON.stringify({ params: {}, overrides: {} }))}`,
    ].join('; '))

    const spy = vi.spyOn(auth, 'validateSession').mockResolvedValueOnce(null)

    const response = await handleCallback(request, auth, 'mock')
    spy.mockRestore()

    expect([200, 302]).toContain(response.status)
    const cookies = response.headers.getSetCookie()
    expect(cookies.some(c => c.startsWith('__gau-csrf-token=') && c.includes('Max-Age=0'))).toBe(true)
    expect(cookies.some(c => c.startsWith('__gau-pkce-code-verifier=') && c.includes('Max-Age=0'))).toBe(true)
    expect(cookies.some(c => c.startsWith('__gau-callback-uri=') && c.includes('Max-Age=0'))).toBe(true)
    expect(cookies.some(c => c.startsWith('__gau-provider-options=') && c.includes('Max-Age=0'))).toBe(true)
    expect(cookies.some(c => c.startsWith('__gau-linking-token=') && c.includes('Max-Age=0'))).toBe(true)
  })

  it('passes callbackUri from cookie to provider.validateCallback', async () => {
    const state = 'state123'
    const code = 'code123'
    const request = new Request(`http://localhost/api/auth/callback/mock?code=${code}&state=${state}`)
    request.headers.set('Cookie', `${CSRF_COOKIE_NAME}=${state}; ${PKCE_COOKIE_NAME}=pkce; ${CALLBACK_URI_COOKIE_NAME}=app://custom-callback`)

    await handleCallback(request, auth, 'mock')
    const validateArgs = mockProvider.validateCallback.mock.calls.at(-1)
    expect(validateArgs?.[2]).toBe('app://custom-callback')
  })

  it('passes overrides from provider-options cookie to provider.validateCallback', async () => {
    const state = 'state123'
    const code = 'code123'
    const options = { overrides: { tenant: 'organizations', prompt: 'login' }, params: { extra: 'x' } }
    const encoded = btoa(JSON.stringify(options))
    const request = new Request(`http://localhost/api/auth/callback/mock?code=${code}&state=${state}`)
    request.headers.set('Cookie', [
      `${CSRF_COOKIE_NAME}=${state}`,
      `${PKCE_COOKIE_NAME}=pkce`,
      `${CALLBACK_URI_COOKIE_NAME}=app://cb`,
      `__gau-provider-options=${encoded}`,
    ].join('; '))

    await handleCallback(request, auth, 'mock')
    const validateArgs = mockProvider.validateCallback.mock.calls.at(-1)
    expect(validateArgs?.[2]).toBe('app://cb')
    expect(validateArgs?.[3]).toMatchObject({ tenant: 'organizations', prompt: 'login' })
  })

  describe('session strategy', () => {
    it('should force token strategy for same-origin when strategy is "token"', async () => {
      auth = createAuth({
        adapter: MemoryAdapter(),
        providers: [mockProvider],
        jwt: { secret: 'test-secret', algorithm: 'HS256', ttl: 3600 },
        session: { strategy: 'token' },
      })

      const state = `state123.${btoa('/dashboard')}`
      const request = new Request(`http://localhost/api/auth/callback/mock?code=c&state=${state}`)
      request.headers.set('Cookie', `${CSRF_COOKIE_NAME}=state123; ${PKCE_COOKIE_NAME}=pkce; __gau-client-challenge=challenge`)

      const response = await handleCallback(request, auth, 'mock')
      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Type')).toContain('text/html')
      const html = await response.text()
      expect(html).toContain('const url = "http://localhost/dashboard?code=')
    })

    it('should force cookie strategy for cross-origin when strategy is "cookie"', async () => {
      auth = createAuth({
        adapter: MemoryAdapter(),
        providers: [mockProvider],
        jwt: { secret: 'test-secret', algorithm: 'HS256', ttl: 3600 },
        session: { strategy: 'cookie' },
        trustHosts: ['trusted.app.com'],
      })

      const state = `state123.${btoa('https://trusted.app.com/callback')}`
      const request = new Request(`http://localhost/api/auth/callback/mock?code=c&state=${state}`)
      request.headers.set('Cookie', `${CSRF_COOKIE_NAME}=state123; ${PKCE_COOKIE_NAME}=pkce`)

      const response = await handleCallback(request, auth, 'mock')
      expect(response.status).toBe(302)
      expect(response.headers.get('Location')).toBe('https://trusted.app.com/callback')
      const cookies = response.headers.getSetCookie()
      expect(cookies.some(c => c.startsWith(SESSION_COOKIE_NAME))).toBe(true)
    })
  })

  it('should return Auth Code in deep link when client challenge cookie is present', async () => {
    const state = `state123.${btoa('gau://callback')}`
    const request = new Request(`http://localhost/api/auth/callback/mock?code=c&state=${state}`)
    request.headers.set('Cookie', `${CSRF_COOKIE_NAME}=state123; ${PKCE_COOKIE_NAME}=pkce; __gau-client-challenge=challenge123`)

    const response = await handleCallback(request, auth, 'mock')
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toContain('text/html')

    const html = await response.text()
    expect(html).toContain('const url = "gau://callback?code=')
    expect(html).not.toContain('#token=')

    const cookies = response.headers.getSetCookie()
    expect(cookies.some(c => c.startsWith('__gau-client-challenge=') && c.includes('Max-Age=0'))).toBe(true)
  })
})
