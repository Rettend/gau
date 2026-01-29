import type { Auth } from '../../../src/core/createAuth'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SESSION_COOKIE_NAME } from '../../../src/core/cookies'
import { handleSession } from '../../../src/core/handlers/session'
import { NULL_SESSION } from '../../../src/core/index'
import { setup } from '../../handler'

describe('session handler', () => {
  let auth: Auth

  beforeEach(() => {
    ({ auth } = setup())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should return session data for a valid token', async () => {
    const user = await auth.createUser({ name: 'Test User' })
    const sessionToken = await auth.createSession(user.id)
    const request = new Request('http://localhost/api/auth/session', {
      headers: { Authorization: `Bearer ${sessionToken}` },
    })

    const response = await handleSession(request, auth)
    const data = await response.json()

    expect(response.status).toBe(200)
    expect(data.user!.id).toBe(user.id)
    expect(data.session!.sub).toBe(user.id)
  })

  it('should return session data for a valid cookie', async () => {
    const user = await auth.createUser({ name: 'Test User' })
    const sessionToken = await auth.createSession(user.id)
    const request = new Request('http://localhost/api/auth/session', {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}` },
    })

    const response = await handleSession(request, auth)
    const data = await response.json()

    expect(response.status).toBe(200)
    expect(data.user!.id).toBe(user.id)
  })

  it('should return null session for no token', async () => {
    const request = new Request('http://localhost/api/auth/session')
    const response = await handleSession(request, auth)
    const data = await response.json()

    expect(response.status).toBe(200)
    expect(data).toEqual({ ...NULL_SESSION, providers: ['mock'] })
  })

  it('should return 401 for an invalid session token', async () => {
    const request = new Request('http://localhost/api/auth/session', {
      headers: { Authorization: 'Bearer invalid-token' },
    })
    const response = await handleSession(request, auth)
    expect(response.status).toBe(401)
    const data = await response.json()
    expect(data).toEqual({ ...NULL_SESSION, providers: ['mock'] })
  })

  it('should return 500 if session validation throws', async () => {
    const user = await auth.createUser({ name: 'Test User' })
    const sessionToken = await auth.createSession(user.id)
    vi.spyOn(auth, 'validateSession').mockRejectedValueOnce(new Error('Internal Server Error'))

    const request = new Request('http://localhost/api/auth/session', {
      headers: { Authorization: `Bearer ${sessionToken}` },
    })
    const response = await handleSession(request, auth)
    expect(response.status).toBe(500)
    const data = await response.json()
    expect(data.error).toBe('Failed to validate session')
  })
})
