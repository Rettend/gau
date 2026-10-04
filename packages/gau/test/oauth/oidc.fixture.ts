import type { JWTPayload } from 'jose'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { vi } from 'vite-plus/test'

export const issuer = 'https://auth.openai.com'
export const clientId = 'oaiapp_test'
export const redirectUri = 'https://app.example/api/auth/callback/chatgpt'
const keys = generateKeyPair('RS256')

export async function oidcFixture() {
  const { privateKey, publicKey } = await keys
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' }
  const jwksKeys = [jwk]
  const metadata = {
    issuer,
    authorization_endpoint: `${issuer}/api/accounts/authorize`,
    token_endpoint: `${issuer}/api/accounts/oauth/token`,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    id_token_signing_alg_values_supported: ['RS256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_basic'],
  }
  let tokens: Record<string, unknown> = {}
  let tokenStatus = 200
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = String(input)
    if (url.endsWith('/.well-known/openid-configuration')) return Response.json(metadata)
    if (url === metadata.jwks_uri) return Response.json({ keys: jwksKeys })
    if (url === metadata.token_endpoint) return Response.json(tokens, { status: tokenStatus })
    throw new Error(`Unhandled request: ${url} (${init?.method ?? 'GET'})`)
  })
  async function signIdentity(
    overrides: JWTPayload = {},
    key: CryptoKey = privateKey,
    alg = 'RS256',
    kid = 'test-key',
  ) {
    const now = Math.floor(Date.now() / 1000)
    return new SignJWT({
      iss: issuer,
      aud: clientId,
      sub: 'subject',
      exp: now + 300,
      iat: now,
      nonce: 'nonce',
      email: 'person@example.com',
      email_verified: true,
      name: 'Person',
      picture: 'https://example.com/avatar.png',
      ...overrides,
    })
      .setProtectedHeader({ alg, kid })
      .sign(key)
  }
  return {
    fetch,
    metadata,
    jwk,
    jwksKeys,
    signIdentity,
    setTokens(value: Record<string, unknown>, status = 200) {
      tokens = value
      tokenStatus = status
    },
  }
}
