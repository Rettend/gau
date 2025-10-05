import type { AuthUser, OAuthProvider, OAuthProviderConfig } from '../index'
import { CodeChallengeMethod, OAuth2Client } from 'arctic'

const FB_GRAPH_ME_URL = 'https://graph.facebook.com/me'
const FB_AUTH_URL = 'https://www.facebook.com/dialog/oauth'
const FB_TOKEN_URL = 'https://graph.facebook.com/oauth/access_token'

interface FacebookUserResponse {
  id: string
  name?: string | null
  email?: string | null
  picture?: { data?: { url?: string | null } } | string | null
  [key: string]: unknown
}

async function getUser(accessToken: string): Promise<AuthUser> {
  const searchParams = new URLSearchParams()
  searchParams.set('access_token', accessToken)
  searchParams.set('fields', ['id', 'name', 'picture', 'email'].join(','))

  const response = await fetch(`${FB_GRAPH_ME_URL}?${searchParams.toString()}`)
  const data: FacebookUserResponse = await response.json()

  let avatar: string | null = null
  if (typeof data.picture === 'string')
    avatar = data.picture
  else if (data.picture && typeof data.picture === 'object' && 'data' in data.picture)
    avatar = data.picture.data?.url ?? null

  return {
    id: String(data.id),
    name: data.name ?? '',
    email: data.email ?? null,
    emailVerified: null,
    avatar,
    raw: data,
  }
}

export function Facebook(config: OAuthProviderConfig): OAuthProvider<'facebook', OAuthProviderConfig> {
  const defaultClient = new OAuth2Client(config.clientId, config.clientSecret, config.redirectUri ?? null)

  function getClient(redirectUri?: string): OAuth2Client {
    if (!redirectUri || redirectUri === config.redirectUri)
      return defaultClient
    return new OAuth2Client(config.clientId, config.clientSecret, redirectUri)
  }

  return {
    id: 'facebook',
    linkOnly: config.linkOnly,
    requiresRedirectUri: true,

    async getAuthorizationUrl(state, codeVerifier, options) {
      const client = getClient(options?.redirectUri)
      const scopes = options?.scopes ?? config.scope ?? ['email', 'public_profile']
      const url = await client.createAuthorizationURLWithPKCE(
        FB_AUTH_URL,
        state,
        CodeChallengeMethod.S256,
        codeVerifier,
        scopes,
      )
      const mergedParams = { ...(config.params ?? {}), ...(options?.params ?? {}) }
      if (Object.keys(mergedParams).length) {
        for (const [k, v] of Object.entries(mergedParams)) {
          if (v != null)
            url.searchParams.set(k, String(v))
        }
      }
      return url
    },

    async validateCallback(code, codeVerifier, redirectUri) {
      const client = getClient(redirectUri)
      const tokens = await client.validateAuthorizationCode(FB_TOKEN_URL, code, codeVerifier)
      const user = await getUser(tokens.accessToken())
      return { tokens, user }
    },
  }
}
