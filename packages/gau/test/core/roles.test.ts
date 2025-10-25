import type { Auth } from '../../src/core/createAuth'
import { beforeEach, describe, expect, it } from 'vitest'
import { MemoryAdapter } from '../../src/adapters'
import { CSRF_COOKIE_NAME, PKCE_COOKIE_NAME } from '../../src/core/cookies'
import { createAuth } from '../../src/core/createAuth'
import { handleCallback } from '../../src/core/handlers/callback'
import { mockProvider, setup } from '../handler'

describe('roles', () => {
  let auth: Auth

  beforeEach(() => {
    ({ auth } = setup())
  })

  it('assigns defaultRole on first sign-in when resolveOnCreate is undefined', async () => {
    auth = createAuth({
      adapter: MemoryAdapter(),
      providers: [mockProvider],
      jwt: { secret: 'test', algorithm: 'HS256' },
      roles: { defaultRole: 'user' },
    })

    const state = 'state123'
    const request = new Request(`http://localhost/api/auth/mock/callback?code=c&state=${state}`)
    request.headers.set('Cookie', `${CSRF_COOKIE_NAME}=${state}; ${PKCE_COOKIE_NAME}=pkce;`)

    await handleCallback(request, auth, 'mock')
    const user = await auth.getUserByEmail('user@provider.com')
    expect(user?.role).toBe('user')
  })

  it('assigns resolveOnCreate return value on first sign-in', async () => {
    auth = createAuth({
      adapter: MemoryAdapter(),
      providers: [mockProvider],
      jwt: { secret: 'test', algorithm: 'HS256' },
      roles: {
        defaultRole: 'user',
        resolveOnCreate: () => 'admin',
      },
    })

    const state = 'state123'
    const request = new Request(`http://localhost/api/auth/mock/callback?code=c&state=${state}`)
    request.headers.set('Cookie', `${CSRF_COOKIE_NAME}=${state}; ${PKCE_COOKIE_NAME}=pkce;`)

    await handleCallback(request, auth, 'mock')
    const user = await auth.getUserByEmail('user@provider.com')
    expect(user?.role).toBe('admin')
  })

  it('falls back to defaultRole if resolveOnCreate throws', async () => {
    auth = createAuth({
      adapter: MemoryAdapter(),
      providers: [mockProvider],
      jwt: { secret: 'test', algorithm: 'HS256' },
      roles: {
        defaultRole: 'user',
        resolveOnCreate: () => { throw new Error('boom') },
      },
    })

    const state = 'state123'
    const request = new Request(`http://localhost/api/auth/mock/callback?code=c&state=${state}`)
    request.headers.set('Cookie', `${CSRF_COOKIE_NAME}=${state}; ${PKCE_COOKIE_NAME}=pkce;`)

    await handleCallback(request, auth, 'mock')
    const user = await auth.getUserByEmail('user@provider.com')
    expect(user?.role).toBe('user')
  })

  it('session exposes user.role after sign-in', async () => {
    auth = createAuth({
      adapter: MemoryAdapter(),
      providers: [mockProvider],
      jwt: { secret: 'test', algorithm: 'HS256' },
      roles: { defaultRole: 'admin' },
    })

    const state = 's'
    const request = new Request(`http://localhost/api/auth/mock/callback?code=c&state=${state}&redirect=false`)
    request.headers.set('Cookie', `${CSRF_COOKIE_NAME}=${state}; ${PKCE_COOKIE_NAME}=pkce;`)
    const response = await handleCallback(request, auth, 'mock')
    expect(response.status).toBe(200)

    const { user } = await response.json()
    expect(user.role).toBe('admin')
  })

  it('does not crash if adapter returns users without role (no column)', async () => {
    // MemoryAdapter does not enforce schema; simulate an existing user without role
    const plainAuth = createAuth({ adapter: MemoryAdapter(), providers: [] })
    const created = await plainAuth.createUser({ email: 'norole@example.com' })
    expect(created.role).toBeUndefined()

    const fetched = await plainAuth.getUser(created.id)
    expect(fetched?.role).toBeUndefined()
  })
})
