import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test'
import { AuthClientError, createAuthClient, getSessionToken, storeSessionToken } from '../../src/client/vanilla'
import { createHandler } from '../../src/core/handler'
import { setup } from '../handler'

vi.mock('esm-env', () => ({ BROWSER: true, DEV: false }))

const baseUrl = 'https://auth.test/api/auth'
const guest = { user: null, session: null, accounts: null, providers: ['github'] }
const account = { ...guest, user: { id: 'app-user' }, session: { sub: 'app-user' }, accounts: [] }
let proofs: Map<string, string>
let requests: Request[]
let replaceState: ReturnType<typeof vi.fn>

function storage(values: Map<string, string>) {
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  }
}

beforeEach(() => {
  proofs = new Map()
  requests = []
  const sessionStorage = storage(proofs)
  replaceState = vi.fn()
  vi.stubGlobal('localStorage', storage(new Map()))
  vi.stubGlobal('sessionStorage', sessionStorage)
  vi.stubGlobal('window', {
    location: new URL('https://app.test/'),
    crypto: globalThis.crypto,
    sessionStorage,
    history: { replaceState },
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      requests.push(request)
      if (request.url.endsWith('/token')) return Response.json({ token: 'app-token' })
      if (request.url.endsWith('/session'))
        return Response.json(request.headers.get('Authorization') === 'Bearer app-token' ? account : guest)
      return new Response()
    }),
  )
})

afterEach(() => vi.unstubAllGlobals())

function useBackend(requiresNonce: boolean) {
  const { auth, mockProvider } = setup()
  auth.trustHosts = ['app.test']
  auth.providerMap.set('mock', { ...mockProvider, requiresNonce })
  mockProvider.getAuthorizationUrl.mockImplementation(async (state) =>
    new URL(`https://provider.test/auth?state=${encodeURIComponent(state)}`))
  const handler = createHandler(auth)
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const request = new Request(input, init)
    request.headers.set('Origin', window.location.origin)
    requests.push(request)
    // Fetch deliberately does not save cookies; bearer requests use credentials: omit.
    return handler(request)
  })
  return { auth, handler }
}

async function completeNavigation(handler: ReturnType<typeof createHandler>, url: string) {
  const start = await handler(new Request(url))
  expect(start.status).toBe(302)
  const state = new URL(start.headers.get('Location')!).searchParams.get('state')!
  const callback = new URL('/api/auth/callback/mock', url)
  callback.searchParams.set('code', 'provider-code')
  callback.searchParams.set('state', state)
  const response = await handler(new Request(callback, {
    headers: { Cookie: start.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ') },
  }))
  expect(response.status).toBe(200)
  const destination = JSON.parse((await response.text()).match(/const url = (".*");/)![1]!)
  Object.assign(window, { location: new URL(destination) })
}

it.each([
  ['https://app.test/api/auth', false],
  ['https://app.test/api/auth', true],
  [baseUrl, false],
  [baseUrl, true],
] as const)('completes bearer-only login at %s (OIDC: %s) through the real handlers', async (baseUrl, oidc) => {
  const { handler } = useBackend(oidc)
  const client = createAuthClient({ baseUrl, credentials: 'omit' })
  await completeNavigation(handler, await client.signIn('mock', { redirectTo: 'https://app.test/?from=login#section' }))
  const reloaded = createAuthClient({ baseUrl, credentials: 'omit' })
  expect(await reloaded.handleRedirectCallback()).toBe(true)
  expect(reloaded.session.user?.name).toBe('Provider User')
  expect(reloaded.sessionLoaded).toBe(true)
  expect(getSessionToken()).toBeTruthy()
  expect(requests.every(request => request.credentials === 'omit')).toBe(true)
  expect(replaceState).toHaveBeenCalledWith(null, '', '/?from=login#section')
  expect(proofs.size).toBe(0)
})

it.each([false, true])('links a bearer account without fetch cookies (OIDC: %s)', async (oidc) => {
  const { auth, handler } = useBackend(oidc)
  const user = await auth.createUser({ name: 'Existing account' })
  const token = await auth.createSession(user.id)
  storeSessionToken(token)
  const client = createAuthClient({ baseUrl })
  const url = await client.linkAccount('mock', { redirectTo: 'https://app.test/settings' })
  expect(new URL(url).origin).toBe('https://auth.test')
  expect(url).not.toContain(token)
  expect(requests[0]!.credentials).toBe('omit')
  await completeNavigation(handler, url)
  expect(await createAuthClient({ baseUrl }).handleRedirectCallback()).toBe(true)
  expect((await auth.getUserByAccount('mock', 'provider-user-id'))?.id).toBe(user.id)
  expect((await handler(new Request(url))).status).toBe(401)
})

it.each(['missing', 'expired', 'malformed'])(
  'rejects %s proof without a token exchange and recovers on refresh',
  async (kind) => {
    const client = createAuthClient({ baseUrl, credentials: 'omit' })
    if (kind !== 'missing') {
      await client.signIn('github')
      const key = `gau:oauth:${baseUrl}`
      const proof = JSON.parse(proofs.get(key)!)
      proofs.set(
        key,
        kind === 'malformed' ? '{invalid' : JSON.stringify({ ...proof, createdAt: Date.now() - 11 * 60 * 1000 }),
      )
    }
    Object.assign(window, { location: new URL('https://app.test/?code=unexpected-code') })
    await expect(client.handleRedirectCallback()).rejects.toMatchObject({ code: 'INVALID_PROOF' })
    expect(client.sessionError).toBeInstanceOf(AuthClientError)
    expect(proofs.size).toBe(0)
    expect(requests).toHaveLength(0)
    expect(replaceState).toHaveBeenCalledWith(null, '', '/')
    await client.refreshSession()
    expect(client.sessionError).toBeNull()
  },
)

it.each(['refresh', 'signout', 'account change'])('handles a pending OAuth exchange during %s', async (action) => {
  const client = createAuthClient({ baseUrl, credentials: 'omit' })
  await client.signIn('github')
  Object.assign(window, { location: new URL('https://app.test/?code=old-code') })
  const pending = Promise.withResolvers<Response>()
  vi.mocked(fetch).mockImplementationOnce(() => pending.promise)
  const callback = client.handleRedirectCallback()
  if (action === 'refresh') await client.refreshSession()
  else if (action === 'signout') await client.signOut()
  else await client.applySessionToken('newer-token')
  pending.resolve(Response.json({ token: 'app-token' }))
  expect(await callback).toBe(action === 'refresh')
  expect(getSessionToken()).toBe(action === 'refresh' ? 'app-token' : action === 'signout' ? null : 'newer-token')
})

it('rejects empty token responses instead of storing them', async () => {
  const client = createAuthClient({ baseUrl, credentials: 'omit' })
  await client.signIn('github')
  Object.assign(window, { location: new URL('https://app.test/?code=code') })
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ token: '' }))
  await expect(client.handleRedirectCallback()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  expect(getSessionToken()).toBeNull()
})
