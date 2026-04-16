import type { AuthUser, OAuthProvider, OAuthProviderConfig } from '../index'
import { createOAuthAuthorizationUrl, createOAuthClientResolver } from '../utils'

const GITHUB_AUTH_URL = 'https://github.com/login/oauth/authorize'
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const GITHUB_API_URL = 'https://api.github.com'

interface GitHubUser {
  id: number
  login: string
  avatar_url: string
  name: string
  email: string | null
  [key: string]: unknown
}

interface GitHubEmail {
  email: string
  primary: boolean
  verified: boolean
  visibility: 'public' | 'private' | null
}

async function getUser(accessToken: string): Promise<AuthUser> {
  const response = await fetch(`${GITHUB_API_URL}/user`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'User-Agent': 'gau',
      'Accept': 'application/vnd.github+json',
    },
  })
  const data: GitHubUser = await response.json()

  let email: string | null = data.email
  let emailVerified = false

  const emailsResponse = await fetch(`${GITHUB_API_URL}/user/emails`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'User-Agent': 'gau',
      'Accept': 'application/vnd.github+json',
    },
  })

  if (emailsResponse.ok) {
    const emails: GitHubEmail[] = await emailsResponse.json()
    const primaryEmail = emails.find(e => e.primary && e.verified)
    if (primaryEmail) {
      email = primaryEmail.email
      emailVerified = true
    }
    else {
      // Fallback to the first verified email if no primary is found
      const verifiedEmail = emails.find(e => e.verified)
      if (verifiedEmail) {
        email = verifiedEmail.email
        emailVerified = true
      }
    }
  }

  return {
    id: data.id.toString(),
    name: data.name ?? data.login,
    email,
    emailVerified,
    avatar: data.avatar_url,
    raw: data,
  }
}

export function GitHub(config: OAuthProviderConfig): OAuthProvider<'github', OAuthProviderConfig> {
  const getClient = createOAuthClientResolver(config)

  return {
    id: 'github',
    linkOnly: config.linkOnly,
    requiresRedirectUri: true,

    async getAuthorizationUrl(state, codeVerifier, options) {
      const scopes = options?.scopes ?? config.scope ?? ['read:user', 'user:email']
      return createOAuthAuthorizationUrl({
        client: getClient(options?.redirectUri),
        authorizationUrl: GITHUB_AUTH_URL,
        state,
        codeVerifier,
        scopes,
        configParams: config.params,
        params: options?.params,
      })
    },

    async validateCallback(code: string, codeVerifier: string, redirectUri?: string) {
      const client = getClient(redirectUri)
      const tokens = await client.validateAuthorizationCode(GITHUB_TOKEN_URL, code, codeVerifier)
      const user = await getUser(tokens.accessToken())
      return { tokens, user }
    },
  }
}
