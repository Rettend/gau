import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test'
import { AuthClientError, createAuthClient, getSessionToken } from '../../src/client/vanilla'

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

it('uses browser PKCE for bearer-only sign-in and verifies the exchanged token after reload', async () => {
  const client = createAuthClient({ baseUrl, credentials: 'omit' })
  expect(client.sessionLoaded).toBe(false)
  const authorization = new URL(await client.signIn('github', { profile: 'work' }))
  const proof = JSON.parse(proofs.get(`gau:oauth:${baseUrl}`)!)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(proof.verifier))
  expect(authorization.searchParams.get('code_challenge')).toBe(Buffer.from(digest).toString('base64url'))
  expect(authorization.searchParams.get('redirectTo')).toBe('https://app.test')
  expect(authorization.searchParams.get('profile')).toBe('work')
  Object.assign(window, { location: new URL('https://app.test/?from=login&code=one-time-code#section') })
  const reloaded = createAuthClient({ baseUrl, credentials: 'omit' })
  expect(await reloaded.handleRedirectCallback()).toBe(true)
  expect(replaceState).toHaveBeenCalledWith(null, '', '/?from=login#section')
  expect(await requests[0]!.json()).toEqual({ code: 'one-time-code', codeVerifier: proof.verifier })
  expect(requests[0]!.credentials).toBe('omit')
  expect(requests[1]!.headers.get('Authorization')).toBe('Bearer app-token')
  expect(requests[1]!.credentials).toBe('omit')
  expect(reloaded.session).toEqual(account)
  expect(reloaded.sessionLoaded).toBe(true)
  expect(getSessionToken()).toBe('app-token')
  expect(proofs.size).toBe(0)
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

it('does not apply a pending OAuth exchange after signout', async () => {
  const client = createAuthClient({ baseUrl, credentials: 'omit' })
  await client.signIn('github')
  Object.assign(window, { location: new URL('https://app.test/?code=old-code') })
  const pending = Promise.withResolvers<Response>()
  vi.mocked(fetch).mockImplementationOnce(() => pending.promise)
  const callback = client.handleRedirectCallback()
  await client.signOut()
  pending.resolve(Response.json({ token: 'app-token' }))
  expect(await callback).toBe(false)
  expect(client.session.user).toBeNull()
  expect(getSessionToken()).toBeNull()
})

it('rejects empty token responses instead of storing them', async () => {
  const client = createAuthClient({ baseUrl, credentials: 'omit' })
  await client.signIn('github')
  Object.assign(window, { location: new URL('https://app.test/?code=code') })
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ token: '' }))
  await expect(client.handleRedirectCallback()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  expect(getSessionToken()).toBeNull()
})
