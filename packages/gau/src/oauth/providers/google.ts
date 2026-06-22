import type { AuthUser, OAuthProvider, OAuthProviderConfig } from '../index'
import { createOAuthAuthorizationUrl, createOAuthClientResolver, refreshOAuthAccessToken } from '../utils'

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo'

interface GoogleUser {
  sub: string
  name: string
  email: string | null
  email_verified: boolean
  picture: string | null
  [key: string]: unknown
}

async function getUser(accessToken: string): Promise<AuthUser> {
  const response = await fetch(GOOGLE_USERINFO_URL, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'User-Agent': 'gau',
    },
  })
  const data: GoogleUser = await response.json()

  return {
    id: data.sub,
    name: data.name,
    email: data.email,
    emailVerified: data.email_verified,
    avatar: data.picture,
    raw: data,
  }
}

export function Google(config: OAuthProviderConfig): OAuthProvider<'google'> {
  const getClient = createOAuthClientResolver(config)

  return {
    id: 'google',
    linkOnly: config.linkOnly,
    requiresRedirectUri: true,

    async getAuthorizationUrl(state, codeVerifier, options) {
      const scopes = options?.scopes ?? config.scope ?? ['openid', 'email', 'profile']
      return createOAuthAuthorizationUrl({
        client: getClient(options?.redirectUri),
        authorizationUrl: GOOGLE_AUTH_URL,
        state,
        codeVerifier,
        scopes,
        configParams: config.params,
        params: options?.params,
      })
    },

    async validateCallback(code: string, codeVerifier: string, redirectUri?: string) {
      const client = getClient(redirectUri)
      const tokens = await client.validateAuthorizationCode(GOOGLE_TOKEN_URL, code, codeVerifier)
      const user = await getUser(tokens.accessToken())
      return { tokens, user }
    },

    async refreshAccessToken(refreshToken) {
      return refreshOAuthAccessToken({
        tokenUrl: GOOGLE_TOKEN_URL,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        refreshToken,
      })
    },
  }
}
