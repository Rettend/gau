import { exportJWK, generateKeyPair } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { createOIDCClient } from '../../src/oauth/oidc'
import { clientId, issuer, oidcFixture, redirectUri } from './oidc.fixture'

describe('OIDC client', () => {
  let fixture: Awaited<ReturnType<typeof oidcFixture>>
  beforeEach(async () => {
    fixture = await oidcFixture()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })
  const client = () => createOIDCClient({ issuer, clientId, fetch: fixture.fetch })

  it('caches discovery and JWKS and verifies a signed identity', async () => {
    const oidc = client()
    const token = await fixture.signIdentity()
    expect((await oidc.verifyIdToken(token, 'nonce')).sub).toBe('subject')
    await oidc.verifyIdToken(token, 'nonce')
    expect(fixture.fetch.mock.calls.filter(([url]) => String(url).includes('openid-configuration'))).toHaveLength(1)
    expect(fixture.fetch.mock.calls.filter(([url]) => String(url).includes('jwks.json'))).toHaveLength(1)
  })

  it.each([
    ['issuer', { iss: `${issuer}/` }],
    ['audience', { aud: 'another-client' }],
    ['expiration', { exp: Math.floor(Date.now() / 1000) - 60 }],
    ['future issued-at', { iat: Math.floor(Date.now() / 1000) + 60 }],
    ['missing issued-at', { iat: undefined }],
    ['missing expiration', { exp: undefined }],
    ['empty subject', { sub: '' }],
    ['missing subject', { sub: undefined }],
    ['nonce', { nonce: 'wrong' }],
    ['missing nonce', { nonce: undefined }],
    ['authorized party', { azp: 'wrong' }],
    ['multiple audiences without authorized party', { aud: [clientId, 'another'] }],
  ])('rejects invalid %s', async (_name, claims) => {
    await expect(client().verifyIdToken(await fixture.signIdentity(claims), 'nonce')).rejects.toThrow()
  })

  it('rejects an invalid signature', async () => {
    const other = await generateKeyPair('RS256')
    await expect(client().verifyIdToken(await fixture.signIdentity({}, other.privateKey), 'nonce')).rejects.toThrow()
  })

  it('refreshes cached JWKS for an unfamiliar key after the cooldown', async () => {
    const oidc = client()
    await oidc.verifyIdToken(await fixture.signIdentity(), 'nonce')
    const rotated = await generateKeyPair('RS256')
    fixture.jwksKeys.push({ ...(await exportJWK(rotated.publicKey)), kid: 'rotated-key', alg: 'RS256', use: 'sig' })
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 31_000)
    const token = await fixture.signIdentity({}, rotated.privateKey, 'RS256', 'rotated-key')
    await expect(oidc.verifyIdToken(token, 'nonce')).resolves.toMatchObject({ sub: 'subject' })
    expect(fixture.fetch.mock.calls.filter(([url]) => String(url).includes('jwks.json'))).toHaveLength(2)
  })

  it('rejects an algorithm outside the allowlist', async () => {
    const key = await generateKeyPair('ES256')
    await expect(
      client().verifyIdToken(await fixture.signIdentity({}, key.privateKey, 'ES256'), 'nonce'),
    ).rejects.toThrow()
  })

  it('requires a nonempty original nonce', async () => {
    await expect(client().verifyIdToken(await fixture.signIdentity(), '')).rejects.toThrow()
  })

  it('rejects mismatched discovery issuers and unsafe endpoints', async () => {
    fixture.metadata.issuer = 'https://attacker.example'
    await expect(client().getDiscovery()).rejects.toThrow('issuer mismatch')
    fixture.metadata.issuer = issuer
    fixture.metadata.token_endpoint = 'http://auth.openai.com/token'
    await expect(client().getDiscovery()).rejects.toThrow('HTTPS')
  })

  it('retries failed discovery', async () => {
    fixture.fetch.mockRejectedValueOnce(new Error('offline'))
    const oidc = client()
    await expect(oidc.getDiscovery()).rejects.toThrow('offline')
    await expect(oidc.getDiscovery()).resolves.toMatchObject({ issuer })
  })

  it('rejects discovery that does not advertise the configured method or signing algorithm', async () => {
    fixture.metadata.token_endpoint_auth_methods_supported = ['client_secret_basic']
    await expect(client().getDiscovery()).rejects.toThrow('authentication method')
    fixture.metadata.token_endpoint_auth_methods_supported = ['none']
    fixture.metadata.id_token_signing_alg_values_supported = ['HS256']
    await expect(client().getDiscovery()).rejects.toThrow('signing algorithm')
  })

  it('accepts identity-only public token responses without secret authentication', async () => {
    const idToken = await fixture.signIdentity()
    fixture.setTokens({ id_token: idToken })
    const tokens = await client().exchangeAuthorizationCode({ code: 'code', codeVerifier: 'verifier', redirectUri })
    expect(tokens).toEqual({ id_token: idToken })
    const request = fixture.fetch.mock.calls.find(([url]) => url === fixture.metadata.token_endpoint)![1]!
    expect(new Headers(request.headers).has('authorization')).toBe(false)
    expect(Object.fromEntries(request.body as URLSearchParams)).toEqual({
      grant_type: 'authorization_code',
      client_id: clientId,
      code: 'code',
      code_verifier: 'verifier',
      redirect_uri: redirectUri,
    })
    expect(request.redirect).toBe('error')
  })

  it('uses form-encoded HTTP Basic credentials only in the header', async () => {
    const oidc = createOIDCClient({
      issuer,
      clientId: 'client: +é',
      clientSecret: 'secret: +é',
      tokenEndpointAuthMethod: 'client_secret_basic',
      fetch: fixture.fetch,
    })
    await oidc.exchangeAuthorizationCode({ code: 'code', codeVerifier: 'verifier', redirectUri })
    const request = fixture.fetch.mock.calls.find(([url]) => url === fixture.metadata.token_endpoint)![1]!
    expect(atob(new Headers(request.headers).get('authorization')!.slice(6))).toBe(
      'client%3A+%2B%C3%A9:secret%3A+%2B%C3%A9',
    )
    expect((request.body as URLSearchParams).has('client_secret')).toBe(false)
  })

  it('does not fall back after confidential-client authentication fails or expose response secrets', async () => {
    fixture.setTokens({ error_description: 'secret-token-value' }, 401)
    const oidc = createOIDCClient({
      issuer,
      clientId,
      tokenEndpointAuthMethod: 'client_secret_basic',
      clientSecret: 'secret',
      fetch: fixture.fetch,
    })
    await expect(
      oidc.exchangeAuthorizationCode({ code: 'code', codeVerifier: 'verifier', redirectUri }),
    ).rejects.toThrow('OIDC token exchange failed')
    expect(fixture.fetch.mock.calls.filter(([url]) => url === fixture.metadata.token_endpoint)).toHaveLength(1)
  })

  it('rejects invalid registered authentication configuration', () => {
    expect(() =>
      createOIDCClient({ issuer, clientId, tokenEndpointAuthMethod: 'client_secret_basic', clientSecret: '' }),
    ).toThrow()
    // Runtime callers cannot silently downgrade a confidential client to public authentication.
    expect(() => createOIDCClient({ issuer, clientId, clientSecret: 'secret' } as never)).toThrow()
    expect(() =>
      createOIDCClient({ issuer, clientId, tokenEndpointAuthMethod: 'client_secret_post' } as never),
    ).toThrow()
    expect(() => createOIDCClient({ issuer, clientId, signingAlgorithms: ['HS256'] })).toThrow('signing algorithm')
  })
})
