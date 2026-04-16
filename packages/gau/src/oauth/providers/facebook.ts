import type { AuthUser, OAuthProvider, OAuthProviderConfig } from '../index'
import { createOAuthAuthorizationUrl, createOAuthClientResolver } from '../utils'

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
  searchParams.set('fields', ['id', 'name', 'picture', 'email'].join(','))

  const response = await fetch(`${FB_GRAPH_ME_URL}?${searchParams.toString()}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })
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
    emailVerified: data.email ? true : null,
    avatar,
    raw: data,
  }
}

export function Facebook(config: OAuthProviderConfig): OAuthProvider<'facebook', OAuthProviderConfig> {
  const getClient = createOAuthClientResolver(config)

  return {
    id: 'facebook',
    linkOnly: config.linkOnly,
    requiresRedirectUri: true,

    async getAuthorizationUrl(state, codeVerifier, options) {
      const scopes = options?.scopes ?? config.scope ?? ['email', 'public_profile']
      return createOAuthAuthorizationUrl({
        client: getClient(options?.redirectUri),
        authorizationUrl: FB_AUTH_URL,
        state,
        codeVerifier,
        scopes,
        configParams: config.params,
        params: options?.params,
      })
    },

    async validateCallback(code, codeVerifier, redirectUri) {
      const client = getClient(redirectUri)
      const tokens = await client.validateAuthorizationCode(FB_TOKEN_URL, code, codeVerifier)
      const user = await getUser(tokens.accessToken())
      return { tokens, user }
    },
  }
}
