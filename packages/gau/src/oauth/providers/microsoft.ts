import type { AuthUser, OAuthProvider, OAuthProviderConfig } from '../index'
import { createOAuthAuthorizationUrl, createOAuthClientResolver, mergeOAuthParams, refreshOAuthAccessToken } from '../utils'

// https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc
const MICROSOFT_USER_INFO_URL = 'https://graph.microsoft.com/v1.0/me'

// https://learn.microsoft.com/en-us/graph/api/profilephoto-get?view=graph-rest-1.0
const MICROSOFT_USER_PHOTO_URL = 'https://graph.microsoft.com/v1.0/me/photo/$value'

// https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow#request-an-authorization-code
interface MicrosoftConfig extends OAuthProviderConfig {
  tenant?: 'common' | 'organizations' | 'consumers' | (string & {})
  prompt?: 'login' | 'none' | 'consent' | 'select_account' | (string & {})
}

interface MicrosoftUser {
  id: string
  displayName: string
  mail: string | null
  userPrincipalName: string
  [key: string]: unknown
}

function base64url_decode(str: string): Uint8Array {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/')
  const padLength = (4 - (base64.length % 4)) % 4
  const padded = base64.padEnd(base64.length + padLength, '=')
  const binary_string = atob(padded)
  const len = binary_string.length
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++)
    bytes[i] = binary_string.charCodeAt(i)

  return bytes
}

async function getUser(accessToken: string, idToken: string | null): Promise<AuthUser> {
  const userResponse = await fetch(MICROSOFT_USER_INFO_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })
  const userData: MicrosoftUser = await userResponse.json()

  let email: string | null = userData.mail ?? userData.userPrincipalName
  let emailVerified = false
  if (idToken) {
    try {
      const parts = idToken.split('.')
      const payload = JSON.parse(new TextDecoder().decode(base64url_decode(parts[1]!))) as Record<string, any>
      const personalTenantId = '9188040d-6c67-4c5b-b112-36a304b66dad'

      // For work/school accounts, the `verified_primary_email` is the source of truth.
      if (payload.verified_primary_email) {
        const primaryEmail = Array.isArray(payload.verified_primary_email)
          ? payload.verified_primary_email[0]
          : payload.verified_primary_email

        if (typeof primaryEmail === 'string') {
          email = primaryEmail
          emailVerified = true
        }
      }
      // For personal accounts, the `email` claim is reliable and verified.
      else if (payload.tid === personalTenantId) {
        email = payload.email ?? email
        emailVerified = true
      }
      // Legacy fallback for `xms_edov`.
      else if (payload.xms_edov === true) {
        email = payload.email ?? email
        emailVerified = true
      }
    }
    catch {
    }
  }

  const photoResponse = await fetch(MICROSOFT_USER_PHOTO_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })

  let avatar: string | null = null
  if (photoResponse.ok) {
    try {
      const blob = await photoResponse.blob()
      const reader = new FileReader()
      const dataUrlPromise = new Promise<string>((resolve, reject) => {
        reader.onloadend = () => resolve(reader.result as string)
        reader.onerror = reject
        reader.readAsDataURL(blob)
      })
      avatar = await dataUrlPromise
    }
    catch {
    }
  }

  return {
    id: userData.id,
    name: userData.displayName,
    email,
    emailVerified,
    avatar,
    raw: userData,
  }
}

export function Microsoft(config: MicrosoftConfig): OAuthProvider<'microsoft', MicrosoftConfig> {
  const getEndpoints = (tenant: MicrosoftConfig['tenant']) => ({
    authURL: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
    tokenURL: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
  })

  const getClient = createOAuthClientResolver(config)

  return {
    id: 'microsoft',
    linkOnly: config.linkOnly,
    requiresRedirectUri: true,

    async getAuthorizationUrl(state, codeVerifier, options) {
      const scopes = options?.scopes ?? config.scope ?? ['openid', 'profile', 'email', 'User.Read']
      const effectiveTenant: MicrosoftConfig['tenant'] = options?.overrides?.tenant ?? config.tenant ?? 'common'
      const { authURL } = getEndpoints(effectiveTenant)
      const params = mergeOAuthParams(config.params, options?.params)
      const prompt = options?.overrides?.prompt ?? params.prompt ?? config.prompt

      return createOAuthAuthorizationUrl({
        client: getClient(options?.redirectUri),
        authorizationUrl: authURL,
        state,
        codeVerifier,
        scopes,
        configParams: config.params,
        params: options?.params,
        omitParamKeys: ['prompt'],
        extraParams: prompt ? { prompt } : undefined,
      })
    },

    async validateCallback(code: string, codeVerifier: string, redirectUri?: string, overrides?: Partial<Pick<MicrosoftConfig, 'tenant'>>) {
      const client = getClient(redirectUri)
      const effectiveTenant: MicrosoftConfig['tenant'] = overrides?.tenant ?? config.tenant ?? 'common'
      const { tokenURL } = getEndpoints(effectiveTenant)
      const tokens = await client.validateAuthorizationCode(tokenURL, code, codeVerifier)
      const user = await getUser(tokens.accessToken(), tokens.idToken())
      return { tokens, user }
    },

    async refreshAccessToken(refreshToken, options) {
      const effectiveTenant: MicrosoftConfig['tenant'] = options?.overrides?.tenant ?? config.tenant ?? 'common'
      const { tokenURL } = getEndpoints(effectiveTenant)
      return refreshOAuthAccessToken({
        tokenUrl: tokenURL,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        refreshToken,
        scopes: options?.scopes ?? config.scope ?? ['openid', 'profile', 'email', 'User.Read'],
      })
    },
  }
}
