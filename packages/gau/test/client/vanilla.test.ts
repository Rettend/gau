import type { MockInstance } from 'vite-plus/test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { requestAuthJson } from '../../src/client/shared/session'
import * as token from '../../src/client/token'
import { AuthClientError, createAuthClient } from '../../src/client/vanilla'
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
  const guestPayload = { user: null, session: null, accounts: null, providers: ['github'] }
  const rejectedSession = () => Response.json(guestPayload, { status: 401 })

  beforeEach(() => {
    sessionToken = null
    mockGetSessionToken.mockClear()
    mockStoreSessionToken.mockClear()
    mockClearSessionToken.mockClear()
    mockHandleRefreshedToken.mockClear()
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

    expect(fetchSpy).toHaveBeenCalledWith(`${baseUrl}/session`, {
      credentials: 'omit',
      headers: { Authorization: 'Bearer tok-123' },
    })
  })

  it('fetchSession rejects a non-JSON fallback rather than reporting a successful anonymous session', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('OK', { headers: { 'content-type': 'text/plain' } }))

    const client = createAuthClient({ baseUrl })
    await expect(client.fetchSession()).rejects.toMatchObject({ code: 'INVALID_RESPONSE', status: 200 })
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

  describe('rejected sessions', () => {
    it('clears an expired bearer token with one request and publishes the guest session and providers', async () => {
      sessionToken = 'expired-token'
      const client = createAuthClient({ baseUrl })
      const listener = vi.fn()
      const errors = vi.fn()
      client.onSessionChange(listener)
      client.onSessionError(errors)
      fetchSpy.mockResolvedValueOnce(new Response('private error', { status: 500 }))
      await expect(client.refreshSession()).rejects.toBeInstanceOf(AuthClientError)
      expect(client.sessionLoaded).toBe(false)
      expect(client.sessionError).not.toBeNull()
      fetchSpy.mockClear()
      fetchSpy.mockResolvedValueOnce(rejectedSession())

      await expect(client.refreshSession()).resolves.toEqual(guestPayload)

      expect(fetchSpy).toHaveBeenCalledExactlyOnceWith(`${baseUrl}/session`, {
        credentials: 'omit',
        headers: { Authorization: 'Bearer expired-token' },
      })
      expect(sessionToken).toBeNull()
      expect(mockClearSessionToken).toHaveBeenCalledTimes(1)
      expect(mockStoreSessionToken).not.toHaveBeenCalled()
      expect(client.session).toEqual(guestPayload)
      expect(client.sessionLoaded).toBe(true)
      expect(client.sessionError).toBeNull()
      expect(listener).toHaveBeenCalledExactlyOnceWith(guestPayload)
      expect(errors).toHaveBeenLastCalledWith(null)
    })

    it.each([null, ''])('accepts a cookie session rejection without clearing stored token %s', async (savedToken) => {
      sessionToken = savedToken
      const guest = { ...guestPayload, accounts: [], providers: [] }
      fetchSpy.mockResolvedValueOnce(Response.json(guest, { status: 401 }))
      const client = createAuthClient({ baseUrl })

      await expect(client.refreshSession()).resolves.toEqual(guest)

      expect(fetchSpy).toHaveBeenCalledExactlyOnceWith(`${baseUrl}/session`, { credentials: 'include' })
      expect(mockClearSessionToken).not.toHaveBeenCalled()
      expect(sessionToken).toBe(savedToken)
      expect(client.session).toEqual(guest)
      expect(client.sessionLoaded).toBe(true)
      expect(client.sessionError).toBeNull()
    })

    it.each(['expired-token', null])('fetchSession remains a pure read for a 401 with token %s', async (savedToken) => {
      sessionToken = savedToken
      const client = createAuthClient({ baseUrl, session: sessionPayload('current') })
      fetchSpy.mockResolvedValueOnce(new Response('private error', { status: 500 }))
      await expect(client.refreshSession()).rejects.toBeInstanceOf(AuthClientError)
      const previousError = client.sessionError
      const listener = vi.fn()
      const errors = vi.fn()
      client.onSessionChange(listener)
      client.onSessionError(errors)
      fetchSpy.mockClear()
      fetchSpy.mockResolvedValueOnce(rejectedSession())

      await expect(client.fetchSession()).resolves.toEqual(guestPayload)

      expect(fetchSpy).toHaveBeenCalledTimes(1)
      expect(sessionToken).toBe(savedToken)
      expect(mockClearSessionToken).not.toHaveBeenCalled()
      expect(client.session).toEqual(sessionPayload('current'))
      expect(client.sessionError).toBe(previousError)
      expect(listener).not.toHaveBeenCalled()
      expect(errors).not.toHaveBeenCalled()
    })

    it('fetchSession does not mark an unloaded client as loaded for a 401', async () => {
      fetchSpy.mockResolvedValueOnce(rejectedSession())
      const client = createAuthClient({ baseUrl })
      await client.fetchSession()
      expect(client.sessionLoaded).toBe(false)
      expect(client.session.providers).toEqual([])
    })

    it.each([
      ['signed-in session', sessionPayload('private-account')],
      ['user without session', { ...guestPayload, user: { id: 'private-account' } }],
      ['session without user', { ...guestPayload, session: { sub: 'private-account' } }],
      ['missing user', { session: null, accounts: null, providers: [] }],
      ['missing session', { user: null, accounts: null, providers: [] }],
      ['missing providers', { user: null, session: null, accounts: null }],
      ['null providers', { ...guestPayload, providers: null }],
      ['non-array providers', { ...guestPayload, providers: 'github' }],
      ['non-string provider', { ...guestPayload, providers: ['github', 123] }],
      ['linked accounts', { ...guestPayload, accounts: [{ provider: 'github', providerAccountId: 'private-account' }] }],
      ['invalid accounts', { ...guestPayload, accounts: {} }],
      ['invalid account entries', { ...guestPayload, accounts: ['private-account'] }],
      ['generic backend error', { error: 'private backend error', code: 'UNAUTHORIZED' }],
      ['null JSON', null],
      ['array JSON', []],
    ])('rejects a 401 with %s without changing credentials or session', async (_name, body) => {
      sessionToken = 'saved-token'
      fetchSpy.mockResolvedValueOnce(Response.json(body, { status: 401 }))
      const client = createAuthClient({ baseUrl, session: sessionPayload('current') })
      const listener = vi.fn()
      client.onSessionChange(listener)

      await expect(client.refreshSession()).rejects.toMatchObject({ code: 'HTTP_ERROR', status: 401 })

      expect(sessionToken).toBe('saved-token')
      expect(mockClearSessionToken).not.toHaveBeenCalled()
      expect(client.session).toEqual(sessionPayload('current'))
      expect(client.sessionLoaded).toBe(true)
      expect(listener).not.toHaveBeenCalled()
      expect(String(client.sessionError)).not.toContain('private')
    })

    it.each([
      ['non-JSON', () => new Response(JSON.stringify(guestPayload), { status: 401, headers: { 'Content-Type': 'text/plain' } })],
      ['malformed JSON', () => new Response('{private', { status: 401, headers: { 'Content-Type': 'application/json' } })],
    ])('rejects a %s 401 without clearing the token', async (_name, response) => {
      sessionToken = 'saved-token'
      fetchSpy.mockResolvedValueOnce(response())
      const client = createAuthClient({ baseUrl, session: sessionPayload('current') })
      await expect(client.refreshSession()).rejects.toMatchObject({ code: 'INVALID_RESPONSE', status: 401 })
      expect(sessionToken).toBe('saved-token')
      expect(mockClearSessionToken).not.toHaveBeenCalled()
      expect(client.session).toEqual(sessionPayload('current'))
      expect(String(client.sessionError)).not.toContain('private')
    })

    it.each([403, 500])('does not treat a guest response with HTTP %s as expiration', async (status) => {
      sessionToken = 'saved-token'
      fetchSpy.mockResolvedValueOnce(Response.json(guestPayload, { status }))
      const client = createAuthClient({ baseUrl, session: sessionPayload('current') })
      await expect(client.refreshSession()).rejects.toMatchObject({ code: 'HTTP_ERROR', status })
      expect(sessionToken).toBe('saved-token')
      expect(mockClearSessionToken).not.toHaveBeenCalled()
      expect(client.session).toEqual(sessionPayload('current'))
    })

    it('preserves credentials and session after a network failure', async () => {
      sessionToken = 'saved-token'
      fetchSpy.mockRejectedValueOnce(new Error('private network error'))
      const client = createAuthClient({ baseUrl, session: sessionPayload('current') })
      await expect(client.refreshSession()).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
      expect(sessionToken).toBe('saved-token')
      expect(mockClearSessionToken).not.toHaveBeenCalled()
      expect(client.session).toEqual(sessionPayload('current'))
      expect(String(client.sessionError)).not.toContain('private')
    })

    it('keeps the generic token JSON request strict even for a signed-out 401', async () => {
      fetchSpy.mockResolvedValueOnce(rejectedSession())
      await expect(requestAuthJson(`${baseUrl}/token`, {})).rejects.toMatchObject({ code: 'HTTP_ERROR', status: 401 })
      expect(mockClearSessionToken).not.toHaveBeenCalled()
    })

    it.each(['new token', 'same token', 'setSession'])('ignores an old 401 after applying %s', async (action) => {
      sessionToken = 'old-token'
      const pending = Promise.withResolvers<Response>()
      fetchSpy.mockReturnValueOnce(pending.promise)
      const client = createAuthClient({ baseUrl, session: sessionPayload('old') })
      const oldRefresh = client.refreshSession()
      const next = sessionPayload('new')
      if (action === 'setSession') client.setSession(next)
      else {
        fetchSpy.mockResolvedValueOnce(makeJsonResponse(next))
        await client.applySessionToken(action === 'same token' ? 'old-token' : 'new-token')
      }
      const listener = vi.fn()
      const errors = vi.fn()
      client.onSessionChange(listener)
      client.onSessionError(errors)
      pending.resolve(rejectedSession())

      await expect(oldRefresh).resolves.toBe(client.session)

      expect(sessionToken).toBe(action === 'new token' ? 'new-token' : 'old-token')
      expect(mockClearSessionToken).not.toHaveBeenCalled()
      expect(client.session).toEqual(next)
      expect(client.sessionError).toBeNull()
      expect(listener).not.toHaveBeenCalled()
      expect(errors).not.toHaveBeenCalled()
    })

    it.each(['signed in', 'signed out'])('keeps the latest concurrent refresh when it resolves %s first', async (latest) => {
      sessionToken = 'saved-token'
      const pending = Promise.withResolvers<Response>()
      fetchSpy.mockReturnValueOnce(pending.promise)
      const client = createAuthClient({ baseUrl })
      const listener = vi.fn()
      client.onSessionChange(listener)
      const oldRefresh = client.refreshSession()
      const next = latest === 'signed in' ? sessionPayload('new') : { ...guestPayload, providers: ['google'] }
      fetchSpy.mockResolvedValueOnce(Response.json(next, { status: latest === 'signed in' ? 200 : 401 }))
      await client.refreshSession()
      pending.resolve(latest === 'signed in' ? rejectedSession() : makeJsonResponse(sessionPayload('old')))

      await expect(oldRefresh).resolves.toBe(client.session)

      expect(client.session).toEqual(next)
      expect(sessionToken).toBe(latest === 'signed in' ? 'saved-token' : null)
      expect(mockClearSessionToken).toHaveBeenCalledTimes(latest === 'signed in' ? 0 : 1)
      expect(listener).toHaveBeenCalledExactlyOnceWith(next)
    })

    it('ignores an earlier 401 while the latest refresh is still pending', async () => {
      sessionToken = 'saved-token'
      const first = Promise.withResolvers<Response>()
      const latest = Promise.withResolvers<Response>()
      fetchSpy.mockReturnValueOnce(first.promise).mockReturnValueOnce(latest.promise)
      const client = createAuthClient({ baseUrl, session: sessionPayload('current') })
      const listener = vi.fn()
      client.onSessionChange(listener)
      const oldRefresh = client.refreshSession()
      const latestRefresh = client.refreshSession()
      first.resolve(rejectedSession())

      await expect(oldRefresh).resolves.toEqual(sessionPayload('current'))

      expect(sessionToken).toBe('saved-token')
      expect(mockClearSessionToken).not.toHaveBeenCalled()
      expect(listener).not.toHaveBeenCalled()
      latest.resolve(rejectedSession())
      await expect(latestRefresh).resolves.toEqual(guestPayload)
      expect(sessionToken).toBeNull()
      expect(mockClearSessionToken).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledExactlyOnceWith(guestPayload)
    })

    it('ignores an old 401 immediately after signout begins', async () => {
      sessionToken = 'old-token'
      const pending = Promise.withResolvers<Response>()
      const signout = Promise.withResolvers<Response>()
      fetchSpy.mockReturnValueOnce(pending.promise).mockReturnValueOnce(signout.promise)
      const client = createAuthClient({ baseUrl, session: sessionPayload('old') })
      const oldRefresh = client.refreshSession()
      const signingOut = client.signOut()
      const listener = vi.fn()
      client.onSessionChange(listener)
      pending.resolve(rejectedSession())

      await expect(oldRefresh).resolves.toBe(client.session)

      expect(sessionToken).toBeNull()
      expect(mockClearSessionToken).toHaveBeenCalledTimes(1)
      expect(client.session.user).toBeNull()
      expect(client.session.providers).toEqual([])
      expect(listener).not.toHaveBeenCalled()
      fetchSpy.mockResolvedValueOnce(makeJsonResponse(guestPayload))
      signout.resolve(new Response())
      await signingOut
      expect(client.session).toEqual(guestPayload)
    })

    it.each(['rejected session', 'successful session', 'HTTP error', 'network error'])(
      'ignores state effects from an old %s after an external token change without a revision',
      async (responseKind) => {
        sessionToken = 'old-token'
        const client = createAuthClient({ baseUrl, session: sessionPayload('new-account') })
        fetchSpy.mockResolvedValueOnce(new Response('previous private error', { status: 503 }))
        await expect(client.refreshSession()).rejects.toBeInstanceOf(AuthClientError)
        const previousError = client.sessionError
        const listener = vi.fn()
        const errors = vi.fn()
        client.onSessionChange(listener)
        client.onSessionError(errors)
        const pending = Promise.withResolvers<Response>()
        fetchSpy.mockReturnValueOnce(pending.promise)
        const oldRefresh = client.refreshSession()
        sessionToken = 'new-token'
        if (responseKind === 'network error') pending.reject(new Error('private network error'))
        else pending.resolve(responseKind === 'rejected session'
          ? rejectedSession()
          : responseKind === 'successful session'
            ? makeJsonResponse(sessionPayload('old-account'))
            : new Response('private backend error', { status: 500 }))

        if (responseKind.endsWith('error')) await expect(oldRefresh).rejects.toBeInstanceOf(AuthClientError)
        else await expect(oldRefresh).resolves.toBe(client.session)

        expect(sessionToken).toBe('new-token')
        expect(mockClearSessionToken).not.toHaveBeenCalled()
        expect(client.session).toEqual(sessionPayload('new-account'))
        expect(client.sessionError).toBe(previousError)
        expect(listener).not.toHaveBeenCalled()
        expect(errors).not.toHaveBeenCalled()
      },
    )
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
      { credentials: 'omit', headers: { Authorization: 'Bearer t' } },
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
    expect(fetchSpy).toHaveBeenNthCalledWith(1, `${baseUrl}/signout`, {
      method: 'POST',
      credentials: 'include',
      headers: { Authorization: 'Bearer to-clear' },
    })
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
    const setupListener = vi.spyOn(tauriHelpers, 'setupTauriListener').mockResolvedValue(cleanup)
    const handleDeepLink = vi
      .spyOn(tauriHelpers, 'handleTauriDeepLink')
      .mockImplementation(async (_url, _base, _scheme, onToken) => {
        await onToken('token-bridge')
      })

    const client = createAuthClient({ baseUrl })
    const unlisten = await client.startTauriBridge()

    expect(setupListener).toHaveBeenCalledWith(expect.any(Function))
    expect(unlisten).toBe(cleanup)

    const handler = setupListener.mock.calls[0]![0]
    fetchSpy.mockResolvedValueOnce(makeJsonResponse(sessionPayload('bridge')))
    await handler('gau://oauth/callback?code=one-time-code')
    expect(handleDeepLink).toHaveBeenCalledWith(
      'gau://oauth/callback?code=one-time-code',
      baseUrl,
      'gau',
      expect.any(Function),
    )

    expect(mockStoreSessionToken).toHaveBeenCalledWith('token-bridge')
    expect(fetchSpy).toHaveBeenCalledWith(`${baseUrl}/session`, {
      credentials: 'omit',
      headers: { Authorization: 'Bearer token-bridge' },
    })

    isTauriSpy.mockReturnValue(false)
  })

  it('startTauriBridge is a no-op outside of Tauri', async () => {
    const isTauriSpy = vi.spyOn(tauriHelpers, 'isTauri').mockReturnValue(false)
    const setupListener = vi.spyOn(tauriHelpers, 'setupTauriListener')

    const client = createAuthClient({ baseUrl })
    const result = await client.startTauriBridge()

    expect(result).toBeUndefined()
    expect(setupListener).not.toHaveBeenCalled()

    isTauriSpy.mockReturnValue(false)
  })

  it.each(['refresh', 'expiration', 'signout', 'account change'])('handles a pending native exchange during %s', async (action) => {
    vi.spyOn(tauriHelpers, 'isTauri').mockReturnValue(true)
    const setupListener = vi.spyOn(tauriHelpers, 'setupTauriListener').mockResolvedValue(() => {})
    const exchange = Promise.withResolvers<void>()
    vi.spyOn(tauriHelpers, 'handleTauriDeepLink').mockImplementation(async (_url, _base, _scheme, onToken) => {
      await exchange.promise
      await onToken('old-token')
    })
    const client = createAuthClient({ baseUrl })
    await client.startTauriBridge()
    const completion = setupListener.mock.calls[0]![0]('gau://oauth/callback?code=old-code')
    if (action === 'expiration') sessionToken = 'expired-token'
    fetchSpy.mockImplementation(async (url) => String(url).endsWith('/signout')
      ? new Response()
      : sessionToken === 'expired-token'
        ? rejectedSession()
        : makeJsonResponse(sessionToken ? sessionPayload(sessionToken) : { user: null, session: null }))
    if (action === 'refresh' || action === 'expiration') await client.refreshSession()
    else if (action === 'signout') await client.signOut()
    else await client.applySessionToken('newer-token')
    exchange.resolve()
    await completion
    expect(sessionToken).toBe(action === 'refresh' || action === 'expiration' ? 'old-token' : action === 'signout' ? null : 'newer-token')
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
    expect(fetchSpy).toHaveBeenCalledWith(`${baseUrl}/session`, {
      credentials: 'omit',
      headers: { Authorization: 'Bearer redirect-token' },
    })
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
      sessionToken = 'to-refresh'
      const response = new Response('ok')
      fetchSpy.mockResolvedValueOnce(response)

      const client = createAuthClient({ baseUrl })
      await client.fetch('/api/data')

      expect(mockHandleRefreshedToken).toHaveBeenCalledWith(response)
    })

    it('never sends a cookie alongside a bearer token, even when the caller requests include', async () => {
      sessionToken = 'app-token'
      fetchSpy.mockResolvedValueOnce(new Response('ok'))
      await createAuthClient({ baseUrl }).fetch('/api/data', { credentials: 'include' })
      expect(fetchSpy).toHaveBeenCalledWith('/api/data', expect.objectContaining({ credentials: 'omit' }))
    })

    it('ignores refreshed tokens from responses to a previous account', async () => {
      sessionToken = 'old-token'
      const pending = Promise.withResolvers<Response>()
      fetchSpy.mockReturnValueOnce(pending.promise)
      const request = createAuthClient({ baseUrl }).fetch('/api/data')
      sessionToken = 'new-token'
      pending.resolve(new Response('ok'))
      await request
      expect(mockHandleRefreshedToken).not.toHaveBeenCalled()
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

    it('preserves Request headers unless init supplies replacement headers', async () => {
      sessionToken = 'tok'
      fetchSpy.mockResolvedValue(new Response('ok'))
      const client = createAuthClient({ baseUrl })
      const request = new Request('https://example.com/api/data', {
        headers: { 'Content-Type': 'application/json', 'X-Request': 'original' },
      })
      await client.fetch(request)
      const headers = fetchSpy.mock.calls[0][1].headers as Headers
      expect(headers.get('Content-Type')).toBe('application/json')
      expect(headers.get('X-Request')).toBe('original')
      expect(headers.get('Authorization')).toBe('Bearer tok')

      await client.fetch(request, { headers: { 'X-Request': 'replacement' } })
      const replacement = fetchSpy.mock.calls[1][1].headers as Headers
      expect(replacement.get('Content-Type')).toBeNull()
      expect(replacement.get('X-Request')).toBe('replacement')
      expect(replacement.get('Authorization')).toBe('Bearer tok')
    })
  })

  it('keeps client-owned errors and clears them after a successful retry', async () => {
    const client = createAuthClient({ baseUrl })
    const healthy = createAuthClient({ baseUrl })
    const changed = vi.fn()
    const unsubscribe = client.onSessionError(changed)
    fetchSpy.mockResolvedValueOnce(new Response('private backend secret', { status: 500 }))
    await expect(client.refreshSession()).rejects.toBeInstanceOf(AuthClientError)
    expect(client.sessionError).toMatchObject({ code: 'HTTP_ERROR', status: 500 })
    expect(changed).toHaveBeenLastCalledWith(client.sessionError)
    expect(String(client.sessionError)).not.toContain('private backend secret')
    expect(healthy.sessionError).toBeNull()
    fetchSpy.mockResolvedValueOnce(makeJsonResponse(sessionPayload('recovered')))
    await client.refreshSession()
    expect(client.sessionError).toBeNull()
    expect(changed).toHaveBeenLastCalledWith(null)
    unsubscribe()
    fetchSpy.mockResolvedValueOnce(new Response('bad response', { status: 403 }))
    await expect(client.refreshSession()).rejects.toBeInstanceOf(AuthClientError)
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('does not let an older failed refresh replace a newer successful session with an error', async () => {
    const client = createAuthClient({ baseUrl })
    const pending = Promise.withResolvers<Response>()
    fetchSpy.mockReturnValueOnce(pending.promise)
    const oldRefresh = client.refreshSession()
    fetchSpy.mockResolvedValueOnce(makeJsonResponse(sessionPayload('new-account')))
    await client.refreshSession()
    pending.resolve(new Response('private error', { status: 500 }))
    await expect(oldRefresh).rejects.toBeInstanceOf(AuthClientError)
    expect(client.session).toEqual(sessionPayload('new-account'))
    expect(client.sessionError).toBeNull()
  })

  it.each([
    Response.json({ message: 'wrong endpoint' }),
    new Response('{invalid', { headers: { 'Content-Type': 'application/json' } }),
  ])('rejects unsuccessful or invalid JSON session responses', async (response) => {
    fetchSpy.mockResolvedValueOnce(response)
    await expect(createAuthClient({ baseUrl }).refreshSession()).rejects.toBeInstanceOf(AuthClientError)
  })

  it('reports safe network diagnostics without causes or URL secrets', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('private bearer token'))
    const client = createAuthClient({ baseUrl: 'https://private:password@api.test/auth?secret=private' })
    await expect(client.refreshSession()).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      endpoint: 'https://api.test/auth',
    })
    expect(String(client.sessionError)).not.toContain('private')
    expect(String(client.sessionError)).not.toContain('password')
  })

  it('uses configured bearer-only credentials before login and after signout', async () => {
    const guest = { user: null, session: null, accounts: null, providers: ['github'] }
    fetchSpy.mockResolvedValueOnce(makeJsonResponse(guest))
    const client = createAuthClient({ baseUrl, credentials: 'omit' })
    await client.refreshSession()
    expect(fetchSpy).toHaveBeenLastCalledWith(`${baseUrl}/session`, { credentials: 'omit' })
    sessionToken = 'app-token'
    fetchSpy.mockResolvedValueOnce(new Response()).mockResolvedValueOnce(makeJsonResponse(guest))
    await client.signOut()
    expect(fetchSpy).toHaveBeenNthCalledWith(2, `${baseUrl}/signout`, {
      method: 'POST',
      credentials: 'omit',
      headers: { Authorization: 'Bearer app-token' },
    })
    expect(fetchSpy).toHaveBeenLastCalledWith(`${baseUrl}/session`, { credentials: 'omit' })
    expect(client.session).toEqual(guest)
  })

  it('invalidates pending bearer refreshes immediately on signout, even when the backend is offline', async () => {
    sessionToken = 'app-token'
    const client = createAuthClient({ baseUrl, session: sessionPayload('old-account'), credentials: 'omit' })
    const pending = Promise.withResolvers<Response>()
    fetchSpy.mockReturnValueOnce(pending.promise)
    const oldRefresh = client.refreshSession()
    fetchSpy.mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('offline'))
    await expect(client.signOut()).rejects.toBeInstanceOf(AuthClientError)
    expect(client.session.user).toBeNull()
    expect(sessionToken).toBeNull()
    pending.resolve(makeJsonResponse(sessionPayload('old-account')))
    await oldRefresh
    expect(client.session.user).toBeNull()
  })

  it('does not refresh an old signout over a newly applied session', async () => {
    sessionToken = 'old-token'
    const client = createAuthClient({ baseUrl, credentials: 'omit' })
    const pending = Promise.withResolvers<Response>()
    fetchSpy.mockReturnValueOnce(pending.promise)
    const signingOut = client.signOut()
    fetchSpy.mockResolvedValueOnce(makeJsonResponse(sessionPayload('new-account')))
    await client.applySessionToken('new-token')
    pending.resolve(new Response())
    await signingOut
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(client.session).toEqual(sessionPayload('new-account'))
    expect(sessionToken).toBe('new-token')
  })
})
