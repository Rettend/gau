import { afterEach, expect, it, vi } from 'vite-plus/test'
import * as token from '../../src/client/token'
import { createAuthClient } from '../../src/client/vanilla'
import * as tauriHelpers from '../../src/runtimes/tauri/index'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('seeds a client without a request and shares server updates with subscribers', () => {
  const session = { user: { id: 'alice' }, session: { sub: 'alice' } }
  const client = createAuthClient({ baseUrl: '/api/auth', session })
  expect(client.sessionLoaded).toBe(true)
  expect(client.session).toBe(session)
  const listener = vi.fn()
  const stop = client.onSessionChange(listener)
  const next = { user: null, session: null }
  client.setSession(next)
  expect(listener).toHaveBeenCalledWith(next)
  stop()
  client.setSession(session)
  expect(listener).toHaveBeenCalledTimes(1)
})

it('does not overwrite a new server session with an older in-flight response', async () => {
  let resolve!: (response: Response) => void
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done
        }),
    ),
  )
  const client = createAuthClient({ baseUrl: '/api/auth' })
  const pending = client.refreshSession()
  const next = { user: { id: 'bob' }, session: { sub: 'bob' } }
  client.setSession(next)
  resolve(Response.json({ user: { id: 'alice' }, session: { sub: 'alice' } }))
  expect(await pending).toBe(next)
  expect(client.session).toBe(next)
})

it('applies a Tauri deep-link exchange that finishes after an expired refresh', async () => {
  const baseUrl = 'https://auth.test/api/auth'
  const expiredToken = 'expired-token'
  const freshToken = 'fresh-token'
  const hydrated = {
    user: { id: 'hydrated' },
    session: { sub: 'hydrated' },
    accounts: [],
    providers: ['github'],
  }
  const guest = { user: null, session: null, accounts: null, providers: ['github'] }
  const fresh = { user: { id: 'fresh' }, session: { sub: 'fresh' }, accounts: [], providers: ['github'] }
  let sessionToken: string | null = expiredToken
  vi.spyOn(token, 'getSessionToken').mockImplementation(() => sessionToken)
  vi.spyOn(token, 'storeSessionToken').mockImplementation((value) => {
    sessionToken = value
  })
  vi.spyOn(token, 'clearSessionToken').mockImplementation(() => {
    sessionToken = null
  })

  const pendingExchange = Promise.withResolvers<Response>()
  const requests: Request[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      requests.push(request)
      if (request.url.endsWith('/token')) return pendingExchange.promise
      const authorization = request.headers.get('Authorization')
      if (authorization === `Bearer ${expiredToken}`) return Response.json(guest, { status: 401 })
      if (authorization === `Bearer ${freshToken}`) return Response.json(fresh)
      return new Response(null, { status: 500 })
    }),
  )

  const storage = new Map([['gau-pkce-verifier', 'verifier']])
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  })
  vi.spyOn(tauriHelpers, 'isTauri').mockReturnValue(true)
  let listener!: (url: string) => Promise<void>
  vi.spyOn(tauriHelpers, 'setupTauriListener').mockImplementation(async (handler) => {
    listener = handler
    return () => {}
  })

  const client = createAuthClient({ baseUrl, session: hydrated, credentials: 'omit' })
  const changes = vi.fn()
  client.onSessionChange(changes)
  await client.startTauriBridge()
  const exchange = listener('gau://oauth/callback?code=fresh-code')
  await vi.waitFor(() => expect(requests).toHaveLength(1))
  expect(requests[0]!.url).toBe(`${baseUrl}/token`)

  expect(await client.refreshSession()).toEqual(guest)
  expect(sessionToken).toBeNull()
  expect(client.session).toEqual(guest)

  pendingExchange.resolve(Response.json({ token: freshToken }))
  await exchange

  expect(sessionToken).toBe(freshToken)
  expect(client.session).toEqual(fresh)
  expect(client.sessionError).toBeNull()
  expect(requests).toHaveLength(3)
  expect(requests[1]!.headers.get('Authorization')).toBe(`Bearer ${expiredToken}`)
  expect(requests[2]!.headers.get('Authorization')).toBe(`Bearer ${freshToken}`)
  expect(changes).toHaveBeenCalledTimes(2)
  expect(changes).toHaveBeenLastCalledWith(fresh)
  expect(storage.has('gau-pkce-verifier')).toBe(false)
})
