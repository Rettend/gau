import type { AuthUser, OAuthProvider, OAuthProviderConfig, RefreshedTokens } from '../index'
import { CodeChallengeMethod, OAuth2Client } from 'arctic'

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
  const defaultClient = new OAuth2Client(config.clientId, config.clientSecret, config.redirectUri ?? null)
  function getClient(redirectUri?: string): OAuth2Client {
    if (!redirectUri || redirectUri === config.redirectUri)
      return defaultClient
    return new OAuth2Client(config.clientId, config.clientSecret, redirectUri)
  }
  return {
    id: 'discord',
    linkOnly: config.linkOnly,
    requiresRedirectUri: true,
    async getAuthorizationUrl(state: string, codeVerifier: string, options?: { scopes?: string[], redirectUri?: string, params?: Record<string, string>, overrides?: any }) {
      const client = getClient(options?.redirectUri)
      const scopes = options?.scopes ?? config.scope ?? ['identify', 'email']
      const url = await client.createAuthorizationURLWithPKCE(DISCORD_AUTH_URL, state, CodeChallengeMethod.S256, codeVerifier, scopes)
      if (options?.params) {
        for (const [k, v] of Object.entries(options.params)) {
          if (v != null)
            url.searchParams.set(k, String(v))
        }
      }
      return url
    },
    async validateCallback(code: string, codeVerifier: string, redirectUri?: string) {
      const client = getClient(redirectUri)
      const tokens = await client.validateAuthorizationCode(DISCORD_TOKEN_URL, code, codeVerifier)
      const user = await getUser(tokens.accessToken())
      return { tokens, user }
    },
    async refreshAccessToken(refreshToken: string): Promise<RefreshedTokens> {
      const body = new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      })
      const res = await fetch(DISCORD_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      })
      const json = await res.json()
      if (!res.ok)
        throw json
      const expiresIn: number | undefined = json.expires_in
      const expiresAt = typeof expiresIn === 'number' ? Math.floor(Date.now() / 1000) + Math.floor(expiresIn) : undefined
      return {
        accessToken: json.access_token,
        refreshToken: json.refresh_token ?? refreshToken,
        expiresAt: expiresAt ?? null,
        idToken: json.id_token ?? null,
        tokenType: json.token_type ?? null,
        scope: json.scope ?? null,
      }
    },
  }
}
