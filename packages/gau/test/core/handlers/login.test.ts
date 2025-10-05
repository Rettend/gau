import type { Auth } from '../../../src/core/createAuth'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CALLBACK_URI_COOKIE_NAME,
  CSRF_COOKIE_NAME,
  PKCE_COOKIE_NAME,
  SESSION_COOKIE_NAME,
} from '../../../src/core/cookies'
import { handleSignIn, handleSignOut } from '../../../src/core/handlers/login'
import { mockProvider, setup } from '../../handler'

describe('login handlers', () => {
  let auth: Auth

  beforeEach(() => {
    ({ auth } = setup())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('handleSignIn', () => {
    it('should redirect to provider auth URL and set cookies', async () => {
      const request = new Request('http://localhost/api/auth/mock')
      const response = await handleSignIn(request, auth, 'mock')

      expect(response.status).toBe(302)
      expect(response.headers.get('Location')).toBe('https://provider.com/auth')

      const cookies = response.headers.getSetCookie()
      expect(cookies.some(c => c.startsWith(CSRF_COOKIE_NAME))).toBe(true)
      expect(cookies.some(c => c.startsWith(PKCE_COOKIE_NAME))).toBe(true)
      expect(cookies.some(c => c.startsWith(CALLBACK_URI_COOKIE_NAME))).toBe(true)
    })

    it('clears stale linking cookie during normal sign-in', async () => {
      const request = new Request('http://localhost/api/auth/mock')
      request.headers.set('Cookie', `__gau-linking-token=stale`)
      const response = await handleSignIn(request, auth, 'mock')

      const cookies = response.headers.getSetCookie()
      expect(cookies.some(c => c.startsWith('__gau-linking-token=') && c.includes('Max-Age=0'))).toBe(true)
    })

    it('should handle redirectTo parameter', async () => {
      const request = new Request('http://localhost/api/auth/mock?redirectTo=/dashboard')
      await handleSignIn(request, auth, 'mock')

      const state = mockProvider.getAuthorizationUrl.mock.calls[0][0]
      const decodedRedirect = atob(state.split('.')[1])
      expect(decodedRedirect).toBe('/dashboard')
    })

    it('should handle callbackUri parameter', async () => {
      const request = new Request('http://localhost/api/auth/mock?callbackUri=app://callback')
      await handleSignIn(request, auth, 'mock')

      const options = mockProvider.getAuthorizationUrl.mock.calls[0][2]
      expect(options?.redirectUri).toBe('app://callback')
    })

    it('should return JSON with auth URL if redirect=false', async () => {
      const request = new Request('http://localhost/api/auth/mock?redirect=false')
      const response = await handleSignIn(request, auth, 'mock')
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.url).toBe('https://provider.com/auth')
      expect(response.headers.has('Set-Cookie')).toBe(true)
    })

    it('should return 500 if auth URL cannot be created', async () => {
      mockProvider.getAuthorizationUrl.mockRejectedValueOnce(new Error('failed to create URL'))
      const request = new Request('http://localhost/api/auth/mock')
      const response = await handleSignIn(request, auth, 'mock')
      expect(response.status).toBe(500)
      const body = await response.json()
      expect(body.error).toBe('Could not create authorization URL')
    })

    it('should return 400 for invalid redirectTo URL', async () => {
      const request = new Request('http://localhost/api/auth/mock?redirectTo=//invalid-url')
      const response = await handleSignIn(request, auth, 'mock')
      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body.error).toBe('Invalid "redirectTo" URL')
    })

    it('should return 400 for untrusted redirectTo host', async () => {
      const request = new Request('http://localhost/api/auth/mock?redirectTo=https://evil.com')
      const response = await handleSignIn(request, auth, 'mock')
      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body.error).toBe('Untrusted redirect host')
    })

    it('should allow trusted redirectTo host', async () => {
      const request = new Request('http://localhost/api/auth/mock?redirectTo=https://trusted.app.com/profile')
      const response = await handleSignIn(request, auth, 'mock')
      expect(response.status).toBe(302)
    })

    it('should allow same-host redirectTo', async () => {
      const request = new Request('http://localhost/api/auth/mock?redirectTo=/profile')
      const response = await handleSignIn(request, auth, 'mock')
      expect(response.status).toBe(302)
    })

    it('should allow any host if trustHosts is "all"', async () => {
      auth.trustHosts = 'all'
      const request = new Request('http://localhost/api/auth/mock?redirectTo=https://any.host.com/profile')
      const response = await handleSignIn(request, auth, 'mock')
      expect(response.status).toBe(302)
    })

    it('should return 400 for a provider that does not exist', async () => {
      const request = new Request('http://localhost/api/auth/non-existent-provider')
      const response = await handleSignIn(request, auth, 'non-existent-provider')
      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body.error).toBe('Provider not found')
    })

    it('should apply profile scopes and redirectUri overrides', async () => {
      auth.profiles = {
        mock: {
          lite: { scopes: ['read:litescope', 'email'] },
          mobile: { redirectUri: 'app://mobile-callback' },
        },
      }

      const req1 = new Request('http://localhost/api/auth/mock?profile=lite')
      await handleSignIn(req1, auth, 'mock')
      const call1Options = mockProvider.getAuthorizationUrl.mock.calls.at(-1)?.[2]
      expect(call1Options?.scopes).toEqual(['read:litescope', 'email'])

      const req2 = new Request('http://localhost/api/auth/mock?profile=mobile')
      await handleSignIn(req2, auth, 'mock')
      const call2Options = mockProvider.getAuthorizationUrl.mock.calls.at(-1)?.[2]
      expect(call2Options?.redirectUri).toBe('app://mobile-callback')
    })

    it('should return 400 for unknown profile name', async () => {
      auth.profiles = { mock: { lite: { scopes: ['read:litescope'] } } }
      const request = new Request('http://localhost/api/auth/mock?profile=unknown')
      const response = await handleSignIn(request, auth, 'mock')
      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body.error).toContain('Unknown profile "unknown"')
    })

    it('should block sign-in when provider is link-only', async () => {
      const provider = auth.providerMap.get('mock')!
      provider.linkOnly = true

      const request = new Request('http://localhost/api/auth/mock')
      const response = await handleSignIn(request, auth, 'mock')
      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body.error).toMatch(/Sign-in with this provider is disabled/i)
    })

    it('should block sign-in when selected profile is link-only', async () => {
      auth.profiles = { mock: { locked: { linkOnly: true } } }
      const request = new Request('http://localhost/api/auth/mock?profile=locked')
      const response = await handleSignIn(request, auth, 'mock')
      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body.error).toMatch(/profile is link-only/i)
    })

    it('should forward profile params and query prompt to provider and set provider-options cookie', async () => {
      // Add profile with params; also pass prompt via query
      auth.profiles = { mock: { pro: { params: { a: '1', b: '2' } } } }
      const request = new Request('http://localhost/api/auth/mock?profile=pro&prompt=login&redirect=false')
      const response = await handleSignIn(request, auth, 'mock')

      expect(response.status).toBe(200)
      const options = mockProvider.getAuthorizationUrl.mock.calls.at(-1)?.[2]
      expect(options?.params).toMatchObject({ a: '1', b: '2', prompt: 'login' })

      const cookies = response.headers.getSetCookie()
      // Should include provider options cookie
      const providerCookie = cookies.find(c => c.startsWith('__gau-provider-options='))
      expect(providerCookie).toBeTruthy()

      // Decode and inspect stored data (Base64 JSON)
      const encoded = providerCookie!.split('=')[1].split(';')[0]
      const decoded = JSON.parse(atob(encoded))
      expect(decoded.params).toMatchObject({ a: '1', b: '2', prompt: 'login' })
    })
  })

  describe('handleSignOut', () => {
    it('should clear the session cookie', async () => {
      const request = new Request('http://localhost/api/auth/signout', {
        method: 'POST',
      })
      request.headers.set('Cookie', `${SESSION_COOKIE_NAME}=some-token`)

      const response = await handleSignOut(request, auth)

      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data.message).toBe('Signed out')

      const cookieHeader = response.headers.get('Set-Cookie')
      expect(cookieHeader).toContain(`${SESSION_COOKIE_NAME}=;`)
      expect(cookieHeader).toContain('Max-Age=0')
      expect(cookieHeader).toContain('SameSite=None')
      expect(cookieHeader).toContain('Secure')
    })

    it('should clear the session cookie in development mode', async () => {
      auth.development = true
      const request = new Request('http://localhost/api/auth/signout', {
        method: 'POST',
      })
      request.headers.set('Cookie', `${SESSION_COOKIE_NAME}=some-token`)

      const response = await handleSignOut(request, auth)

      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data.message).toBe('Signed out')

      const cookieHeader = response.headers.get('Set-Cookie')
      expect(cookieHeader).toContain(`${SESSION_COOKIE_NAME}=;`)
      expect(cookieHeader).toContain('Max-Age=0')
      expect(cookieHeader).toContain('SameSite=Lax')
      expect(cookieHeader).not.toContain('Secure')
    })

    it('should also clear the linking cookie', async () => {
      const request = new Request('http://localhost/api/auth/signout', {
        method: 'POST',
      })
      request.headers.set('Cookie', `${SESSION_COOKIE_NAME}=some-token; __gau-linking-token=leftover`)

      const response = await handleSignOut(request, auth)

      const cookieHeader = response.headers.get('Set-Cookie')!
      expect(cookieHeader).toContain('__gau-linking-token=;')
      expect(cookieHeader).toContain('Max-Age=0')
    })

    it('should sign out even with no session', async () => {
      const request = new Request('http://localhost/api/auth/signout', {
        method: 'POST',
      })
      const response = await handleSignOut(request, auth)
      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data.message).toBe('Signed out')
    })
  })
})
