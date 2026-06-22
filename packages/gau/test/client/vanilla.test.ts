import type { MockInstance } from 'vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as token from '../../src/client/token'
import { createAuthClient } from '../../src/client/vanilla'
import * as tauriHelpers from '../../src/runtimes/tauri/index'

describe('vanilla client', () => {
  const baseUrl = 'http://api.test/api/auth'

  let sessionToken: string | null
  let fetchSpy: MockInstance

  const mockGetSessionToken = vi.fn(() => sessionToken)
  const mockStoreSessionToken = vi.fn((t: string) => {
    sessionToken = t
  })
  const mockClearSessionToken = vi.fn(() => {
    sessionToken = null
  })
  const mockHandleRefreshedToken = vi.fn()

  const makeJsonResponse = (data: any, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
    new Response(JSON.stringify(data), { headers })

  const sessionPayload = (id: string) => ({ user: { id }, session: { sub: id }, accounts: [], providers: [] })

  beforeEach(() => {
    sessionToken = null
    fetchSpy = vi.spyOn(globalThis, 'fetch')
    vi.spyOn(token, 'getSessionToken').mockImplementation(mockGetSessionToken)
    vi.spyOn(token, 'storeSessionToken').mockImplementation(mockStoreSessionToken)
    vi.spyOn(token, 'clearSessionToken').mockImplementation(mockClearSessionToken)
    vi.spyOn(token, 'handleRefreshedToken').mockImplementation(mockHandleRefreshedToken)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('fetchSession: no token -> uses credentials and returns JSON session', async () => {
    fetchSpy.mockResolvedValueOnce(makeJsonResponse(sessionPayload('u1')))

    const client = createAuthClient({ baseUrl })
    const s = await client.fetchSession()
    expect(s).toEqual(sessionPayload('u1'))

    expect(fetchSpy).toHaveBeenCalledWith(
      `${baseUrl}/session`,
      { credentials: 'include' },
    )
  })

  it('fetchSession: with token -> sends Authorization header', async () => {
    sessionToken = 'tok-123'
    fetchSpy.mockResolvedValueOnce(makeJsonResponse(sessionPayload('u2')))

    const client = createAuthClient({ baseUrl })
    const s = await client.fetchSession()
    expect(s).toEqual(sessionPayload('u2'))

    expect(fetchSpy).toHaveBeenCalledWith(
      `${baseUrl}/session`,
      { headers: { Authorization: 'Bearer tok-123' } },
    )
  })

  it('fetchSession: non-JSON response -> returns null session shape', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('OK', { headers: { 'content-type': 'text/plain' } }))

    const client = createAuthClient({ baseUrl })
    const s = await client.fetchSession()
    expect(s).toEqual({ user: null, session: null, accounts: null, providers: [] })
  })

  it('refreshSession updates internal state and notifies listeners', async () => {
    fetchSpy.mockResolvedValueOnce(makeJsonResponse(sessionPayload('u3')))

    const client = createAuthClient({ baseUrl })
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
    const client = createAuthClient({ baseUrl })
    const url = await client.signIn('github', { redirectTo: 'http://app.test/cb', profile: 'work' })
    expect(url).toBe(`${baseUrl}/github?redirectTo=http%3A%2F%2Fapp.test%2Fcb&profile=work`)
  })

  it('signIn without redirect leaves URL untouched', async () => {
    const client = createAuthClient({ baseUrl })
    const url = await client.signIn('github')
    expect(url).toBe(`${baseUrl}/github`)
  })

  it('linkAccount: uses redirect URL when Response is redirected', async () => {
    sessionToken = 't'
    const redirectedResponse = { redirected: true, url: 'https://provider.test/redirect', json: vi.fn().mockResolvedValue({}), ok: true } as any
    fetchSpy.mockResolvedValueOnce(redirectedResponse)

    const client = createAuthClient({ baseUrl })
    const url = await client.linkAccount('github', { redirectTo: 'http://app/cb', profile: 'p1' })
    expect(fetchSpy).toHaveBeenCalledWith(
      `${baseUrl}/link/github?redirectTo=http%3A%2F%2Fapp%2Fcb&profile=p1&redirect=false`,
      { headers: { Authorization: 'Bearer t' } },
    )
    expect(url).toBe('https://provider.test/redirect')
  })

  it('linkAccount: uses JSON url when present', async () => {
    sessionToken = 't'
    fetchSpy.mockResolvedValueOnce({ redirected: false, url: '', json: vi.fn().mockResolvedValue({ url: 'https://from-json' }) } as any)

    const client = createAuthClient({ baseUrl })
    const url = await client.linkAccount('google', { redirectTo: 'http://app/cb' })
    expect(url).toBe('https://from-json')
  })

  it('linkAccount: falls back to constructed URL when no redirect or JSON url', async () => {
    sessionToken = null
    fetchSpy.mockResolvedValueOnce({ redirected: false, url: '', json: vi.fn().mockRejectedValue(new Error('no json')) } as any)

    const client = createAuthClient({ baseUrl })
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

    const client = createAuthClient({ baseUrl })
    const listener = vi.fn()
    client.onSessionChange(listener)
    const ok = await client.unlinkAccount('github')
    expect(ok).toBe(true)
    expect(fetchSpy).toHaveBeenNthCalledWith(1, `${baseUrl}/unlink/github`, { method: 'POST', credentials: 'include' })
    expect(fetchSpy).toHaveBeenNthCalledWith(2, `${baseUrl}/session`, { credentials: 'include' })
    expect(listener).toHaveBeenCalledWith(sessionPayload('u5'))
  })

  it('unlinkAccount: returns false on non-OK', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false } as any)
    const client = createAuthClient({ baseUrl })
    const ok = await client.unlinkAccount('github')
    expect(ok).toBe(false)
  })

  it('signOut: sends Authorization before clearing token, then refreshes session', async () => {
    sessionToken = 'to-clear'
    fetchSpy
      .mockResolvedValueOnce({ ok: true }) // POST signout
      .mockResolvedValueOnce(makeJsonResponse({ user: null, session: null, accounts: null, providers: [] })) // refreshSession

    const client = createAuthClient({ baseUrl })
    const listener = vi.fn()
    client.onSessionChange(listener)
    await client.signOut()
    expect(sessionToken).toBeNull()
    expect(fetchSpy).toHaveBeenNthCalledWith(1, `${baseUrl}/signout`, { method: 'POST', headers: { Authorization: 'Bearer to-clear' } })
    expect(fetchSpy).toHaveBeenNthCalledWith(2, `${baseUrl}/session`, { credentials: 'include' })
    expect(listener).toHaveBeenCalledWith({ user: null, session: null, accounts: null, providers: [] })
  })

  it('signIn uses Tauri helper when environment is Tauri', async () => {
    const isTauriSpy = vi.spyOn(tauriHelpers, 'isTauri').mockReturnValue(true)
    const signInWithTauriSpy = vi.spyOn(tauriHelpers, 'signInWithTauri').mockResolvedValue()

    const client = createAuthClient({ baseUrl, scheme: 'myapp' })
    const url = await client.signIn('github', { redirectTo: 'https://app.test/callback', profile: 'work' })

    expect(signInWithTauriSpy).toHaveBeenCalledWith('github', baseUrl, 'myapp', 'https://app.test/callback', 'work')
    expect(url).toBe(`${baseUrl}/github?redirectTo=https%3A%2F%2Fapp.test%2Fcallback&profile=work`)

    isTauriSpy.mockReturnValue(false)
  })

  it('linkAccount uses Tauri helper and skips fetch when environment is Tauri', async () => {
    const isTauriSpy = vi.spyOn(tauriHelpers, 'isTauri').mockReturnValue(true)
    const linkAccountWithTauriSpy = vi.spyOn(tauriHelpers, 'linkAccountWithTauri').mockResolvedValue()

    const client = createAuthClient({ baseUrl })
    const url = await client.linkAccount('github', { redirectTo: 'https://app.link' })

    expect(linkAccountWithTauriSpy).toHaveBeenCalledWith('github', baseUrl, 'gau', 'https://app.link', undefined)
    expect(url).toBe(`${baseUrl}/link/github?redirectTo=https%3A%2F%2Fapp.link&redirect=false`)
    expect(fetchSpy).not.toHaveBeenCalled()

    isTauriSpy.mockReturnValue(false)
  })

  it('startTauriBridge starts auth bridge and applies session token', async () => {
    const cleanup = vi.fn()
    const isTauriSpy = vi.spyOn(tauriHelpers, 'isTauri').mockReturnValue(true)
    const startAuthBridgeSpy = vi.spyOn(tauriHelpers, 'startAuthBridge').mockResolvedValue(cleanup)

    const client = createAuthClient({ baseUrl })
    const unlisten = await client.startTauriBridge()

    expect(startAuthBridgeSpy).toHaveBeenCalledWith(baseUrl, 'gau', expect.any(Function))
    expect(unlisten).toBe(cleanup)

    const handler = startAuthBridgeSpy.mock.calls[0][2]
    fetchSpy.mockResolvedValueOnce(makeJsonResponse(sessionPayload('bridge')))
    await handler('token-bridge')

    expect(mockStoreSessionToken).toHaveBeenCalledWith('token-bridge')
    expect(fetchSpy).toHaveBeenCalledWith(
      `${baseUrl}/session`,
      { headers: { Authorization: 'Bearer token-bridge' } },
    )

    isTauriSpy.mockReturnValue(false)
  })

  it('startTauriBridge is a no-op outside of Tauri', async () => {
    const isTauriSpy = vi.spyOn(tauriHelpers, 'isTauri').mockReturnValue(false)
    const startAuthBridgeSpy = vi.spyOn(tauriHelpers, 'startAuthBridge')

    const client = createAuthClient({ baseUrl })
    const result = await client.startTauriBridge()

    expect(result).toBeUndefined()
    expect(startAuthBridgeSpy).not.toHaveBeenCalled()

    isTauriSpy.mockReturnValue(false)
  })

  it('handleRedirectCallback applies token, notifies listeners, and cleans URL with one refresh', async () => {
    const replaceState = vi.fn()
    vi.stubGlobal('window', {
      location: {
        hash: '#token=redirect-token',
        pathname: '/callback',
        search: '?from=oauth',
      },
      history: {
        replaceState,
      },
    })

    fetchSpy.mockResolvedValueOnce(makeJsonResponse(sessionPayload('redirect-user')))

    const client = createAuthClient({ baseUrl })
    const listener = vi.fn()
    client.onSessionChange(listener)

    await expect(client.handleRedirectCallback()).resolves.toBe(true)

    expect(mockStoreSessionToken).toHaveBeenCalledWith('redirect-token')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy).toHaveBeenCalledWith(
      `${baseUrl}/session`,
      { headers: { Authorization: 'Bearer redirect-token' } },
    )
    expect(listener).toHaveBeenCalledWith(sessionPayload('redirect-user'))
    expect(replaceState).toHaveBeenCalledWith(null, '', '/callback?from=oauth')
  })

  describe('client.fetch', () => {
    it('adds Authorization header when token exists', async () => {
      sessionToken = 'my-token'
      fetchSpy.mockResolvedValueOnce(new Response('ok'))

      const client = createAuthClient({ baseUrl })
      await client.fetch('/api/data')

      expect(fetchSpy).toHaveBeenCalledWith('/api/data', expect.objectContaining({
        headers: expect.any(Headers),
      }))
      const call = fetchSpy.mock.calls[0]
      const headers = call[1].headers as Headers
      expect(headers.get('Authorization')).toBe('Bearer my-token')
    })

    it('uses credentials: include when no token', async () => {
      sessionToken = null
      fetchSpy.mockResolvedValueOnce(new Response('ok'))

      const client = createAuthClient({ baseUrl })
      await client.fetch('/api/data')

      expect(fetchSpy).toHaveBeenCalledWith('/api/data', expect.objectContaining({
        credentials: 'include',
      }))
    })

    it('calls handleRefreshedToken with response', async () => {
      const response = new Response('ok')
      fetchSpy.mockResolvedValueOnce(response)

      const client = createAuthClient({ baseUrl })
      await client.fetch('/api/data')

      expect(mockHandleRefreshedToken).toHaveBeenCalledWith(response)
    })

    it('returns the response', async () => {
      const response = new Response('ok')
      fetchSpy.mockResolvedValueOnce(response)

      const client = createAuthClient({ baseUrl })
      const res = await client.fetch('/api/data')

      expect(res).toBe(response)
    })

    it('passes through init options', async () => {
      sessionToken = 'tok'
      fetchSpy.mockResolvedValueOnce(new Response('ok'))

      const client = createAuthClient({ baseUrl })
      await client.fetch('/api/data', {
        method: 'POST',
        body: JSON.stringify({ foo: 'bar' }),
      })

      expect(fetchSpy).toHaveBeenCalledWith('/api/data', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ foo: 'bar' }),
      }))
    })

    it('merges custom headers with Authorization', async () => {
      sessionToken = 'tok'
      fetchSpy.mockResolvedValueOnce(new Response('ok'))

      const client = createAuthClient({ baseUrl })
      await client.fetch('/api/data', {
        headers: { 'Content-Type': 'application/json' },
      })

      const call = fetchSpy.mock.calls[0]
      const headers = call[1].headers as Headers
      expect(headers.get('Authorization')).toBe('Bearer tok')
      expect(headers.get('Content-Type')).toBe('application/json')
    })
  })
})
