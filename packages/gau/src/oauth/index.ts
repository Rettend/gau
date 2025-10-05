import type { OAuth2Tokens } from 'arctic'

export { Facebook } from './providers/facebook'
export { GitHub } from './providers/github'
export { Google } from './providers/google'
export { Microsoft } from './providers/microsoft'

export interface OAuthProviderConfig {
  clientId: string
  clientSecret: string
  redirectUri?: string
  scope?: string[]
  linkOnly?: boolean
  params?: Record<string, string>
}

export interface RefreshedTokens {
  accessToken: string
  refreshToken?: string | null
  expiresAt?: number | null
  idToken?: string | null
  tokenType?: string | null
  scope?: string | null
}

export interface AuthUser {
  id: string
  name: string
  email: string | null
  emailVerified: boolean | null
  avatar: string | null
  raw: Record<string, unknown>
}

export type ProviderProfileOverrides<C> = Partial<Pick<C, Extract<keyof C, 'tenant' | 'prompt'>>>

export interface OAuthProvider<T extends string = string, C = OAuthProviderConfig> {
  id: T
  requiresRedirectUri?: boolean
  linkOnly?: boolean
  getAuthorizationUrl: (
    state: string,
    codeVerifier: string,
    options?: { scopes?: string[], redirectUri?: string, params?: Record<string, string>, overrides?: ProviderProfileOverrides<C> },
  ) => Promise<URL>
  validateCallback: (
    code: string,
    codeVerifier: string,
    redirectUri?: string,
    overrides?: ProviderProfileOverrides<C>,
  ) => Promise<{ tokens: OAuth2Tokens, user: AuthUser }>
  refreshAccessToken?: (
    refreshToken: string,
    options?: { redirectUri?: string, scopes?: string[], overrides?: ProviderProfileOverrides<C> },
  ) => Promise<RefreshedTokens>
}
