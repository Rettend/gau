import type { Mock } from 'vitest'
import type { Auth } from '../../../src/core/createAuth'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SESSION_COOKIE_NAME } from '../../../src/core/cookies'
import { handleLink, handleUnlink } from '../../../src/core/handlers/link'
import { setup } from '../../handler'

describe('link handler', () => {
  let auth: Auth
  let mockProvider: ReturnType<typeof setup>['mockProvider']

  beforeEach(() => {
    ({ auth, mockProvider } = setup())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('handleLink', () => {
    it('should redirect to provider auth URL with linking token', async () => {
      const user = await auth.createUser({ name: 'Test User' })
      const sessionToken = await auth.createSession(user.id)
      const request = new Request('http://localhost/api/auth/link/mock')
      request.headers.set('Cookie', `${SESSION_COOKIE_NAME}=${sessionToken}`)

      const response = await handleLink(request, auth, 'mock')

      expect(response.status).toBe(302)
      expect(response.headers.get('Location')).toBe('https://provider.com/auth')

      const cookies = response.headers.getSetCookie()
      expect(cookies.some(c => c.includes('__gau-linking-token'))).toBe(true)
    })

    it('should work with Authorization header', async () => {
      const user = await auth.createUser({ name: 'Test User' })
      const sessionToken = await auth.createSession(user.id)
      const request = new Request('http://localhost/api/auth/link/mock')
      request.headers.set('Authorization', `Bearer ${sessionToken}`)

      const response = await handleLink(request, auth, 'mock')

      expect(response.status).toBe(302)
    })

    it('should work with token in URL params', async () => {
      const user = await auth.createUser({ name: 'Test User' })
      const sessionToken = await auth.createSession(user.id)
      const request = new Request(`http://localhost/api/auth/link/mock?token=${sessionToken}`)

      const response = await handleLink(request, auth, 'mock')

      expect(response.status).toBe(302)
    })

    it('should return 401 for no session token', async () => {
      const request = new Request('http://localhost/api/auth/link/mock')

      const response = await handleLink(request, auth, 'mock')

      expect(response.status).toBe(401)
      const body = await response.json()
      expect(body.error).toBe('Unauthorized')
    })

    it('should return 401 for invalid session token', async () => {
      const request = new Request('http://localhost/api/auth/link/mock')
      request.headers.set('Cookie', `${SESSION_COOKIE_NAME}=invalid-token`)

      const response = await handleLink(request, auth, 'mock')

      expect(response.status).toBe(401)
      const body = await response.json()
      expect(body.error).toBe('Unauthorized')
    })

    it('should return JSON with auth URL when redirect=false', async () => {
      const user = await auth.createUser({ name: 'Test User' })
      const sessionToken = await auth.createSession(user.id)
      const request = new Request('http://localhost/api/auth/link/mock?redirect=false')
      request.headers.set('Cookie', `${SESSION_COOKIE_NAME}=${sessionToken}`)

      const response = await handleLink(request, auth, 'mock')

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.url).toBe('https://provider.com/auth')

      const cookies = response.headers.getSetCookie()
      expect(cookies.some(c => c.includes('__gau-linking-token'))).toBe(true)
    })

    it('should redirect to a trusted redirectTo URL', async () => {
      const user = await auth.createUser({ name: 'Test User' })
      const sessionToken = await auth.createSession(user.id)
      const request = new Request('http://localhost/api/auth/link/mock?redirectTo=http://trusted.app.com/profile')
      request.headers.set('Cookie', `${SESSION_COOKIE_NAME}=${sessionToken}`)

      const response = await handleLink(request, auth, 'mock')

      expect(response.status).toBe(302)
      expect(response.headers.get('Location')).toBe('https://provider.com/auth')

      expect(mockProvider.getAuthorizationUrl).toHaveBeenCalled()
      const stateArg = (mockProvider.getAuthorizationUrl as Mock).mock.calls[0][0] as string
      const [, encodedRedirect] = stateArg.split('.')
      expect(encodedRedirect && atob(encodedRedirect)).toBe('http://trusted.app.com/profile')
    })

    it('should reject an untrusted redirectTo URL', async () => {
      const user = await auth.createUser({ name: 'Test User' })
      const sessionToken = await auth.createSession(user.id)
      const request = new Request('http://localhost/api/auth/link/mock?redirectTo=http://untrusted.app.com/profile')
      request.headers.set('Cookie', `${SESSION_COOKIE_NAME}=${sessionToken}`)

      const response = await handleLink(request, auth, 'mock')

      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body.error).toBe('Untrusted redirect host')
    })

    it('should reject a protocol-relative redirectTo URL', async () => {
      const user = await auth.createUser({ name: 'Test User' })
      const sessionToken = await auth.createSession(user.id)
      const request = new Request('http://localhost/api/auth/link/mock?redirectTo=//untrusted.app.com/profile')
      request.headers.set('Cookie', `${SESSION_COOKIE_NAME}=${sessionToken}`)

      const response = await handleLink(request, auth, 'mock')

      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body.error).toBe('Invalid "redirectTo" URL')
    })

    it('should apply profile overrides during link', async () => {
      const user = await auth.createUser({ name: 'Test User' })
      const sessionToken = await auth.createSession(user.id)
      auth.profiles = {
        mock: {
          lite: { scopes: ['link:only'] },
          desktop: { redirectUri: 'app://desktop-link' },
        },
      }

      const req1 = new Request('http://localhost/api/auth/link/mock?profile=lite')
      req1.headers.set('Cookie', `${SESSION_COOKIE_NAME}=${sessionToken}`)
      await handleLink(req1, auth, 'mock')
      const options1 = (auth.providerMap.get('mock')!.getAuthorizationUrl as any).mock.calls.at(-1)[2]
      expect(options1.scopes).toEqual(['link:only'])
      const req2 = new Request('http://localhost/api/auth/link/mock?profile=desktop')
      req2.headers.set('Cookie', `${SESSION_COOKIE_NAME}=${sessionToken}`)
      await handleLink(req2, auth, 'mock')
      const options2 = (auth.providerMap.get('mock')!.getAuthorizationUrl as any).mock.calls.at(-1)[2]
      expect(options2.redirectUri).toBe('app://desktop-link')
    })

    it('should allow linking even if provider is link-only', async () => {
      const user = await auth.createUser({ name: 'Test User' })
      const sessionToken = await auth.createSession(user.id)
      ;(auth.providerMap.get('mock') as any).linkOnly = true
      const request = new Request('http://localhost/api/auth/link/mock')
      request.headers.set('Cookie', `${SESSION_COOKIE_NAME}=${sessionToken}`)

      const response = await handleLink(request, auth, 'mock')
      expect(response.status).toBe(302)
    })

    it('should allow linking when selected profile is link-only', async () => {
      const user = await auth.createUser({ name: 'Test User' })
      const sessionToken = await auth.createSession(user.id)
      auth.profiles = { mock: { locked: { linkOnly: true, scopes: ['special:link'] } } }
      const request = new Request('http://localhost/api/auth/link/mock?profile=locked')
      request.headers.set('Cookie', `${SESSION_COOKIE_NAME}=${sessionToken}`)

      const response = await handleLink(request, auth, 'mock')
      expect(response.status).toBe(302)
      const options = (auth.providerMap.get('mock')!.getAuthorizationUrl as any).mock.calls.at(-1)[2]
      expect(options.scopes).toEqual(['special:link'])
    })

    it('should return 400 for unknown profile during link', async () => {
      const user = await auth.createUser({ name: 'Test User' })
      const sessionToken = await auth.createSession(user.id)
      auth.profiles = { mock: { lite: { scopes: ['link:only'] } } }
      const request = new Request('http://localhost/api/auth/link/mock?profile=unknown')
      request.headers.set('Cookie', `${SESSION_COOKIE_NAME}=${sessionToken}`)
      const response = await handleLink(request, auth, 'mock')
      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body.error).toContain('Unknown profile "unknown"')
    })
  })

  describe('handleUnlink', () => {
    it('should unlink account successfully', async () => {
      const user = await auth.createUser({ name: 'Test User' })
      const sessionToken = await auth.createSession(user.id)

      await auth.linkAccount({
        userId: user.id,
        provider: 'mock',
        providerAccountId: 'mock-account-id',
      })
      await auth.linkAccount({
        userId: user.id,
        provider: 'other-provider',
        providerAccountId: 'other-account-id',
      })

      const request = new Request('http://localhost/api/auth/unlink/mock', {
        method: 'POST',
      })
      request.headers.set('Cookie', `${SESSION_COOKIE_NAME}=${sessionToken}`)

      const response = await handleUnlink(request, auth, 'mock')

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.message).toBe('Account unlinked successfully')

      const accounts = await auth.getAccounts(user.id)
      expect(accounts.length).toBe(1)
      expect(accounts[0]?.provider).toBe('other-provider')
    })

    it('should work with Authorization header', async () => {
      const user = await auth.createUser({ name: 'Test User' })
      const sessionToken = await auth.createSession(user.id)

      await auth.linkAccount({
        userId: user.id,
        provider: 'mock',
        providerAccountId: 'mock-account-id',
      })
      await auth.linkAccount({
        userId: user.id,
        provider: 'other-provider',
        providerAccountId: 'other-account-id',
      })

      const request = new Request('http://localhost/api/auth/unlink/mock', {
        method: 'POST',
      })
      request.headers.set('Authorization', `Bearer ${sessionToken}`)

      const response = await handleUnlink(request, auth, 'mock')

      expect(response.status).toBe(200)
    })

    it('should return 401 for no session token', async () => {
      const request = new Request('http://localhost/api/auth/unlink/mock', {
        method: 'POST',
      })

      const response = await handleUnlink(request, auth, 'mock')

      expect(response.status).toBe(401)
      const body = await response.json()
      expect(body.error).toBe('Unauthorized')
    })

    it('should return 401 for invalid session token', async () => {
      const request = new Request('http://localhost/api/auth/unlink/mock', {
        method: 'POST',
      })
      request.headers.set('Cookie', `${SESSION_COOKIE_NAME}=invalid-token`)

      const response = await handleUnlink(request, auth, 'mock')

      expect(response.status).toBe(401)
      const body = await response.json()
      expect(body.error).toBe('Unauthorized')
    })

    it('should return 400 when trying to unlink the last account', async () => {
      const user = await auth.createUser({ name: 'Test User' })
      const sessionToken = await auth.createSession(user.id)

      await auth.linkAccount({
        userId: user.id,
        provider: 'mock',
        providerAccountId: 'mock-account-id',
      })

      const request = new Request('http://localhost/api/auth/unlink/mock', {
        method: 'POST',
      })
      request.headers.set('Cookie', `${SESSION_COOKIE_NAME}=${sessionToken}`)

      const response = await handleUnlink(request, auth, 'mock')

      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body.error).toBe('Cannot unlink the last account')
    })

    it('should return 400 when trying to unlink non-existent provider', async () => {
      const user = await auth.createUser({ name: 'Test User' })
      const sessionToken = await auth.createSession(user.id)

      await auth.linkAccount({
        userId: user.id,
        provider: 'other-provider',
        providerAccountId: 'other-account-id',
      })
      await auth.linkAccount({
        userId: user.id,
        provider: 'another-provider',
        providerAccountId: 'another-account-id',
      })

      const request = new Request('http://localhost/api/auth/unlink/mock', {
        method: 'POST',
      })
      request.headers.set('Cookie', `${SESSION_COOKIE_NAME}=${sessionToken}`)

      const response = await handleUnlink(request, auth, 'mock')

      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body.error).toBe('Provider "mock" not linked to this account')
    })

    it('should clear email when unlinking account with email', async () => {
      const user = await auth.createUser({
        name: 'Test User',
        email: 'test@example.com',
        emailVerified: true,
      })
      const sessionToken = await auth.createSession(user.id)

      await auth.linkAccount({
        userId: user.id,
        provider: 'mock',
        providerAccountId: 'mock-account-id',
      })
      await auth.linkAccount({
        userId: user.id,
        provider: 'other-provider',
        providerAccountId: 'other-account-id',
      })

      const request = new Request('http://localhost/api/auth/unlink/mock', {
        method: 'POST',
      })
      request.headers.set('Cookie', `${SESSION_COOKIE_NAME}=${sessionToken}`)

      const response = await handleUnlink(request, auth, 'mock')

      expect(response.status).toBe(200)

      const updatedUser = await auth.getUser(user.id)
      expect(updatedUser?.email).toBeNull()
      expect(updatedUser?.emailVerified).toBe(false)
    })
  })
})
