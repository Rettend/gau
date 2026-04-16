import type { AuthUser, OAuthProvider, OAuthProviderConfig } from '../index'
import { createOAuthAuthorizationUrl, createOAuthClientResolver, refreshOAuthAccessToken } from '../utils'

const DISCORD_AUTH_URL = 'https://discord.com/api/oauth2/authorize'
const DISCORD_TOKEN_URL = 'https://discord.com/api/oauth2/token'
const DISCORD_USER_URL = 'https://discord.com/api/users/@me'

interface DiscordUser {
  id: string
  username: string
  discriminator: string
  avatar: string | null
  email: string | null
  verified: boolean
  [key: string]: unknown
}

async function getUser(accessToken: string): Promise<AuthUser> {
  const response = await fetch(DISCORD_USER_URL, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'User-Agent': 'gau',
    },
  })
  const data: DiscordUser = await response.json()
  return {
    id: data.id,
    name: data.username,
    email: data.email,
    emailVerified: data.verified,
    avatar: data.avatar ? `https://cdn.discordapp.com/avatars/${data.id}/${data.avatar}.png` : null,
    raw: data,
  }
}

export function Discord(config: OAuthProviderConfig): OAuthProvider<'discord'> {
  const getClient = createOAuthClientResolver(config)
  return {
    id: 'discord',
    linkOnly: config.linkOnly,
    requiresRedirectUri: true,
    async getAuthorizationUrl(state, codeVerifier, options) {
      const scopes = options?.scopes ?? config.scope ?? ['identify', 'email']
      return createOAuthAuthorizationUrl({
        client: getClient(options?.redirectUri),
        authorizationUrl: DISCORD_AUTH_URL,
        state,
        codeVerifier,
        scopes,
        configParams: config.params,
        params: options?.params,
      })
    },
    async validateCallback(code: string, codeVerifier: string, redirectUri?: string) {
      const client = getClient(redirectUri)
      const tokens = await client.validateAuthorizationCode(DISCORD_TOKEN_URL, code, codeVerifier)
      const user = await getUser(tokens.accessToken())
      return { tokens, user }
    },
    async refreshAccessToken(refreshToken) {
      return refreshOAuthAccessToken({
        tokenUrl: DISCORD_TOKEN_URL,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        refreshToken,
      })
    },
  }
}
