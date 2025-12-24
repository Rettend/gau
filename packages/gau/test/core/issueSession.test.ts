import { Buffer } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryAdapter } from '../../src/adapters/memory/index'
import { SESSION_COOKIE_NAME } from '../../src/core/cookies'
import { createAuth } from '../../src/core/createAuth'

describe('issueSession', () => {
  const adapter = MemoryAdapter()
  const secret = 'super-secret-hs256-key'
  let es256Secret: string

  beforeEach(async () => {
    vi.useFakeTimers()
    const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    const exportedPkcs8 = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey)
    es256Secret = Buffer.from(exportedPkcs8).toString('base64url')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('basic functionality', () => {
    it('returns token, cookie, cookieName, and maxAge', async () => {
      const auth = createAuth({ adapter, providers: [], jwt: { secret, algorithm: 'HS256' } })
      const user = await auth.createUser({ name: 'Guest' })
      const result = await auth.issueSession(user.id)

      expect(result.token).toBeDefined()
      expect(typeof result.token).toBe('string')
      expect(result.cookie).toBeDefined()
      expect(typeof result.cookie).toBe('string')
      expect(result.cookieName).toBe(SESSION_COOKIE_NAME)
      expect(result.maxAge).toBe(auth.jwt.ttl) // default TTL
    })

    it('returns a valid JWT token that can be validated', async () => {
      const auth = createAuth({ adapter, providers: [], jwt: { secret, algorithm: 'HS256' } })
      const user = await auth.createUser({ name: 'Guest', email: 'guest@example.com' })
      const { token } = await auth.issueSession(user.id)

      const validated = await auth.validateSession(token)
      expect(validated).not.toBeNull()
      expect(validated?.user?.id).toBe(user.id)
      expect(validated?.user?.name).toBe('Guest')
      expect(validated?.session?.sub).toBe(user.id)
    })

    it('returns a properly formatted Set-Cookie header value', async () => {
      const auth = createAuth({ adapter, providers: [], jwt: { secret, algorithm: 'HS256' } })
      const user = await auth.createUser({ name: 'Guest' })
      const { cookie, cookieName, token } = await auth.issueSession(user.id)

      // Cookie should start with the cookie name and contain the token
      expect(cookie.startsWith(`${cookieName}=`)).toBe(true)
      expect(cookie).toContain(token)

      // Should include standard cookie attributes
      expect(cookie).toContain('Path=/')
      expect(cookie).toContain('HttpOnly')
      expect(cookie).toContain('Max-Age=')
    })
  })

  describe('custom options', () => {
    it('respects custom TTL', async () => {
      const auth = createAuth({ adapter, providers: [], jwt: { secret, algorithm: 'HS256', ttl: 3600 } })
      const user = await auth.createUser({ name: 'Guest' })

      const customTtl = 60 // 1 minute
      const result = await auth.issueSession(user.id, { ttl: customTtl })

      expect(result.maxAge).toBe(customTtl)
      expect(result.cookie).toContain(`Max-Age=${customTtl}`)
    })

    it('includes custom data in the session token', async () => {
      const auth = createAuth({ adapter, providers: [], jwt: { secret, algorithm: 'HS256' } })
      const user = await auth.createUser({ name: 'Guest' })

      const customData = { isGuest: true, source: 'invite' }
      const { token } = await auth.issueSession(user.id, { data: customData })

      // Verify the token contains the custom data
      const payload = await auth.verifyJWT<{ sub: string, isGuest: boolean, source: string }>(token)
      expect(payload).not.toBeNull()
      expect(payload?.isGuest).toBe(true)
      expect(payload?.source).toBe('invite')
      expect(payload?.sub).toBe(user.id)
    })

    it('includes both custom TTL and custom data', async () => {
      const auth = createAuth({ adapter, providers: [], jwt: { secret, algorithm: 'HS256' } })
      const user = await auth.createUser({ name: 'Guest' })

      const result = await auth.issueSession(user.id, {
        ttl: 120,
        data: { deviceId: 'abc123' },
      })

      expect(result.maxAge).toBe(120)

      const payload = await auth.verifyJWT<{ sub: string, deviceId: string }>(result.token)
      expect(payload?.deviceId).toBe('abc123')
    })
  })

  describe('cookie options inheritance', () => {
    it('uses default cookie options', async () => {
      const auth = createAuth({ adapter, providers: [], jwt: { secret, algorithm: 'HS256' } })
      const user = await auth.createUser({ name: 'Guest' })
      const { cookie } = await auth.issueSession(user.id)

      // Default options
      expect(cookie).toContain('Path=/')
      expect(cookie).toContain('HttpOnly')
      expect(cookie).toContain('SameSite=Lax')
      expect(cookie).toContain('Secure')
    })

    it('respects custom cookie options from createAuth', async () => {
      const auth = createAuth({
        adapter,
        providers: [],
        jwt: { secret, algorithm: 'HS256' },
        cookies: { path: '/app', sameSite: 'strict' },
      })
      const user = await auth.createUser({ name: 'Guest' })
      const { cookie } = await auth.issueSession(user.id)

      expect(cookie).toContain('Path=/app')
      expect(cookie).toContain('SameSite=Strict')
    })
  })

  describe('token expiration', () => {
    it('creates a token that expires after the specified TTL', async () => {
      const auth = createAuth({ adapter, providers: [], jwt: { secret, algorithm: 'HS256' } })
      const user = await auth.createUser({ name: 'Guest' })

      const ttl = 60 // 1 minute
      const { token } = await auth.issueSession(user.id, { ttl })

      // Validate immediately - should work
      let validated = await auth.validateSession(token)
      expect(validated).not.toBeNull()

      // Advance time past expiration
      vi.advanceTimersByTime(61 * 1000)

      // Validate again - should fail
      validated = await auth.validateSession(token)
      expect(validated).toBeNull()
    })

    it('uses default TTL when not specified', async () => {
      const defaultTtl = 3600
      const auth = createAuth({ adapter, providers: [], jwt: { secret, algorithm: 'HS256', ttl: defaultTtl } })
      const user = await auth.createUser({ name: 'Guest' })

      const { token, maxAge } = await auth.issueSession(user.id)
      expect(maxAge).toBe(defaultTtl)

      // Advance time to just before expiration
      vi.advanceTimersByTime((defaultTtl - 1) * 1000)
      let validated = await auth.validateSession(token)
      expect(validated).not.toBeNull()

      // Advance past expiration
      vi.advanceTimersByTime(2 * 1000)
      validated = await auth.validateSession(token)
      expect(validated).toBeNull()
    })
  })

  describe('use cases', () => {
    it('works for guest login flow', async () => {
      const auth = createAuth({ adapter, providers: [], jwt: { secret, algorithm: 'HS256' } })

      // Create a guest user
      const guestUser = await auth.createUser({ name: 'Guest User' })

      // Issue a session for the guest
      const { token, cookie, cookieName } = await auth.issueSession(guestUser.id, {
        data: { isGuest: true },
      })

      // Validate the session
      const session = await auth.validateSession(token)
      expect(session?.user?.id).toBe(guestUser.id)

      // Cookie can be used in response
      expect(cookie.startsWith(`${cookieName}=`)).toBe(true)
    })

    it('works for invite redemption flow', async () => {
      const auth = createAuth({ adapter, providers: [], jwt: { secret, algorithm: 'HS256' } })

      // Invite creates a new user
      const newUser = await auth.createUser({
        name: 'Invited User',
        email: 'invited@example.com',
      })

      // Immediately issue a session
      const { token, cookie } = await auth.issueSession(newUser.id, {
        data: { inviteId: 'inv_123', claimedAt: Date.now() },
      })

      // Validate
      const session = await auth.validateSession(token)
      expect(session?.user?.email).toBe('invited@example.com')

      // Token contains invite metadata
      const payload = await auth.verifyJWT<{ inviteId: string }>(token)
      expect(payload?.inviteId).toBe('inv_123')

      // Cookie is ready to set
      expect(cookie.length).toBeGreaterThan(0)
    })

    it('works for admin impersonation', async () => {
      const auth = createAuth({
        adapter,
        providers: [],
        jwt: { secret, algorithm: 'HS256' },
        roles: { adminRoles: ['admin'] },
      })

      // Admin creates a session for another user
      const targetUser = await auth.createUser({ name: 'Target User' })
      const { token } = await auth.issueSession(targetUser.id, {
        data: { impersonatedBy: 'admin_user_id' },
        ttl: 300, // Short TTL for impersonation
      })

      const session = await auth.validateSession(token)
      expect(session?.user?.id).toBe(targetUser.id)

      const payload = await auth.verifyJWT<{ impersonatedBy: string }>(token)
      expect(payload?.impersonatedBy).toBe('admin_user_id')
    })

    it('works for device/session claiming', async () => {
      const auth = createAuth({ adapter, providers: [], jwt: { secret, algorithm: 'HS256' } })

      // Device presents a claim code, server validates and issues session
      const user = await auth.createUser({ name: 'Device User' })
      const { token, cookie } = await auth.issueSession(user.id, {
        data: { deviceId: 'device_abc', claimCode: 'claim_xyz' },
      })

      const session = await auth.validateSession(token)
      expect(session?.user?.id).toBe(user.id)

      const payload = await auth.verifyJWT<{ deviceId: string, claimCode: string }>(token)
      expect(payload?.deviceId).toBe('device_abc')
      expect(payload?.claimCode).toBe('claim_xyz')

      expect(cookie.length).toBeGreaterThan(0)
    })
  })

  describe('algorithm compatibility', () => {
    it('works with HS256', async () => {
      const auth = createAuth({ adapter, providers: [], jwt: { secret, algorithm: 'HS256' } })
      const user = await auth.createUser({ name: 'Test' })
      const { token } = await auth.issueSession(user.id)

      const validated = await auth.validateSession(token)
      expect(validated?.user?.id).toBe(user.id)
    })

    it('works with ES256', async () => {
      const auth = createAuth({ adapter, providers: [], jwt: { secret: es256Secret, algorithm: 'ES256' } })
      const user = await auth.createUser({ name: 'Test' })
      const { token } = await auth.issueSession(user.id)

      const validated = await auth.validateSession(token)
      expect(validated?.user?.id).toBe(user.id)
    })
  })

  describe('edge cases', () => {
    it('returns null session when validating token for non-existent user', async () => {
      const auth = createAuth({ adapter, providers: [], jwt: { secret, algorithm: 'HS256' } })

      // Issue session for a non-existent user ID
      const { token } = await auth.issueSession('non-existent-user-id')

      // Token is valid JWT but user doesn't exist
      const validated = await auth.validateSession(token)
      expect(validated).toBeNull()
    })

    it('returns null session when user is deleted after session issued', async () => {
      const auth = createAuth({ adapter, providers: [], jwt: { secret, algorithm: 'HS256' } })
      const user = await auth.createUser({ name: 'Deletable' })
      const { token } = await auth.issueSession(user.id)

      // Validate before delete - should work
      let validated = await auth.validateSession(token)
      expect(validated?.user?.id).toBe(user.id)

      // Delete the user
      await auth.deleteUser(user.id)

      // Validate after delete - should return null
      validated = await auth.validateSession(token)
      expect(validated).toBeNull()
    })

    it('handles empty custom data', async () => {
      const auth = createAuth({ adapter, providers: [], jwt: { secret, algorithm: 'HS256' } })
      const user = await auth.createUser({ name: 'Test' })
      const { token } = await auth.issueSession(user.id, { data: {} })

      const validated = await auth.validateSession(token)
      expect(validated?.user?.id).toBe(user.id)
    })

    it('handles zero TTL (token has no expiration)', async () => {
      const auth = createAuth({ adapter, providers: [], jwt: { secret, algorithm: 'HS256' } })
      const user = await auth.createUser({ name: 'Test' })
      const { token, maxAge } = await auth.issueSession(user.id, { ttl: 0 })

      expect(maxAge).toBe(0)

      // TTL of 0 means no expiration claim - token is valid indefinitely
      // Advance time significantly
      vi.advanceTimersByTime(365 * 24 * 60 * 60 * 1000) // 1 year

      const validated = await auth.validateSession(token)
      expect(validated).not.toBeNull()
      expect(validated?.user?.id).toBe(user.id)
    })
  })
})

describe('refreshSession', () => {
  const adapter = MemoryAdapter()
  const secret = 'super-secret-hs256-key'

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('basic functionality', () => {
    it('returns a new token and cookie for a valid session', async () => {
      const auth = createAuth({ adapter, providers: [], jwt: { secret, algorithm: 'HS256', ttl: 3600 } })
      const user = await auth.createUser({ name: 'Guest' })
      const { token: originalToken } = await auth.issueSession(user.id)

      // Advance time so the new token has a different `iat` claim
      vi.advanceTimersByTime(1000)

      const refreshed = await auth.refreshSession(originalToken)

      expect(refreshed).not.toBeNull()
      expect(refreshed?.token).toBeDefined()
      expect(refreshed?.cookie).toBeDefined()
      expect(refreshed?.token).not.toBe(originalToken) // New token with different iat
    })

    it('the refreshed token is valid', async () => {
      const auth = createAuth({ adapter, providers: [], jwt: { secret, algorithm: 'HS256', ttl: 3600 } })
      const user = await auth.createUser({ name: 'Guest' })
      const { token: originalToken } = await auth.issueSession(user.id)

      const refreshed = await auth.refreshSession(originalToken)
      const validated = await auth.validateSession(refreshed!.token)

      expect(validated?.user?.id).toBe(user.id)
    })
  })

  describe('preserves custom claims', () => {
    it('preserves isGuest and other custom claims', async () => {
      const auth = createAuth({ adapter, providers: [], jwt: { secret, algorithm: 'HS256', ttl: 3600 } })
      const user = await auth.createUser({ name: 'Guest' })
      const { token: originalToken } = await auth.issueSession(user.id, {
        data: { isGuest: true, source: 'button', deviceId: 'abc' },
      })

      const refreshed = await auth.refreshSession(originalToken)
      const payload = await auth.verifyJWT<{ isGuest: boolean, source: string, deviceId: string }>(refreshed!.token)

      expect(payload?.isGuest).toBe(true)
      expect(payload?.source).toBe('button')
      expect(payload?.deviceId).toBe('abc')
    })
  })

  describe('extends expiration', () => {
    it('extends session that was about to expire', async () => {
      const ttl = 60
      const auth = createAuth({ adapter, providers: [], jwt: { secret, algorithm: 'HS256', ttl } })
      const user = await auth.createUser({ name: 'Guest' })
      const { token: originalToken } = await auth.issueSession(user.id)

      // Advance to 50 seconds (almost expired)
      vi.advanceTimersByTime(50 * 1000)

      // Original would expire in 10 seconds
      // Refresh it
      const refreshed = await auth.refreshSession(originalToken)

      // Advance another 15 seconds (original would be expired now)
      vi.advanceTimersByTime(15 * 1000)

      // Original token should be expired
      const originalValidated = await auth.validateSession(originalToken)
      expect(originalValidated).toBeNull()

      // Refreshed token should still be valid
      const refreshedValidated = await auth.validateSession(refreshed!.token)
      expect(refreshedValidated?.user?.id).toBe(user.id)
    })

    it('respects custom TTL override', async () => {
      const auth = createAuth({ adapter, providers: [], jwt: { secret, algorithm: 'HS256', ttl: 3600 } })
      const user = await auth.createUser({ name: 'Guest' })
      const { token: originalToken } = await auth.issueSession(user.id)

      const refreshed = await auth.refreshSession(originalToken, { ttl: 60 })

      expect(refreshed?.maxAge).toBe(60)
    })
  })

  describe('edge cases', () => {
    it('returns null for invalid token', async () => {
      const auth = createAuth({ adapter, providers: [], jwt: { secret, algorithm: 'HS256' } })

      const result = await auth.refreshSession('invalid-token')
      expect(result).toBeNull()
    })

    it('returns null for expired token', async () => {
      const auth = createAuth({ adapter, providers: [], jwt: { secret, algorithm: 'HS256', ttl: 60 } })
      const user = await auth.createUser({ name: 'Guest' })
      const { token } = await auth.issueSession(user.id)

      // Advance past expiration
      vi.advanceTimersByTime(61 * 1000)

      const result = await auth.refreshSession(token)
      expect(result).toBeNull()
    })

    it('returns null for deleted user', async () => {
      const auth = createAuth({ adapter, providers: [], jwt: { secret, algorithm: 'HS256' } })
      const user = await auth.createUser({ name: 'Guest' })
      const { token } = await auth.issueSession(user.id)

      await auth.deleteUser(user.id)

      const result = await auth.refreshSession(token)
      expect(result).toBeNull()
    })
  })

  describe('use case: guest session keep-alive', () => {
    it('keeps guest sessions alive indefinitely with periodic refresh', async () => {
      const ttl = 60 * 60 * 24 * 30 // 30 days
      const auth = createAuth({ adapter, providers: [], jwt: { secret, algorithm: 'HS256', ttl } })
      const user = await auth.createUser({ name: 'Guest' })
      let { token } = await auth.issueSession(user.id, { data: { isGuest: true } })

      // Simulate 6 months of periodic refreshes (every 15 days)
      for (let i = 0; i < 12; i++) {
        vi.advanceTimersByTime(15 * 24 * 60 * 60 * 1000) // 15 days

        const refreshed = await auth.refreshSession(token)
        expect(refreshed).not.toBeNull()
        token = refreshed!.token

        // Verify guest claim is preserved
        const payload = await auth.verifyJWT<{ isGuest: boolean }>(token)
        expect(payload?.isGuest).toBe(true)
      }

      // After 6 months, session is still valid
      const validated = await auth.validateSession(token)
      expect(validated?.user?.id).toBe(user.id)
    })
  })

  describe('threshold option', () => {
    it('returns null when below threshold (fast path)', async () => {
      const ttl = 3600 // 1 hour
      const auth = createAuth({ adapter, providers: [], jwt: { secret, algorithm: 'HS256', ttl } })
      const user = await auth.createUser({ name: 'Guest' })
      const { token } = await auth.issueSession(user.id)

      // Only 10 minutes elapsed (below 50% threshold)
      vi.advanceTimersByTime(10 * 60 * 1000)

      const result = await auth.refreshSession(token, { threshold: 0.5 })
      expect(result).toBeNull()
    })

    it('refreshes when above threshold', async () => {
      const ttl = 3600 // 1 hour
      const auth = createAuth({ adapter, providers: [], jwt: { secret, algorithm: 'HS256', ttl } })
      const user = await auth.createUser({ name: 'Guest' })
      const { token } = await auth.issueSession(user.id)

      // 35 minutes elapsed (above 50% threshold)
      vi.advanceTimersByTime(35 * 60 * 1000)

      const result = await auth.refreshSession(token, { threshold: 0.5 })
      expect(result).not.toBeNull()
      expect(result?.token).toBeDefined()
    })

    it('refreshes at exactly threshold boundary', async () => {
      const ttl = 3600 // 1 hour
      const auth = createAuth({ adapter, providers: [], jwt: { secret, algorithm: 'HS256', ttl } })
      const user = await auth.createUser({ name: 'Guest' })
      const { token } = await auth.issueSession(user.id)

      // Exactly at 50% (30 minutes)
      vi.advanceTimersByTime(30 * 60 * 1000)

      const result = await auth.refreshSession(token, { threshold: 0.5 })
      // At exactly threshold, sessionAge === thresholdSeconds, so < is false, should refresh
      expect(result).not.toBeNull()
    })

    it('always refreshes without threshold option', async () => {
      const auth = createAuth({ adapter, providers: [], jwt: { secret, algorithm: 'HS256', ttl: 3600 } })
      const user = await auth.createUser({ name: 'Guest' })
      const { token } = await auth.issueSession(user.id)

      // Immediately (0 minutes elapsed)
      vi.advanceTimersByTime(1000) // 1 second to get different iat

      const result = await auth.refreshSession(token) // No threshold
      expect(result).not.toBeNull()
    })

    it('uses custom ttl for threshold calculation', async () => {
      const auth = createAuth({ adapter, providers: [], jwt: { secret, algorithm: 'HS256', ttl: 3600 } })
      const user = await auth.createUser({ name: 'Guest' })
      const { token } = await auth.issueSession(user.id)

      // 20 minutes elapsed - below 50% of 1 hour, but above 50% of custom 30 min TTL
      vi.advanceTimersByTime(20 * 60 * 1000)

      // With default TTL (1 hour), this would be below threshold
      const result1 = await auth.refreshSession(token, { threshold: 0.5 })
      expect(result1).toBeNull()

      // With custom TTL (30 min), this is above threshold
      const result2 = await auth.refreshSession(token, { threshold: 0.5, ttl: 1800 })
      expect(result2).not.toBeNull()
    })

    it('ignores invalid threshold values', async () => {
      const auth = createAuth({ adapter, providers: [], jwt: { secret, algorithm: 'HS256', ttl: 3600 } })
      const user = await auth.createUser({ name: 'Guest' })
      const { token } = await auth.issueSession(user.id)

      vi.advanceTimersByTime(1000)

      // threshold of 0 should be ignored (always refresh)
      const result1 = await auth.refreshSession(token, { threshold: 0 })
      expect(result1).not.toBeNull()

      vi.advanceTimersByTime(1000)

      // threshold of 1 should be ignored (always refresh)
      const result2 = await auth.refreshSession(result1!.token, { threshold: 1 })
      expect(result2).not.toBeNull()

      vi.advanceTimersByTime(1000)

      // threshold > 1 should be ignored (always refresh)
      const result3 = await auth.refreshSession(result2!.token, { threshold: 1.5 })
      expect(result3).not.toBeNull()
    })

    it('works with guest session keep-alive optimization', async () => {
      const ttl = 60 * 60 * 24 * 30 // 30 days
      const auth = createAuth({ adapter, providers: [], jwt: { secret, algorithm: 'HS256', ttl } })
      const user = await auth.createUser({ name: 'Guest' })
      let { token } = await auth.issueSession(user.id, { data: { isGuest: true } })

      // Day 1-14: below 50% threshold, no refresh
      for (let day = 1; day <= 14; day++) {
        vi.advanceTimersByTime(24 * 60 * 60 * 1000) // 1 day
        const result = await auth.refreshSession(token, { threshold: 0.5 })
        expect(result).toBeNull() // Should not refresh
      }

      // Day 15: past 50% threshold, should refresh
      vi.advanceTimersByTime(24 * 60 * 60 * 1000)
      const refreshed = await auth.refreshSession(token, { threshold: 0.5 })
      expect(refreshed).not.toBeNull()
      token = refreshed!.token

      // Verify custom claims preserved
      const payload = await auth.verifyJWT<{ isGuest: boolean }>(token)
      expect(payload?.isGuest).toBe(true)
    })
  })

  describe('request overload', () => {
    it('refreshes from Cookie and reports source=cookie', async () => {
      const auth = createAuth({ adapter, providers: [], jwt: { secret, algorithm: 'HS256', ttl: 3600 } })
      const user = await auth.createUser({ name: 'Guest' })
      const { token: originalToken } = await auth.issueSession(user.id)

      vi.advanceTimersByTime(1000)

      const req = new Request('http://localhost/', {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${originalToken}` },
      })
      const refreshed = await auth.refreshSession(req)

      expect(refreshed).not.toBeNull()
      expect(refreshed?.source).toBe('cookie')
      expect(refreshed?.token).toBeDefined()
      expect(refreshed?.cookie).toBeDefined()
    })

    it('refreshes from Authorization header and reports source=bearer', async () => {
      const auth = createAuth({ adapter, providers: [], jwt: { secret, algorithm: 'HS256', ttl: 3600 } })
      const user = await auth.createUser({ name: 'Guest' })
      const { token: originalToken } = await auth.issueSession(user.id)

      vi.advanceTimersByTime(1000)

      const req = new Request('http://localhost/', {
        headers: { Authorization: `Bearer ${originalToken}` },
      })
      const refreshed = await auth.refreshSession(req)

      expect(refreshed).not.toBeNull()
      expect(refreshed?.source).toBe('bearer')
    })

    it('reports source=token when passing a raw token string', async () => {
      const auth = createAuth({ adapter, providers: [], jwt: { secret, algorithm: 'HS256', ttl: 3600 } })
      const user = await auth.createUser({ name: 'Guest' })
      const { token: originalToken } = await auth.issueSession(user.id)

      vi.advanceTimersByTime(1000)

      const refreshed = await auth.refreshSession(originalToken)
      expect(refreshed).not.toBeNull()
      expect(refreshed?.source).toBe('token')
    })
  })
})
