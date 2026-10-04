import type { OAuth2Tokens } from 'arctic'

export { Discord } from './providers/discord'
export { Facebook } from './providers/facebook'
export { GitHub } from './providers/github'
export { Google } from './providers/google'
export { Microsoft } from './providers/microsoft'
export { ChatGPT } from './providers/chatgpt'
export type { ChatGPTConfig } from './providers/chatgpt'

export interface OAuthProviderConfig {
  clientId: string
  clientSecret: string
  redirectUri?: string
  scope?: string[]
  linkOnly?: boolean
  params?: Record<string, string>
}

export interface OAuthAuthorizationOptions<C = OAuthProviderConfig> {
  scopes?: string[]
  redirectUri?: string
  params?: Record<string, string>
  overrides?: ProviderProfileOverrides<C>
  /** Original transaction nonce for providers that require OpenID Connect verification. */
  nonce?: string
}

export interface OAuthRefreshOptions<C = OAuthProviderConfig> {
  redirectUri?: string
  scopes?: string[]
  overrides?: ProviderProfileOverrides<C>
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

export interface OAuthCallbackContext {
  nonce: string
}

export interface OAuthCallbackResult {
  tokens: OAuth2Tokens
  user: AuthUser
  /** A verified OIDC identity without API tokens. Token accessors may throw; no tokens are persisted. */
  identityOnly?: boolean
}

export interface OAuthProvider<T extends string = string, C = OAuthProviderConfig> {
  id: T
  requiresRedirectUri?: boolean
  linkOnly?: boolean
  /** Requires an expiring, one-time server-side transaction and a verified ID-token nonce. */
  requiresNonce?: boolean
  /** Prevent email matching from linking accounts, even when global autoLink is enabled. */
  allowEmailAutoLink?: false
  getAuthorizationUrl: (
    state: string,
    codeVerifier: string,
    options?: OAuthAuthorizationOptions<C>,
  ) => Promise<URL>
  validateCallback: (
    code: string,
    codeVerifier: string,
    redirectUri?: string,
    overrides?: ProviderProfileOverrides<C>,
    context?: OAuthCallbackContext,
  ) => Promise<OAuthCallbackResult>
  refreshAccessToken?: (
    refreshToken: string,
    options?: OAuthRefreshOptions<C>,
  ) => Promise<RefreshedTokens>
}
