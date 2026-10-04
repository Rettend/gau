import type { Auth } from '../../../src/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { MemoryAdapter } from '../../../src/adapters'
import { createAuth, createHandler, OAUTH_TRANSACTION_COOKIE_NAME, SESSION_COOKIE_NAME } from '../../../src/core'
import { ChatGPT } from '../../../src/oauth'
import { clientId, oidcFixture } from '../../oauth/oidc.fixture'

describe('ChatGPT web callback', () => {
  let auth: Auth
  let fixture: Awaited<ReturnType<typeof oidcFixture>>
  let handler: ReturnType<typeof createHandler>
  beforeEach(async () => {
    fixture = await oidcFixture()
    vi.stubGlobal('fetch', fixture.fetch)
    auth = createAuth({
      adapter: MemoryAdapter(),
      providers: [ChatGPT({ clientId })],
      jwt: { algorithm: 'HS256', secret: 'test-secret' },
    })
    handler = createHandler(auth)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  async function start(path = '/api/auth/chatgpt?redirectTo=/dashboard', session?: string) {
    const response = await handler(
      new Request(`https://app.example${path}`, {
        headers: session ? { Cookie: `${SESSION_COOKIE_NAME}=${session}` } : undefined,
      }),
    )
    expect(response.status).toBe(302)
    const url = new URL(response.headers.get('location')!)
    const cookie = response.headers
      .getSetCookie()
      .find((value) => value.startsWith(`${OAUTH_TRANSACTION_COOKIE_NAME}=`))!
    const binding = cookie.split(';')[0]!
    const secret = decodeURIComponent(binding.slice(binding.indexOf('=') + 1))
    fixture.setTokens({ id_token: await fixture.signIdentity({ nonce: url.searchParams.get('nonce')! }) })
    return { url, cookie, binding, secret }
  }
  const callback = (state: string, cookie: string, suffix = '&code=code') =>
    handler(
      new Request(`https://app.example/api/auth/callback/chatgpt?state=${encodeURIComponent(state)}${suffix}`, {
        headers: { Cookie: cookie },
      }),
    )
  const tokenRequests = () => fixture.fetch.mock.calls.filter(([url]) => url === fixture.metadata.token_endpoint)
  const expectCleared = (response: Response) =>
    expect(
      response.headers
        .getSetCookie()
        .some((value) => value.startsWith(`${OAUTH_TRANSACTION_COOKIE_NAME}=`) && value.includes('Max-Age=0')),
    ).toBe(true)

  it('stores secrets server-side, verifies identity-only responses, and issues a normal app session', async () => {
    const transaction = await start()
    expect(transaction.cookie).toContain('HttpOnly')
    expect(transaction.cookie).toContain('Secure')
    expect(transaction.cookie).toContain('SameSite=Lax')
    expect(transaction.cookie).toContain('Max-Age=600')
    const stored = await auth.verification!.get(`oauth:${transaction.secret}`)
    const data = JSON.parse(stored!.value)
    expect(data.nonce).toBe(transaction.url.searchParams.get('nonce'))
    expect(data.codeVerifier).toBeTruthy()
    const response = await callback(
      transaction.url.searchParams.get('state')!,
      transaction.binding,
      '&code=code&redirect=false',
    )
    expect(response.status).toBe(200)
    expectCleared(response)
    const user = await auth.getUserByEmail('person@example.com')
    const account = (await auth.getAccounts(user!.id))[0]!
    expect(account.provider).toBe('chatgpt')
    expect(account.providerAccountId).toMatch(/^[a-f0-9]{64}$/)
    for (const field of ['accessToken', 'refreshToken', 'idToken'])
      expect(account[field as keyof typeof account]).toBeNull()
    expect(await auth.getAccessToken(user!.id, 'chatgpt')).toBeNull()
    const sessionCookie = response.headers.getSetCookie().find((value) => value.startsWith(`${SESSION_COOKIE_NAME}=`))!
    expect(sessionCookie).toContain('SameSite=Lax')
    expect(
      (
        await auth.validateSession(
          decodeURIComponent(sessionCookie.split(';')[0]!.slice(SESSION_COOKIE_NAME.length + 1)),
        )
      )?.user?.id,
    ).toBe(user!.id)
    const tokenRequest = tokenRequests()[0]![1]!.body as URLSearchParams
    expect(tokenRequest.get('code_verifier')).toBe(data.codeVerifier)
    expect(tokenRequest.get('redirect_uri')).toBe('https://app.example/api/auth/callback/chatgpt')
    expect((await auth.verification!.get(`oauth:${transaction.secret}`))?.value).toBe('{"used":true}')
    expect(JSON.stringify(await response.json())).not.toContain('id_token')
  })

  it('rejects replay and concurrent redemption before another code exchange', async () => {
    const transaction = await start()
    const state = transaction.url.searchParams.get('state')!
    const responses = await Promise.all([callback(state, transaction.binding), callback(state, transaction.binding)])
    expect(responses.map((response) => response.status).sort()).toEqual([302, 403])
    expect((await callback(state, transaction.binding)).status).toBe(403)
    expect(tokenRequests()).toHaveLength(1)
    responses.forEach(expectCleared)
  })

  it('rejects missing and expired transactions', async () => {
    expect((await callback('state', '')).status).toBe(403)
    const transaction = await start()
    const record = (await auth.verification!.get(`oauth:${transaction.secret}`))!
    await auth.verification!.set({ ...record, expiresAt: Date.now() - 1, version: record.version + 1 }, record.version)
    const response = await callback(transaction.url.searchParams.get('state')!, transaction.binding)
    expect(response.status).toBe(403)
    expectCleared(response)
    expect(tokenRequests()).toHaveLength(0)
  })

  it('consumes mismatched state and prevents state redirect tampering', async () => {
    const transaction = await start()
    const state = transaction.url.searchParams.get('state')!
    const response = await callback(`${state}.attacker`, transaction.binding)
    expect(response.status).toBe(403)
    expectCleared(response)
    expect((await callback(state, transaction.binding)).status).toBe(403)
    expect(tokenRequests()).toHaveLength(0)
  })

  it.each(['&error=access_denied', '', '&code='])(
    'consumes cancelled or missing-code callbacks (%s)',
    async (suffix) => {
      const transaction = await start()
      const state = transaction.url.searchParams.get('state')!
      const response = await callback(state, transaction.binding, suffix)
      expect(response.status).toBe(200)
      expectCleared(response)
      expect((await callback(state, transaction.binding)).status).toBe(403)
      expect(tokenRequests()).toHaveLength(0)
    },
  )

  it('clears state after failed verification and does not create an account', async () => {
    const transaction = await start()
    fixture.setTokens({ id_token: await fixture.signIdentity({ nonce: 'wrong' }) })
    const response = await callback(transaction.url.searchParams.get('state')!, transaction.binding)
    expect(response.status).toBe(400)
    expectCleared(response)
    expect(await auth.getUserByEmail('person@example.com')).toBeNull()
    expect((await callback(transaction.url.searchParams.get('state')!, transaction.binding)).status).toBe(403)
  })

  it('clears state on exchange failure without exposing credentials', async () => {
    const transaction = await start()
    fixture.setTokens({ error_description: 'secret-value' }, 401)
    const response = await callback(transaction.url.searchParams.get('state')!, transaction.binding)
    expect(response.status).toBe(400)
    expectCleared(response)
    expect(await response.text()).not.toContain('secret-value')
    expect((await callback(transaction.url.searchParams.get('state')!, transaction.binding)).status).toBe(403)
  })

  it.each(['verifiedEmail', 'always', false] as const)(
    'never auto-links by email when autoLink=%s',
    async (autoLink) => {
      auth.autoLink = autoLink
      const existing = await auth.createUser({ email: 'person@example.com', emailVerified: true })
      const transaction = await start()
      const response = await callback(transaction.url.searchParams.get('state')!, transaction.binding)
      expect(response.status).toBe(409)
      expect(await auth.getAccounts(existing.id)).toEqual([])
      expectCleared(response)
    },
  )

  it('links explicitly to the authenticated account and then signs in by subject', async () => {
    const existing = await auth.createUser({ email: 'person@example.com', emailVerified: true })
    const session = await auth.createSession(existing.id)
    const transaction = await start('/api/auth/link/chatgpt?redirectTo=/dashboard', session)
    const response = await callback(transaction.url.searchParams.get('state')!, transaction.binding)
    expect(response.status).toBe(302)
    expect((await auth.getAccounts(existing.id))[0]?.provider).toBe('chatgpt')
    const next = await start()
    fixture.setTokens({
      id_token: await fixture.signIdentity({
        nonce: next.url.searchParams.get('nonce')!,
        email: 'changed@example.com',
      }),
    })
    const signIn = await callback(next.url.searchParams.get('state')!, next.binding)
    expect(signIn.status).toBe(302)
    expect(await auth.getAccounts(existing.id)).toHaveLength(1)
  })

  it('ignores forged legacy cookies that try to change the transaction or link target', async () => {
    const victim = await auth.createUser({ email: 'victim@example.com' })
    const session = await auth.createSession(victim.id)
    const transaction = await start()
    const forged = `${transaction.binding}; __gau-linking-token=${session}; __gau-pkce-code-verifier=forged; __gau-callback-uri=https://attacker.example`
    const response = await callback(transaction.url.searchParams.get('state')!, forged)
    expect(response.status).toBe(302)
    expect(await auth.getAccounts(victim.id)).toEqual([])
    expect((tokenRequests()[0]![1]!.body as URLSearchParams).get('redirect_uri')).toBe(
      'https://app.example/api/auth/callback/chatgpt',
    )
  })

  it('cannot link an identity already owned by another user', async () => {
    const first = await start()
    expect((await callback(first.url.searchParams.get('state')!, first.binding)).status).toBe(302)
    const other = await auth.createUser({ email: 'other@example.com' })
    const link = await start('/api/auth/link/chatgpt', await auth.createSession(other.id))
    const response = await callback(link.url.searchParams.get('state')!, link.binding)
    expect(response.status).toBe(409)
    expect(await auth.getAccounts(other.id)).toEqual([])
    expectCleared(response)
  })

  it('clears state when the application handles the exchange with a custom response', async () => {
    auth.onOAuthExchange = async ({ tokens }) => {
      expect(tokens.data).toEqual({})
      return { handled: true, response: new Response('custom response') }
    }
    const transaction = await start()
    const response = await callback(transaction.url.searchParams.get('state')!, transaction.binding)
    expect(await response.text()).toBe('custom response')
    expectCleared(response)
    expect(await auth.getUserByEmail('person@example.com')).toBeNull()
  })

  it('requires verification storage at createAuth time', () => {
    const { verification: _, ...adapter } = MemoryAdapter()
    expect(() => createAuth({ adapter, providers: [ChatGPT({ clientId })] })).toThrow('atomic verification storage')
  })
})
