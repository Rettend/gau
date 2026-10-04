import type { OAuthProvider, OAuthProviderConfig } from '../index'
import type { OIDCClientAuthentication } from '../oidc'
import { OAuth2Tokens } from 'arctic'
import { createOIDCClient } from '../oidc'

export type ChatGPTConfig = Omit<OAuthProviderConfig, 'clientSecret'> & { clientSecret?: string }

const issuer = 'https://auth.openai.com'
const identityScopes = new Set(['openid', 'profile', 'email'])
const protectedParams = new Set([
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
])

/** Website identity sign-in. ChatGPT plan access uses a separate client and authorization flow. */
export function ChatGPT(config: ChatGPTConfig): OAuthProvider<'chatgpt', ChatGPTConfig> {
  const authentication: OIDCClientAuthentication =
    config.clientSecret === undefined
      ? { tokenEndpointAuthMethod: 'none' }
      : { tokenEndpointAuthMethod: 'client_secret_basic', clientSecret: config.clientSecret }
  const client = createOIDCClient({ clientId: config.clientId, issuer, ...authentication })
  return {
    id: 'chatgpt',
    requiresRedirectUri: true,
    requiresNonce: true,
    linkOnly: config.linkOnly,
    allowEmailAutoLink: false,
    async getAuthorizationUrl(state, codeVerifier, options) {
      const redirectUri = config.redirectUri ?? options?.redirectUri
      const nonce = options?.nonce
      if (!redirectUri || !nonce || !state || !codeVerifier) throw new Error('Missing ChatGPT sign-in transaction')
      const scopes = options?.scopes ?? config.scope ?? ['openid', 'profile', 'email']
      if (!scopes.includes('openid') || scopes.some((scope) => !identityScopes.has(scope)))
        throw new Error('ChatGPT web sign-in requires openid and supports only identity scopes')
      const metadata = await client.getDiscovery()
      const url = new URL(metadata.authorization_endpoint)
      for (const [key, value] of Object.entries({ ...config.params, ...options?.params })) {
        if (!protectedParams.has(key)) url.searchParams.set(key, value)
      }
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier))
      const challenge = btoa(String.fromCharCode(...new Uint8Array(hash)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
      for (const [key, value] of Object.entries({
        client_id: config.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        response_mode: 'query',
        scope: scopes.join(' '),
        state,
        nonce,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }))
        url.searchParams.set(key, value)
      return url
    },
    async validateCallback(code, codeVerifier, redirectUri, _overrides, context) {
      if (!context?.nonce) throw new Error('Missing ChatGPT transaction nonce')
      const tokens = await client.exchangeAuthorizationCode({
        code,
        codeVerifier,
        redirectUri: config.redirectUri ?? redirectUri ?? '',
      })
      const identity = await client.verifyIdToken(tokens.id_token!, context.nonce)
      // Hash the tuple to avoid delimiter collisions and adapter-specific account ID limits.
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(JSON.stringify([issuer, config.clientId, identity.sub])),
      )
      const id = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
      return {
        identityOnly: true,
        // Keep the existing token-hook API without inventing an access token or retaining raw ID tokens.
        tokens: new OAuth2Tokens({}),
        user: {
          id,
          name: typeof identity.name === 'string' ? identity.name : '',
          email: typeof identity.email === 'string' ? identity.email : null,
          emailVerified: typeof identity.email_verified === 'boolean' ? identity.email_verified : null,
          avatar: typeof identity.picture === 'string' ? identity.picture : null,
          raw: {
            issuer,
            clientId: config.clientId,
            sub: identity.sub,
            name: identity.name,
            email: identity.email,
            email_verified: identity.email_verified,
            picture: identity.picture,
          },
        },
      }
    },
  }
}
