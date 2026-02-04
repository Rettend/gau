import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryAdapter } from '../../src/adapters/memory/index'
import { SESSION_COOKIE_NAME, SESSION_STASH_COOKIE_NAME } from '../../src/core/cookies'
import { createAuth } from '../../src/core/createAuth'
import { ErrorCodes } from '../../src/core/errors'
import { isImpersonating } from '../../src/core/index'

describe('impersonation', () => {
  const adapter = MemoryAdapter()
  const secret = 'super-secret-hs256-key-for-impersonation-tests'

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('when disabled', () => {
    it('impersonation config is null when not provided', async () => {
      const auth = createAuth({
        adapter,
        providers: [],
        jwt: { secret, algorithm: 'HS256' },
      })

      expect(auth.impersonation).toBeNull()
    })

    it('impersonation config is null when enabled is false', async () => {
      const auth = createAuth({
        adapter,
        providers: [],
        jwt: { secret, algorithm: 'HS256' },
        impersonation: { enabled: false },
      })

      expect(auth.impersonation).toBeNull()
    })

    it('startImpersonation throws when impersonation is disabled', async () => {
      const auth = createAuth({
        adapter,
        providers: [],
        jwt: { secret, algorithm: 'HS256' },
      })

      await expect(auth.startImpersonation('admin-id', 'target-id')).rejects.toThrow('Impersonation is not enabled')
    })
  })

  describe('when enabled', () => {
    it('impersonation config is properly resolved with defaults', async () => {
      const auth = createAuth({
        adapter,
        providers: [],
        jwt: { secret, algorithm: 'HS256' },
        roles: { adminRoles: ['admin', 'superadmin'] },
        impersonation: { enabled: true },
      })

      expect(auth.impersonation).not.toBeNull()
      expect(auth.impersonation?.enabled).toBe(true)
      expect(auth.impersonation?.allowedRoles).toEqual(['admin', 'superadmin'])
      expect(auth.impersonation?.cannotImpersonate).toEqual(['admin', 'superadmin'])
      expect(auth.impersonation?.maxTTL).toBe(3600)
    })

    it('impersonation config uses custom values', async () => {
      const auth = createAuth({
        adapter,
        providers: [],
        jwt: { secret, algorithm: 'HS256' },
        roles: { adminRoles: ['admin'] },
        impersonation: {
          enabled: true,
          allowedRoles: ['support', 'admin'],
          cannotImpersonate: ['superadmin'],
          maxTTL: 7200,
        },
      })

      expect(auth.impersonation?.allowedRoles).toEqual(['support', 'admin'])
      expect(auth.impersonation?.cannotImpersonate).toEqual(['superadmin'])
      expect(auth.impersonation?.maxTTL).toBe(7200)
    })
  })

  describe('startImpersonation', () => {
    it('successfully starts impersonation with valid admin and target', async () => {
      const auth = createAuth({
        adapter,
        providers: [],
        jwt: { secret, algorithm: 'HS256' },
        roles: { adminRoles: ['admin'] },
        impersonation: { enabled: true },
      })

      const admin = await auth.createUser({ name: 'Admin', role: 'admin' })
      const target = await auth.createUser({ name: 'Target User', role: 'user' })

      const result = await auth.startImpersonation(admin.id, target.id)

      expect(result).not.toBeNull()
      expect(result?.token).toBeDefined()
      expect(result?.cookie).toBeDefined()
      expect(result?.originalCookie).toBeDefined()
      expect(result?.maxAge).toBe(3600) // default maxTTL
    })

    it('creates a valid impersonation session', async () => {
      const auth = createAuth({
        adapter,
        providers: [],
        jwt: { secret, algorithm: 'HS256' },
        roles: { adminRoles: ['admin'] },
        impersonation: { enabled: true },
      })

      const admin = await auth.createUser({ name: 'Admin', role: 'admin' })
      const target = await auth.createUser({ name: 'Target User', role: 'user' })

      const result = await auth.startImpersonation(admin.id, target.id)

      // Validate the impersonation session
      const session = await auth.validateSession(result!.token)
      expect(session?.user?.id).toBe(target.id)
      expect(session?.session?.impersonatedBy).toBe(admin.id)
      expect(session?.session?.impersonationExpiresAt).toBeDefined()
    })

    it('isImpersonating helper returns true for impersonation session', async () => {
      const auth = createAuth({
        adapter,
        providers: [],
        jwt: { secret, algorithm: 'HS256' },
        roles: { adminRoles: ['admin'] },
        impersonation: { enabled: true },
      })

      const admin = await auth.createUser({ name: 'Admin', role: 'admin' })
      const target = await auth.createUser({ name: 'Target User', role: 'user' })

      const result = await auth.startImpersonation(admin.id, target.id)
      const session = await auth.validateSession(result!.token)

      expect(isImpersonating(session?.session ?? null)).toBe(true)
      expect(isImpersonating(null)).toBe(false)
    })

    it('respects custom TTL (capped by maxTTL)', async () => {
      const auth = createAuth({
        adapter,
        providers: [],
        jwt: { secret, algorithm: 'HS256' },
        roles: { adminRoles: ['admin'] },
        impersonation: { enabled: true, maxTTL: 3600 },
      })

      const admin = await auth.createUser({ name: 'Admin', role: 'admin' })
      const target = await auth.createUser({ name: 'Target User', role: 'user' })

      // Request 2 hours, but capped at 1 hour (maxTTL)
      const result = await auth.startImpersonation(admin.id, target.id, { ttl: 7200 })
      expect(result?.maxAge).toBe(3600)
    })

    it('allows TTL below maxTTL', async () => {
      const auth = createAuth({
        adapter,
        providers: [],
        jwt: { secret, algorithm: 'HS256' },
        roles: { adminRoles: ['admin'] },
        impersonation: { enabled: true, maxTTL: 3600 },
      })

      const admin = await auth.createUser({ name: 'Admin', role: 'admin' })
      const target = await auth.createUser({ name: 'Target User', role: 'user' })

      const result = await auth.startImpersonation(admin.id, target.id, { ttl: 1800 })
      expect(result?.maxAge).toBe(1800)
    })

    it('throws when admin user does not exist', async () => {
      const auth = createAuth({
        adapter,
        providers: [],
        jwt: { secret, algorithm: 'HS256' },
        impersonation: { enabled: true },
      })

      const target = await auth.createUser({ name: 'Target User', role: 'user' })

      await expect(auth.startImpersonation('non-existent-admin', target.id)).rejects.toThrow('Admin user "non-existent-admin" not found')
    })

    it('throws when target user does not exist', async () => {
      const auth = createAuth({
        adapter,
        providers: [],
        jwt: { secret, algorithm: 'HS256' },
        roles: { adminRoles: ['admin'] },
        impersonation: { enabled: true },
      })

      const admin = await auth.createUser({ name: 'Admin', role: 'admin' })

      await expect(auth.startImpersonation(admin.id, 'non-existent-target')).rejects.toThrow('Target user "non-existent-target" not found')
    })

    it('throws when admin lacks allowed role', async () => {
      const auth = createAuth({
        adapter,
        providers: [],
        jwt: { secret, algorithm: 'HS256' },
        roles: { adminRoles: ['admin'] },
        impersonation: { enabled: true, allowedRoles: ['admin'] },
      })

      const nonAdmin = await auth.createUser({ name: 'Regular User', role: 'user' })
      const target = await auth.createUser({ name: 'Target User', role: 'user' })

      await expect(auth.startImpersonation(nonAdmin.id, target.id)).rejects.toThrow('You are not allowed to impersonate users')
    })

    it('allows admin from adminUserIds even without role', async () => {
      const auth = createAuth({
        adapter,
        providers: [],
        jwt: { secret, algorithm: 'HS256' },
        roles: { adminRoles: ['admin'], adminUserIds: ['special-admin-id'] },
        impersonation: { enabled: true },
      })

      const admin = await auth.createUser({ id: 'special-admin-id', name: 'Special Admin', role: 'user' })
      const target = await auth.createUser({ name: 'Target User', role: 'user' })

      const result = await auth.startImpersonation(admin.id, target.id)
      expect(result).not.toBeNull()
    })

    it('throws when target has protected role', async () => {
      const auth = createAuth({
        adapter,
        providers: [],
        jwt: { secret, algorithm: 'HS256' },
        roles: { adminRoles: ['admin'] },
        impersonation: { enabled: true, cannotImpersonate: ['admin'] },
      })

      const admin = await auth.createUser({ name: 'Admin', role: 'admin' })
      const target = await auth.createUser({ name: 'Target Admin', role: 'admin' })

      await expect(auth.startImpersonation(admin.id, target.id)).rejects.toThrow('Cannot impersonate users with protected roles')
    })

    it('calls onImpersonate hook with correct context', async () => {
      const onImpersonate = vi.fn()
      const auth = createAuth({
        adapter,
        providers: [],
        jwt: { secret, algorithm: 'HS256' },
        roles: { adminRoles: ['admin'] },
        impersonation: {
          enabled: true,
          onImpersonate,
        },
      })

      const admin = await auth.createUser({ name: 'Admin', role: 'admin' })
      const target = await auth.createUser({ name: 'Target User', role: 'user' })

      await auth.startImpersonation(admin.id, target.id, { reason: 'Customer support request' })

      expect(onImpersonate).toHaveBeenCalledWith({
        adminUserId: admin.id,
        targetUserId: target.id,
        reason: 'Customer support request',
        timestamp: expect.any(Number),
      })
    })

    it('session cookie is properly formatted', async () => {
      const auth = createAuth({
        adapter,
        providers: [],
        jwt: { secret, algorithm: 'HS256' },
        roles: { adminRoles: ['admin'] },
        impersonation: { enabled: true },
      })

      const admin = await auth.createUser({ name: 'Admin', role: 'admin' })
      const target = await auth.createUser({ name: 'Target User', role: 'user' })

      const result = await auth.startImpersonation(admin.id, target.id)

      expect(result?.cookie).toContain(`${SESSION_COOKIE_NAME}=`)
      expect(result?.cookie).toContain('HttpOnly')
      expect(result?.cookie).toContain('Path=/')
      expect(result?.originalCookie).toContain(`${SESSION_STASH_COOKIE_NAME}=`)
    })
  })

  describe('endImpersonation', () => {
    it('returns null when no stash cookie is present', async () => {
      const auth = createAuth({
        adapter,
        providers: [],
        jwt: { secret, algorithm: 'HS256' },
        impersonation: { enabled: true },
      })

      const request = new Request('http://localhost/')
      const result = await auth.endImpersonation(request)

      expect(result).toBeNull()
    })

    it('successfully ends impersonation and restores admin session', async () => {
      const auth = createAuth({
        adapter,
        providers: [],
        jwt: { secret, algorithm: 'HS256' },
        roles: { adminRoles: ['admin'] },
        impersonation: { enabled: true },
      })

      const admin = await auth.createUser({ name: 'Admin', role: 'admin' })
      const target = await auth.createUser({ name: 'Target User', role: 'user' })

      // Start impersonation
      const startResult = await auth.startImpersonation(admin.id, target.id)

      // Create request with stash cookie
      const request = new Request('http://localhost/', {
        headers: {
          Cookie: startResult!.originalCookie,
        },
      })

      // End impersonation
      const endResult = await auth.endImpersonation(request)

      expect(endResult).not.toBeNull()
      expect(endResult?.token).toBeDefined()
      expect(endResult?.cookie).toBeDefined()
      expect(endResult?.clearCookies.length).toBeGreaterThan(0)

      // Verify admin session is restored
      const restoredSession = await auth.validateSession(endResult!.token)
      expect(restoredSession?.user?.id).toBe(admin.id)
    })

    it('returns null when stash token is invalid', async () => {
      const auth = createAuth({
        adapter,
        providers: [],
        jwt: { secret, algorithm: 'HS256' },
        impersonation: { enabled: true },
      })

      const request = new Request('http://localhost/', {
        headers: {
          Cookie: `${SESSION_STASH_COOKIE_NAME}=invalid-token`,
        },
      })

      const result = await auth.endImpersonation(request)
      expect(result).toBeNull()
    })

    it('returns null when admin user no longer exists', async () => {
      const auth = createAuth({
        adapter,
        providers: [],
        jwt: { secret, algorithm: 'HS256' },
        roles: { adminRoles: ['admin'] },
        impersonation: { enabled: true },
      })

      const admin = await auth.createUser({ name: 'Admin', role: 'admin' })
      const target = await auth.createUser({ name: 'Target User', role: 'user' })

      // Start impersonation
      const startResult = await auth.startImpersonation(admin.id, target.id)

      // Delete admin user
      await auth.deleteUser(admin.id)

      // Create request with stash cookie
      const request = new Request('http://localhost/', {
        headers: {
          Cookie: startResult!.originalCookie,
        },
      })

      // End impersonation should fail
      const endResult = await auth.endImpersonation(request)
      expect(endResult).toBeNull()
    })

    it('clearCookies contains cookie to remove stash', async () => {
      const auth = createAuth({
        adapter,
        providers: [],
        jwt: { secret, algorithm: 'HS256' },
        roles: { adminRoles: ['admin'] },
        impersonation: { enabled: true },
      })

      const admin = await auth.createUser({ name: 'Admin', role: 'admin' })
      const target = await auth.createUser({ name: 'Target User', role: 'user' })

      const startResult = await auth.startImpersonation(admin.id, target.id)

      const request = new Request('http://localhost/', {
        headers: {
          Cookie: startResult!.originalCookie,
        },
      })

      const endResult = await auth.endImpersonation(request)

      // Check that clearCookies contains the stash cookie removal
      expect(endResult?.clearCookies.length).toBe(1)
      expect(endResult?.clearCookies[0]).toContain(SESSION_STASH_COOKIE_NAME)
      expect(endResult?.clearCookies[0]).toContain('Max-Age=0')
    })
  })

  describe('impersonation session validation', () => {
    it('impersonation session expires after TTL', async () => {
      const auth = createAuth({
        adapter,
        providers: [],
        jwt: { secret, algorithm: 'HS256' },
        roles: { adminRoles: ['admin'] },
        impersonation: { enabled: true, maxTTL: 60 },
      })

      const admin = await auth.createUser({ name: 'Admin', role: 'admin' })
      const target = await auth.createUser({ name: 'Target User', role: 'user' })

      const result = await auth.startImpersonation(admin.id, target.id, { ttl: 60 })

      // Validate immediately - should work
      let session = await auth.validateSession(result!.token)
      expect(session).not.toBeNull()

      // Advance past expiration
      vi.advanceTimersByTime(61 * 1000)

      session = await auth.validateSession(result!.token)
      expect(session).toBeNull()
    })
  })

  describe('edge cases', () => {
    it('allows impersonating user with no role', async () => {
      const auth = createAuth({
        adapter,
        providers: [],
        jwt: { secret, algorithm: 'HS256' },
        roles: { adminRoles: ['admin'] },
        impersonation: { enabled: true, cannotImpersonate: ['admin'] },
      })

      const admin = await auth.createUser({ name: 'Admin', role: 'admin' })
      const target = await auth.createUser({ name: 'Target User' }) // No role

      const result = await auth.startImpersonation(admin.id, target.id)
      expect(result).not.toBeNull()
    })

    it('admin can impersonate if they have allowed role', async () => {
      const auth = createAuth({
        adapter,
        providers: [],
        jwt: { secret, algorithm: 'HS256' },
        roles: { adminRoles: ['admin', 'superadmin'] },
        impersonation: {
          enabled: true,
          allowedRoles: ['admin', 'support'],
        },
      })

      const admin = await auth.createUser({ name: 'Admin', role: 'admin' })
      const target = await auth.createUser({ name: 'Target User', role: 'user' })

      const result = await auth.startImpersonation(admin.id, target.id)
      expect(result).not.toBeNull()
    })

    it('onImpersonate hook is optional', async () => {
      const auth = createAuth({
        adapter,
        providers: [],
        jwt: { secret, algorithm: 'HS256' },
        roles: { adminRoles: ['admin'] },
        impersonation: { enabled: true },
      })

      const admin = await auth.createUser({ name: 'Admin', role: 'admin' })
      const target = await auth.createUser({ name: 'Target User', role: 'user' })

      // Should not throw even without onImpersonate hook
      const result = await auth.startImpersonation(admin.id, target.id)
      expect(result).not.toBeNull()
    })

    it('error codes are correct', () => {
      expect(ErrorCodes.IMPERSONATION_DISABLED).toBe('IMPERSONATION_DISABLED')
      expect(ErrorCodes.IMPERSONATION_NOT_ALLOWED).toBe('IMPERSONATION_NOT_ALLOWED')
      expect(ErrorCodes.IMPERSONATION_TARGET_PROTECTED).toBe('IMPERSONATION_TARGET_PROTECTED')
    })
  })

  describe('use cases', () => {
    it('customer support scenario', async () => {
      const auditLog: any[] = []

      const auth = createAuth({
        adapter,
        providers: [],
        jwt: { secret, algorithm: 'HS256' },
        roles: { adminRoles: ['admin'], defaultRole: 'user' },
        impersonation: {
          enabled: true,
          allowedRoles: ['support', 'admin'],
          maxTTL: 1800, // 30 minutes
          onImpersonate: ({ adminUserId, targetUserId, reason, timestamp }) => {
            auditLog.push({ adminUserId, targetUserId, reason, timestamp })
          },
        },
      })

      // Support agent helps a customer
      const supportAgent = await auth.createUser({ name: 'Support Agent', role: 'support' })
      const customer = await auth.createUser({ name: 'John Doe', email: 'john@example.com', role: 'user' })

      // Start impersonation to help customer
      const result = await auth.startImpersonation(supportAgent.id, customer.id, {
        reason: 'Helping customer with billing issue #12345',
      })

      expect(result).not.toBeNull()
      expect(auditLog).toHaveLength(1)
      expect(auditLog[0].reason).toBe('Helping customer with billing issue #12345')

      // Verify support agent sees customer's session
      const impersonationSession = await auth.validateSession(result!.token)
      expect(impersonationSession?.user?.email).toBe('john@example.com')
      expect(isImpersonating(impersonationSession?.session ?? null)).toBe(true)

      // End impersonation
      const request = new Request('http://localhost/', {
        headers: { Cookie: result!.originalCookie },
      })
      const endResult = await auth.endImpersonation(request)

      expect(endResult).not.toBeNull()
      const restoredSession = await auth.validateSession(endResult!.token)
      expect(restoredSession?.user?.id).toBe(supportAgent.id)
    })

    it('admin debugging scenario', async () => {
      const auth = createAuth({
        adapter,
        providers: [],
        jwt: { secret, algorithm: 'HS256' },
        roles: { adminRoles: ['admin'] },
        impersonation: {
          enabled: true,
          maxTTL: 300, // 5 minutes max for debugging
        },
      })

      const admin = await auth.createUser({ name: 'Admin', role: 'admin' })
      const problematicUser = await auth.createUser({ name: 'Problematic User', role: 'user' })

      // Admin impersonates user to debug an issue
      const result = await auth.startImpersonation(admin.id, problematicUser.id, {
        ttl: 300,
        reason: 'Debugging reported issue with user dashboard',
      })

      expect(result?.maxAge).toBe(300)

      // Session contains impersonation metadata
      const payload = await auth.verifyJWT<{
        sub: string
        impersonatedBy: string
        impersonationExpiresAt: number
      }>(result!.token)

      expect(payload?.sub).toBe(problematicUser.id)
      expect(payload?.impersonatedBy).toBe(admin.id)
      expect(payload?.impersonationExpiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000))
    })
  })
})
