import type { MockInstance } from 'vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAuthClient } from '../../src/client/vanilla'

describe('vanilla client', () => {
  const baseUrl = 'http://api.test/api/auth'

  let token: string | null
  let fetchSpy: MockInstance
  const tokenStore = {
    get: () => token,
    set: (t: string) => { token = t },
    clear: () => { token = null },
  }

  const makeJsonResponse = (data: any, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
    new Response(JSON.stringify(data), { headers })

  const sessionPayload = (id: string) => ({ user: { id }, session: { sub: id }, accounts: [], providers: [] })

  beforeEach(() => {
    token = null
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('fetchSession: no token -> uses credentials and returns JSON session', async () => {
    fetchSpy.mockResolvedValueOnce(makeJsonResponse(sessionPayload('u1')))

    const client = createAuthClient({ baseUrl, tokenStore })
    const s = await client.fetchSession()
    expect(s).toEqual(sessionPayload('u1'))

    expect(fetchSpy).toHaveBeenCalledWith(
      `${baseUrl}/session`,
      { credentials: 'include' },
    )
  })

  it('fetchSession: with token -> sends Authorization header', async () => {
    token = 'tok-123'
    fetchSpy.mockResolvedValueOnce(makeJsonResponse(sessionPayload('u2')))

    const client = createAuthClient({ baseUrl, tokenStore })
    const s = await client.fetchSession()
    expect(s).toEqual(sessionPayload('u2'))

    expect(fetchSpy).toHaveBeenCalledWith(
      `${baseUrl}/session`,
      { headers: { Authorization: 'Bearer tok-123' } },
    )
  })

  it('fetchSession: non-JSON response -> returns null session shape', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('OK', { headers: { 'content-type': 'text/plain' } }))

    const client = createAuthClient({ baseUrl, tokenStore })
    const s = await client.fetchSession()
    expect(s).toEqual({ user: null, session: null, accounts: null, providers: [] })
  })

  it('refreshSession updates internal state and notifies listeners', async () => {
    fetchSpy.mockResolvedValueOnce(makeJsonResponse(sessionPayload('u3')))

    const client = createAuthClient({ baseUrl, tokenStore })
    const listener = vi.fn()
    const off = client.onSessionChange(listener)

    const s = await client.refreshSession()
    expect(s).toEqual(sessionPayload('u3'))
    expect(listener).toHaveBeenCalledWith(sessionPayload('u3'))

    off()

    fetchSpy.mockResolvedValueOnce(makeJsonResponse(sessionPayload('u4')))
    await client.refreshSession()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('signIn returns provider URL with query params', async () => {
    const client = createAuthClient({ baseUrl, tokenStore })
    const url = await client.signIn('github', { redirectTo: 'http://app.test/cb', profile: 'work' })
    expect(url).toBe(`${baseUrl}/github?redirectTo=http%3A%2F%2Fapp.test%2Fcb&profile=work`)
  })

  it('linkAccount: uses redirect URL when Response is redirected', async () => {
    token = 't'
    const redirectedResponse = { redirected: true, url: 'https://provider.test/redirect', json: vi.fn().mockResolvedValue({}), ok: true } as any
    fetchSpy.mockResolvedValueOnce(redirectedResponse)

    const client = createAuthClient({ baseUrl, tokenStore })
    const url = await client.linkAccount('github', { redirectTo: 'http://app/cb', profile: 'p1' })
    expect(fetchSpy).toHaveBeenCalledWith(
      `${baseUrl}/link/github?redirectTo=http%3A%2F%2Fapp%2Fcb&profile=p1&redirect=false`,
      { headers: { Authorization: 'Bearer t' } },
    )
    expect(url).toBe('https://provider.test/redirect')
  })

  it('linkAccount: uses JSON url when present', async () => {
    token = 't'
    fetchSpy.mockResolvedValueOnce({ redirected: false, url: '', json: vi.fn().mockResolvedValue({ url: 'https://from-json' }) } as any)

    const client = createAuthClient({ baseUrl, tokenStore })
    const url = await client.linkAccount('google', { redirectTo: 'http://app/cb' })
    expect(url).toBe('https://from-json')
  })

  it('linkAccount: falls back to constructed URL when no redirect or JSON url', async () => {
    token = null
    fetchSpy.mockResolvedValueOnce({ redirected: false, url: '', json: vi.fn().mockRejectedValue(new Error('no json')) } as any)

    const client = createAuthClient({ baseUrl, tokenStore })
    const url = await client.linkAccount('discord', { profile: 'default' })
    expect(fetchSpy).toHaveBeenCalledWith(
      `${baseUrl}/link/discord?profile=default&redirect=false`,
      { credentials: 'include' },
    )
    expect(url).toBe(`${baseUrl}/link/discord?profile=default&redirect=false`)
  })

  it('unlinkAccount: returns true on 200 and refreshes session', async () => {
    fetchSpy
      .mockResolvedValueOnce({ ok: true }) // POST unlink
      .mockResolvedValueOnce(makeJsonResponse(sessionPayload('u5'))) // refreshSession

    const client = createAuthClient({ baseUrl, tokenStore })
    const ok = await client.unlinkAccount('github')
    expect(ok).toBe(true)
    expect(fetchSpy).toHaveBeenNthCalledWith(1, `${baseUrl}/unlink/github`, { method: 'POST', credentials: 'include' })
    expect(fetchSpy).toHaveBeenNthCalledWith(2, `${baseUrl}/session`, { credentials: 'include' })
  })

  it('unlinkAccount: returns false on non-OK', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false } as any)
    const client = createAuthClient({ baseUrl, tokenStore })
    const ok = await client.unlinkAccount('github')
    expect(ok).toBe(false)
  })

  it('signOut: clears token, POSTs without Authorization, then refreshes session', async () => {
    token = 'to-clear'
    fetchSpy
      .mockResolvedValueOnce({ ok: true }) // POST signout
      .mockResolvedValueOnce(makeJsonResponse(sessionPayload('u6'))) // refreshSession

    const client = createAuthClient({ baseUrl, tokenStore })
    await client.signOut()
    expect(token).toBeNull()
    expect(fetchSpy).toHaveBeenNthCalledWith(1, `${baseUrl}/signout`, { method: 'POST', credentials: 'include' })
    expect(fetchSpy).toHaveBeenNthCalledWith(2, `${baseUrl}/session`, { credentials: 'include' })
  })
})
