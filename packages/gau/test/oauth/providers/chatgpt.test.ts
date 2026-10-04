import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { ChatGPT } from '../../../src/oauth'
import { clientId, oidcFixture, redirectUri } from '../oidc.fixture'

describe('ChatGPT web provider', () => {
  let fixture: Awaited<ReturnType<typeof oidcFixture>>
  beforeEach(async () => {
    fixture = await oidcFixture()
    vi.stubGlobal('fetch', fixture.fetch)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('protects authorization parameters while allowing harmless provider options', async () => {
    const protectedKeys = [
      'client_id',
      'client_secret',
      'redirect_uri',
      'response_type',
      'response_mode',
      'scope',
      'state',
      'nonce',
      'code_challenge',
      'code_challenge_method',
      'request',
      'request_uri',
    ]
    const params = Object.fromEntries(protectedKeys.map((key) => [key, 'attacker']))
    const provider = ChatGPT({ clientId, redirectUri, params: { ...params, prompt: 'login' } })
    const url = await provider.getAuthorizationUrl('state', 'verifier', {
      nonce: 'nonce',
      params: { ...params, login_hint: 'person@example.com' },
      redirectUri: 'https://attacker.example',
    })
    expect(url.origin).toBe('https://auth.openai.com')
    expect(url.searchParams.get('client_id')).toBe(clientId)
    expect(url.searchParams.get('redirect_uri')).toBe(redirectUri)
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('response_mode')).toBe('query')
    expect(url.searchParams.get('scope')).toBe('openid profile email')
    expect(url.searchParams.get('state')).toBe('state')
    expect(url.searchParams.get('nonce')).toBe('nonce')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    for (const key of ['client_secret', 'request', 'request_uri']) expect(url.searchParams.has(key)).toBe(false)
    expect(url.searchParams.get('prompt')).toBe('login')
    expect(url.searchParams.get('login_hint')).toBe('person@example.com')
  })

  it('requires identity scopes and a transaction nonce', async () => {
    const provider = ChatGPT({ clientId, redirectUri })
    await expect(provider.getAuthorizationUrl('state', 'verifier')).rejects.toThrow('transaction')
    for (const scopes of [['email'], ['openid', 'offline_access'], ['openid', 'api.connectors']])
      await expect(provider.getAuthorizationUrl('state', 'verifier', { nonce: 'nonce', scopes })).rejects.toThrow(
        'identity scopes',
      )
    await expect(provider.validateCallback('code', 'verifier')).rejects.toThrow('nonce')
  })

  it.each([undefined, 'secret:with spaces+%'])(
    'maps only verified claims and exchanges securely (secret=%s)',
    async (clientSecret) => {
      const rawToken = await fixture.signIdentity()
      fixture.setTokens({ id_token: rawToken, access_token: 'unexpected-access', refresh_token: 'unexpected-refresh' })
      const result = await ChatGPT({ clientId, clientSecret, redirectUri }).validateCallback(
        'code',
        'verifier',
        undefined,
        undefined,
        {
          nonce: 'nonce',
        },
      )
      const requests = fixture.fetch.mock.calls.filter(([url]) => url === fixture.metadata.token_endpoint)
      expect(requests).toHaveLength(1)
      const request = requests[0]![1]!
      const body = request.body as URLSearchParams
      const headers = new Headers(request.headers)
      expect(body.get('client_id')).toBe(clientId)
      expect(body.has('client_secret')).toBe(false)
      if (clientSecret === undefined) {
        expect(headers.has('Authorization')).toBe(false)
      } else {
        const encodedSecret = new URLSearchParams({ value: clientSecret }).toString().slice('value='.length)
        expect(headers.get('Authorization')).toBe(`Basic ${btoa(`${clientId}:${encodedSecret}`)}`)
        expect(body.toString()).not.toContain(clientSecret)
      }
      expect(result.identityOnly).toBe(true)
      expect(result.user.id).toMatch(/^[a-f0-9]{64}$/)
      expect(result.user).toMatchObject({
        name: 'Person',
        email: 'person@example.com',
        emailVerified: true,
        avatar: 'https://example.com/avatar.png',
      })
      expect(result.tokens.data).toEqual({})
      expect(() => result.tokens.accessToken()).toThrow()
      expect(JSON.stringify(result)).not.toContain(rawToken)
      expect(result.user.raw).toMatchObject({ issuer: 'https://auth.openai.com', clientId, sub: 'subject' })
    },
  )

  it('rejects an empty client secret rather than choosing public authentication', () => {
    expect(() => ChatGPT({ clientId, clientSecret: '' })).toThrow('requires a client secret')
    expect(fixture.fetch).not.toHaveBeenCalled()
  })

  it('namespaces subjects by client and accepts missing optional profile claims', async () => {
    fixture.setTokens({
      id_token: await fixture.signIdentity({
        name: undefined,
        email: undefined,
        email_verified: undefined,
        picture: undefined,
      }),
    })
    const first = await ChatGPT({ clientId, redirectUri }).validateCallback('code', 'verifier', undefined, undefined, {
      nonce: 'nonce',
    })
    expect(first.user).toMatchObject({ name: '', email: null, emailVerified: null, avatar: null })
    fixture.setTokens({ id_token: await fixture.signIdentity({ aud: 'other-client' }) })
    const second = await ChatGPT({ clientId: 'other-client', redirectUri }).validateCallback(
      'code',
      'verifier',
      undefined,
      undefined,
      { nonce: 'nonce' },
    )
    expect(second.user.id).not.toBe(first.user.id)
  })

  it('rejects a response without an ID token', async () => {
    fixture.setTokens({ access_token: 'access' })
    await expect(
      ChatGPT({ clientId, redirectUri }).validateCallback('code', 'verifier', undefined, undefined, { nonce: 'nonce' }),
    ).rejects.toThrow('ID token')
  })
})
