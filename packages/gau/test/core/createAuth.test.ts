import { Buffer } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { MemoryAdapter } from '../../src/adapters/memory/index'
import { createAuth } from '../../src/core/createAuth'
import { AuthError } from '../../src/core/index'
import { GitHub, Google } from '../../src/oauth'

describe('createAuth', () => {
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

  it('initializes with default options', () => {
    const auth = createAuth({ adapter, providers: [] })
    expect(auth.basePath).toBe('/api/auth')
    expect(auth.jwt.ttl).toBe(3600 * 24 * 7)
    expect(auth.cookieOptions.path).toBe('/')
    expect(auth.trustHosts).toEqual([])
    expect(auth.autoLink).toBe('verifiedEmail')
  })

  it('initializes with custom options', () => {
    const auth = createAuth({
      adapter,
      providers: [],
      basePath: '/custom/auth',
      jwt: { ttl: 60 },
      cookies: { path: '/custom' },
      trustHosts: ['example.com'],
      autoLink: 'always',
    })
    expect(auth.basePath).toBe('/custom/auth')
    expect(auth.jwt.ttl).toBe(60)
    expect(auth.cookieOptions.path).toBe('/custom')
    expect(auth.trustHosts).toEqual(['example.com'])
    expect(auth.autoLink).toBe('always')
  })

  it('throws AuthError for invalid ES256 secret type', () => {
    expect(() => createAuth({
      adapter,
      providers: [],
      jwt: { algorithm: 'ES256', secret: new Uint8Array() as any },
    })).toThrow(new AuthError('For ES256, the secret option must be a string.'))
  })

  it('creates and retrieves a user via the adapter methods', async () => {
    const auth = createAuth({ adapter, providers: [] })
    const user = await auth.createUser({ name: 'Alice', email: 'alice@example.com' })
    expect(user.id).toBeDefined()

    const fetched = await auth.getUser(user.id)
    expect(fetched).not.toBeNull()
    expect(fetched?.email).toBe('alice@example.com')
  })

  it('creates and validates a session', async () => {
    const auth = createAuth({ adapter, providers: [], jwt: { secret, algorithm: 'HS256' } })
    const user = await auth.createUser({ name: 'Bob', email: 'bob@example.com' })
    const sessionToken = await auth.createSession(user.id)

    const validated = await auth.validateSession(sessionToken)
    expect(validated).not.toBeNull()
    expect(validated?.user?.id).toBe(user.id)
    expect(validated?.session?.sub).toBe(user.id)
  })

  it('returns null when validating an expired session', async () => {
    const auth = createAuth({ adapter, providers: [], jwt: { secret, algorithm: 'HS256', ttl: 60 } })
    const user = await auth.createUser({ name: 'Charlie', email: 'charlie@example.com' })
    const sessionToken = await auth.createSession(user.id)

    vi.advanceTimersByTime(61 * 1000) // 61 seconds later

    const validated = await auth.validateSession(sessionToken)
    expect(validated).toBeNull()
  })

  it('returns null when validating a session for a non-existent user', async () => {
    const auth = createAuth({ adapter, providers: [], jwt: { secret, algorithm: 'HS256' } })
    const sessionToken = await auth.createSession('non-existent-user-id')
    const validated = await auth.validateSession(sessionToken)
    expect(validated).toBeNull()
  })

  it('returns null when validating a session for a deleted user', async () => {
    const auth = createAuth({ adapter, providers: [], jwt: { secret, algorithm: 'HS256' } })
    const user = await auth.createUser({ name: 'Ephemeral User' })
    const sessionToken = await auth.createSession(user.id)

    // Simulate user deletion
    vi.spyOn(adapter, 'getUser').mockResolvedValue(null)

    const validated = await auth.validateSession(sessionToken)
    expect(validated).toBeNull()
  })

  it('returns null when validating an invalid token', async () => {
    const auth = createAuth({ adapter, providers: [] })
    const validated = await auth.validateSession('invalid-token')
    expect(validated).toBeNull()
  })

  it('signs and verifies a JWT with custom options', async () => {
    const auth = createAuth({
      adapter,
      providers: [],
      jwt: { secret, algorithm: 'HS256', iss: 'my-app', aud: 'my-aud' },
    })
    const token = await auth.signJWT({ custom: 'payload' })
    const payload = await auth.verifyJWT(token)
    expect(payload).not.toBeNull()
    expect((payload as any).custom).toBe('payload')
    expect((payload as any).iss).toBe('my-app')
    expect((payload as any).aud).toBe('my-aud')
  })

  it('signs and verifies a JWT with ES256', async () => {
    const auth = createAuth({
      adapter,
      providers: [],
      jwt: { secret: es256Secret, algorithm: 'ES256' },
    })
    const token = await auth.signJWT({ es: '256' })
    const payload = await auth.verifyJWT(token)
    expect(payload).not.toBeNull()
    expect((payload as any).es).toBe('256')
  })

  it('verifyJWT returns null for a bad signature', async () => {
    const auth1 = createAuth({ adapter, providers: [], jwt: { secret: 'secret1', algorithm: 'HS256' } })
    const auth2 = createAuth({ adapter, providers: [], jwt: { secret: 'secret2', algorithm: 'HS256' } })

    const token = await auth1.signJWT({ data: 'test' })
    const payload = await auth2.verifyJWT(token)
    expect(payload).toBeNull()
  })

  it('throws when providing a non-string custom secret with ES256', async () => {
    const auth = createAuth({
      adapter,
      providers: [],
      jwt: { secret: es256Secret, algorithm: 'ES256' },
    })
    const promise = auth.signJWT({ es: '256' }, { secret: new Uint8Array() as any })
    await expect(promise).rejects.toThrow(new AuthError('For ES256, the secret option must be a string.'))
  })

  it('throws when providing a non-string custom secret for verification with ES256', async () => {
    const auth = createAuth({
      adapter,
      providers: [],
      jwt: { secret: es256Secret, algorithm: 'ES256' },
    })
    const token = await auth.signJWT({ es: '256' })
    const promise = auth.verifyJWT(token, { secret: new Uint8Array() as any })
    await expect(promise).rejects.toThrow(new AuthError('For ES256, the secret option must be a string.'))
  })

  it('exposes configured profiles on the auth object', () => {
    const auth = createAuth({
      adapter,
      providers: [
        GitHub({ clientId: 'id', clientSecret: 'secret' }),
        Google({ clientId: 'gid', clientSecret: 'gsecret' }),
      ],
      profiles: {
        github: {
          lite: { scopes: ['read:user'] },
        },
        google: {
          desktop: { redirectUri: 'app://desktop' },
        },
      },
    })

    expect(auth.profiles).toBeDefined()
    expect(auth.profiles.github).toBeDefined()
    expect(auth.profiles.google).toBeDefined()
    const gh = auth.profiles.github!
    const gg = auth.profiles.google!
    expect(gh.lite.scopes).toEqual(['read:user'])
    expect(gg.desktop.redirectUri).toBe('app://desktop')
    expectTypeOf(gh.lite.scopes).toEqualTypeOf<string[] | undefined>()
    expectTypeOf(gg.desktop.redirectUri).toEqualTypeOf<string | undefined>()
  })
})
