import type { EmailConfig, EmailTemplateContext } from '../../../src/email'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { MemoryAdapter } from '../../../src/adapters/memory'
import { createAuth, createHandler } from '../../../src/core'
import { Email, renderEmail } from '../../../src/email'
import { sha256 } from '../../../src/email/crypto'

function setup(config: Partial<EmailConfig> = {}, autoLink: false | 'verifiedEmail' = 'verifiedEmail') {
  const messages: EmailTemplateContext[] = []
  const send = vi.fn(async () => {})
  const adapter = MemoryAdapter()
  const auth = createAuth({
    adapter,
    autoLink,
    providers: [
      Email({
        from: 'app@example.com',
        send,
        render: (context) => {
          messages.push(context)
          return renderEmail(context)
        },
        ...config,
      }),
    ],
    jwt: { algorithm: 'HS256', secret: 'test-secret' },
  })
  const handler = createHandler(auth)
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    handler(
      new Request(`https://app.example.com/api/auth/${path}`, {
        method: 'POST',
        headers: { Origin: 'https://app.example.com', 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
    )
  const start = async (
    email = 'person@example.com',
    path = 'email',
    headers: Record<string, string> = {},
    extra = {},
  ) => {
    const response = await post(path, { email, clientChallenge: await sha256('client-proof'), ...extra }, headers)
    const result = await response.json()
    return { response, ...result, code: messages.at(-1)?.code, url: messages.at(-1)?.url }
  }
  const verify = (challenge: { challengeId: string; code: string }, path = 'email', headers = {}) =>
    post(
      path,
      {
        challengeId: challenge.challengeId,
        code: challenge.code,
        verifier: 'client-proof',
      },
      headers,
    )
  return { auth, adapter, handler, send, messages, post, start, verify }
}

afterEach(() => vi.restoreAllMocks())

describe('email authentication', () => {
  it('requires storage and a secret only when email is configured', () => {
    const adapter = MemoryAdapter()
    delete adapter.verification
    expect(() =>
      createAuth({
        adapter,
        providers: [Email({ from: 'app@example.com', send: async () => {} })],
        jwt: { secret: 'x' },
      }),
    ).toThrow('verification storage')
    expect(() => createAuth({ adapter, providers: [] })).not.toThrow()
  })

  it('sends a code without creating a user, then issues a normal session', async () => {
    const s = setup()
    const challenge = await s.start(' Person@Example.com ')
    expect(challenge.response.status).toBe(200)
    expect(challenge.status).toBe('verification-required')
    expect(await s.auth.getUserByEmail('person@example.com')).toBeNull()
    const stored = await s.adapter.verification!.get(challenge.challengeId)
    expect(stored!.value).not.toContain(challenge.code)
    expect(stored!.value).not.toContain('client-proof')
    const response = await s.verify(challenge)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'authenticated' })
    expect(response.headers.get('set-cookie')).toContain('__gau-session-token=')
    const user = await s.auth.getUserByEmail('person@example.com')
    expect(user?.emailVerified).toBe(true)
    expect(await s.auth.getAccounts(user!.id)).toMatchObject([{ provider: 'email', type: 'email' }])
  })

  it('allows only one concurrent redemption', async () => {
    const s = setup()
    const challenge = await s.start()
    const results = await Promise.all(Array.from({ length: 8 }, () => s.verify(challenge)))
    expect(results.filter((r) => r.status === 200)).toHaveLength(1)
    expect((await s.verify(challenge)).status).toBe(400)
  })

  it('enforces the attempt limit under concurrent wrong guesses', async () => {
    const s = setup({ maxAttempts: 3 })
    const challenge = await s.start()
    const wrong = challenge.code === '000000' ? '111111' : '000000'
    await Promise.all(Array.from({ length: 6 }, () => s.verify({ ...challenge, code: wrong })))
    expect((await s.verify(challenge)).status).toBe(400)
    expect(JSON.parse((await s.adapter.verification!.get(challenge.challengeId))!.value).attempts).toBe(3)
  })

  it('rejects expired codes and codes from another challenge', async () => {
    const s = setup()
    const challenge = await s.start()
    expect(
      (await s.post('email', { challengeId: challenge.challengeId, code: challenge.code, verifier: 'another-browser' }))
        .status,
    ).toBe(400)
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 601000)
    expect((await s.verify(challenge)).status).toBe(400)
  })

  it('shares sending limits across auth instances and concurrent requests', async () => {
    const s = setup()
    const results = await Promise.all(Array.from({ length: 8 }, () => s.start()))
    expect(results.filter((r) => r.response.status === 200)).toHaveLength(1)
    expect(s.send).toHaveBeenCalledTimes(1)
    const second = createAuth({
      adapter: s.adapter,
      providers: s.auth.providerMap.values().toArray(),
      jwt: { algorithm: 'HS256', secret: 'test-secret' },
    })
    const response = await createHandler(second)(
      new Request('https://app.example.com/api/auth/email', {
        method: 'POST',
        headers: { Origin: 'https://app.example.com', 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'person@example.com', clientChallenge: await sha256('proof') }),
      }),
    )
    expect(response.status).toBe(429)
  })

  it('limits sends per trusted client address', async () => {
    const s = setup({ rateLimit: { perIp: 1, getClientAddress: () => '192.0.2.1' } })
    expect((await s.start('one@example.com')).response.status).toBe(200)
    expect((await s.start('two@example.com')).response.status).toBe(429)
  })

  it('rejects cross-origin requests and unsafe redirects before sending', async () => {
    const s = setup()
    const body = { email: 'person@example.com', clientChallenge: await sha256('proof') }
    expect((await s.post('email', body, { Origin: 'https://evil.example' })).status).toBe(403)
    for (const redirectTo of ['https://evil.example', '//evil.example', 'javascript:alert(1)'])
      expect((await s.post('email', { ...body, redirectTo })).status).toBe(400)
    expect(s.send).not.toHaveBeenCalled()
  })

  it('uses the existing account with verified-email linking', async () => {
    const s = setup()
    const user = await s.auth.createUser({ email: 'person@example.com' })
    await s.auth.linkAccount({ userId: user.id, provider: 'google', providerAccountId: 'google-id' })
    expect((await s.verify(await s.start())).status).toBe(200)
    expect((await s.auth.getUserByAccount('email', 'person@example.com'))?.id).toBe(user.id)
  })

  it('does not bypass autoLink false', async () => {
    const s = setup({}, false)
    await s.auth.createUser({ email: 'person@example.com' })
    const response = await s.verify(await s.start())
    expect(response.status).toBe(409)
    expect(await s.auth.getUserByAccount('email', 'person@example.com')).toBeNull()
  })

  it('binds linking to the original user and purpose, without replacing their session', async () => {
    const s = setup({}, false)
    const user = await s.auth.createUser({ email: 'person@example.com' })
    const other = await s.auth.createUser({ email: 'other@example.com' })
    const headers = { Authorization: `Bearer ${await s.auth.createSession(user.id)}` }
    const challenge = await s.start('person@example.com', 'link/email', headers)
    expect((await s.verify(challenge, 'email', headers)).status).toBe(400)
    expect(
      (await s.verify(challenge, 'link/email', { Authorization: `Bearer ${await s.auth.createSession(other.id)}` }))
        .status,
    ).toBe(401)
    const response = await s.verify(challenge, 'link/email', headers)
    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toBeNull()
    expect((await s.auth.getUserByAccount('email', 'person@example.com'))?.id).toBe(user.id)
  })

  it('refuses to link an email owned by another user', async () => {
    const s = setup()
    await s.auth.createUser({ email: 'person@example.com' })
    const user = await s.auth.createUser({ email: 'other@example.com' })
    const headers = { Authorization: `Bearer ${await s.auth.createSession(user.id)}` }
    expect(
      (await s.verify(await s.start('person@example.com', 'link/email', headers), 'link/email', headers)).status,
    ).toBe(409)
  })

  it('does not consume magic links on GET, and requires the original browser on POST', async () => {
    const s = setup({ mode: 'both' })
    const challenge = await s.start()
    const cookie = challenge.response.headers.getSetCookie()[0].split(';')[0]
    const preview = await s.handler(new Request(challenge.url, { headers: { Cookie: cookie } }))
    expect(preview.status).toBe(200)
    expect(await preview.text()).toContain('method="post"')
    expect(preview.headers.get('Referrer-Policy')).toBe('no-referrer')
    const params = Object.fromEntries(new URL(challenge.url).searchParams)
    expect((await s.post('callback/email', params)).status).toBe(400)
    const response = await s.post('callback/email', params, { Cookie: cookie })
    expect(response.status).toBe(303)
    expect(response.headers.get('Location')).toBe('/')
    expect((await s.verify(challenge)).status).toBe(400)
  })

  it('invalidates the link when the code is redeemed', async () => {
    const s = setup({ mode: 'both' })
    const challenge = await s.start()
    const cookie = challenge.response.headers.getSetCookie()[0].split(';')[0]
    expect((await s.verify(challenge)).status).toBe(200)
    expect(
      (await s.post('callback/email', Object.fromEntries(new URL(challenge.url).searchParams), { Cookie: cookie }))
        .status,
    ).toBe(400)
  })

  it('returns a token only after proof-bound code verification in token sessions', async () => {
    const s = setup({ mode: 'both' })
    const challenge = await s.start('person@example.com', 'email', {}, { session: 'token' })
    expect(challenge.url).toBeUndefined()
    const response = await s.verify(challenge)
    const result = await response.json()
    expect(result.token).toBeTypeOf('string')
    expect(response.headers.get('set-cookie')).toBeNull()
    expect((await s.auth.validateSession(result.token))?.user?.email).toBe('person@example.com')
  })

  it('invalidates a challenge when delivery fails without exposing the service error', async () => {
    const s = setup({
      send: async () => {
        throw new Error('secret-service-response')
      },
    })
    const challenge = await s.start()
    expect(challenge.response.status).toBe(502)
    expect(challenge.error).not.toContain('secret-service-response')
  })
})
