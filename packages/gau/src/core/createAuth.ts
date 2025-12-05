import type { OAuth2Tokens } from 'arctic'
import type { SerializeOptions } from 'cookie'
import type { SignOptions, VerifyOptions } from '../jwt'
import type { AuthUser, OAuthProvider, OAuthProviderConfig, ProviderProfileOverrides } from '../oauth'
import type { Cookies } from './cookies'
import type { Adapter, GauSession } from './index'
import { sign, verify } from '../jwt'
import { DEFAULT_COOKIE_SERIALIZE_OPTIONS } from './cookies'
import { AuthError } from './index'

type ProviderId<P> = P extends OAuthProvider<infer T> ? T : never
export type ProviderIds<T> = T extends { providerMap: Map<infer K extends string, any> } ? K : string

export type ProfileName<T, P extends string> = T extends { profiles: infer R }
  ? P extends keyof R
    ? keyof R[P]
    : never
  : never

export interface CreateAuthOptions<TProviders extends OAuthProvider[]> {
  /** The database adapter to use for storing users and accounts. */
  adapter: Adapter
  /** Array of OAuth providers to support. */
  providers: TProviders
  /** Base path for authentication routes (defaults to '/api/auth'). */
  basePath?: string
  /** Session management options */
  session?: {
    /** Strategy to use for sessions: 'auto' (default), 'cookie', or 'token'. */
    strategy?: 'auto' | 'cookie' | 'token'
  }
  /** Configuration for JWT signing and verification. */
  jwt?: {
    /** Signing algorithm: 'ES256' (default) or 'HS256'. */
    algorithm?: 'ES256' | 'HS256'
    /** Secret for HS256 or base64url-encoded private key for ES256 (overrides AUTH_SECRET). */
    secret?: string
    /** Issuer claim (iss) for JWTs. */
    iss?: string
    /** Audience claim (aud) for JWTs. */
    aud?: string
    /** Default time-to-live in seconds for JWTs (defaults to 1 day). */
    ttl?: number
  }
  /** Custom options for session cookies. */
  cookies?: Partial<SerializeOptions>
  /**
   * Hook that fires right after provider.validateCallback() returns tokens,
   * but before any user lookup/link/create logic. Return { handled: true, response }
   * to short-circuit the default flow and send a custom response.
   */
  onOAuthExchange?: (context: {
    request: Request
    providerId: string
    state: string
    code: string
    codeVerifier: string
    callbackUri?: string | null
    redirectTo: string
    cookies: Cookies
    providerUser: AuthUser
    tokens: OAuth2Tokens
    isLinking: boolean
    sessionUserId?: string
  }) => Promise<{ handled: true, response: Response } | { handled: false }>
  /** Map/override the provider's profile right after token exchange. */
  mapExternalProfile?: (context: {
    request: Request
    providerId: string
    providerUser: AuthUser
    tokens: OAuth2Tokens
    isLinking: boolean
  }) => Promise<AuthUser | Partial<AuthUser> | null | undefined>
  /** Gate the link action just before persisting an account. */
  onBeforeLinkAccount?: (context: {
    request: Request
    providerId: string
    userId: string
    providerUser: AuthUser
    tokens: OAuth2Tokens
  }) => Promise<{ allow: true } | { allow: false, response?: Response }>
  /** Observe or augment after link/update tokens. */
  onAfterLinkAccount?: (context: {
    request: Request
    providerId: string
    userId: string
    providerUser: AuthUser
    tokens: OAuth2Tokens
    action: 'link' | 'update'
  }) => Promise<void>
  /** Trusted hosts for CSRF protection: 'all' or array of hostnames (defaults to []). */
  trustHosts?: 'all' | string[]
  /** Account linking behavior: 'verifiedEmail' (default), 'always', or false. */
  autoLink?: 'verifiedEmail' | 'always' | false
  /** Allow linking providers whose primary emails differ from the user's current primary email. Defaults to true. */
  allowDifferentEmails?: boolean
  /** When linking a new provider, update missing user info (name/image/emailVerified) from provider profile. Defaults to false. */
  updateUserInfoOnLink?: boolean
  /** Optional configuration for role-based access control. */
  roles?: {
    /** Default role for newly created users. */
    defaultRole?: string
    /** Dynamically resolve the role at the moment of user creation. Return undefined to fall back to defaultRole. */
    resolveOnCreate?: (context: { providerId: string, profile: any, request: Request }) => string | undefined
    /** Roles that are considered admin-like for helper predicates and `session.user.isAdmin`. */
    adminRoles?: string[]
    /** Users that are always treated as admin for helper predicates and `session.user.isAdmin`. */
    adminUserIds?: string[]
  }
  /**
   * CORS configuration. When true (default): request Origin & allow credentials
   * When false, CORS headers are not added at all.
   * Provide an object to fine-tune behaviour.
   */
  cors?: true | false | {
    /**
     * Allowed origins.
     * - 'all' (default) allows any origin (reflected when credentials enabled),
     * - 'trust' reuses the createAuth trustHosts list
     * - specify an explicit array of full origins (e.g. https://app.example.com)
     *   or hostnames (e.g. app.example.com).
     * When array contains '*', it's treated as 'all'.
     */
    allowedOrigins?: 'all' | 'trust' | string[]
    /** Whether to send Access-Control-Allow-Credentials (defaults to true). */
    allowCredentials?: boolean
    /** Allowed headers (defaults to ['Content-Type','Authorization','Cookie']). */
    allowedHeaders?: string[]
    /** Allowed methods (defaults to ['GET','POST','OPTIONS']). */
    allowedMethods?: string[]
    /** Exposed headers (optional). */
    exposeHeaders?: string[]
    /** Preflight max age in seconds (optional). */
    maxAge?: number
  }
  /**
   * Named, server-defined profiles that group provider specific settings.
   * Clients can reference a profile by name (e.g. signIn('github', { profile: 'myprofile' })).
   */
  profiles?: ProfilesConfig<TProviders>
}

export type Auth<TProviders extends OAuthProvider[] = any> = Adapter & {
  providerMap: Map<ProviderId<TProviders[number]>, TProviders[number]>
  basePath: string
  cookieOptions: SerializeOptions
  jwt: { ttl: number }
  onOAuthExchange?: CreateAuthOptions<TProviders>['onOAuthExchange']
  mapExternalProfile?: CreateAuthOptions<TProviders>['mapExternalProfile']
  onBeforeLinkAccount?: CreateAuthOptions<TProviders>['onBeforeLinkAccount']
  onAfterLinkAccount?: CreateAuthOptions<TProviders>['onAfterLinkAccount']
  signJWT: <U extends Record<string, unknown>>(payload: U, customOptions?: Partial<SignOptions>) => Promise<string>
  verifyJWT: <U = Record<string, unknown>>(token: string, customOptions?: Partial<VerifyOptions>) => Promise<U | null>
  createSession: (userId: string, data?: Record<string, unknown>, ttl?: number) => Promise<string>
  validateSession: (token: string) => Promise<GauSession | null>
  /**
   * Get a valid access token for a linked provider. If the stored token is expired and a refresh token exists,
   * this will refresh it using the provider's refreshAccessToken and persist rotated tokens.
   */
  getAccessToken: (userId: string, providerId: string) => Promise<{ accessToken: string, expiresAt?: number | null } | null>
  trustHosts: 'all' | string[]
  autoLink: 'verifiedEmail' | 'always' | false
  allowDifferentEmails: boolean
  updateUserInfoOnLink: boolean
  sessionStrategy: 'auto' | 'cookie' | 'token'
  development: boolean
  roles: {
    defaultRole: string
    resolveOnCreate?: (context: { providerId: string, profile: any, request: Request }) => string | undefined
    adminRoles: string[]
    adminUserIds: string[]
  }
  cors: false | {
    allowedOrigins: 'all' | 'trust' | string[]
    allowCredentials: boolean
    allowedHeaders: string[]
    allowedMethods: string[]
    exposeHeaders?: string[]
    maxAge?: number
  }
  profiles: ResolvedProfiles<TProviders>
}

export interface ProfileDefinition {
  scopes?: string[]
  redirectUri?: string
  /** When true, this profile can only be linked to an existing session; standalone sign-in is disabled. */
  linkOnly?: boolean
  /** Additional provider-specific authorization params. */
  params?: Record<string, string>
}

type ProviderIdOfArray<TProviders extends OAuthProvider[]> = ProviderId<TProviders[number]>
type ProviderConfigFor<TProviders extends OAuthProvider[], K extends string>
  = Extract<TProviders[number], OAuthProvider<K, any>> extends OAuthProvider<any, infer C> ? C : OAuthProviderConfig

export type ProfilesConfig<TProviders extends OAuthProvider[]> = Partial<{
  [K in ProviderIdOfArray<TProviders>]: Record<string, ProfileDefinition & ProviderProfileOverrides<ProviderConfigFor<TProviders, K>>>
}>
export type ResolvedProfiles<TProviders extends OAuthProvider[]> = ProfilesConfig<TProviders>

export function createAuth<const TProviders extends OAuthProvider[]>({
  adapter,
  providers,
  basePath = '/api/auth',
  jwt: jwtConfig = {},
  session: sessionConfig = {},
  cookies: cookieConfig = {},
  onOAuthExchange,
  mapExternalProfile,
  onBeforeLinkAccount,
  onAfterLinkAccount,
  trustHosts = [],
  autoLink = 'verifiedEmail',
  allowDifferentEmails = true,
  updateUserInfoOnLink = false,
  roles: rolesConfig = {},
  cors = true,
  profiles: profilesConfig,
}: CreateAuthOptions<TProviders>): Auth<TProviders> {
  const { algorithm = 'ES256', secret, iss, aud, ttl: defaultTTL = 3600 * 24 * 7 } = jwtConfig
  const cookieOptions = { ...DEFAULT_COOKIE_SERIALIZE_OPTIONS, ...cookieConfig }

  const sessionStrategy: 'auto' | 'cookie' | 'token' = sessionConfig.strategy ?? 'auto'

  if (algorithm === 'ES256' && secret !== undefined && typeof secret !== 'string')
    throw new AuthError('For ES256, the secret option must be a string.')

  const providerMap = new Map(providers.map(p => [p.id, p]))

  const resolvedCors: Auth['cors'] = cors === false
    ? false
    : {
        allowedOrigins: (cors === true ? 'all' : cors.allowedOrigins) ?? 'all',
        allowCredentials: (cors === true ? true : cors.allowCredentials) ?? true,
        allowedHeaders: (cors === true ? undefined : cors.allowedHeaders) ?? ['Content-Type', 'Authorization', 'Cookie'],
        allowedMethods: (cors === true ? undefined : cors.allowedMethods) ?? ['GET', 'POST', 'OPTIONS'],
        exposeHeaders: cors === true ? undefined : cors.exposeHeaders,
        maxAge: cors === true ? undefined : cors.maxAge,
      }

  const resolvedProfiles = (profilesConfig ?? {}) as ResolvedProfiles<TProviders>
  const resolvedRoles = {
    defaultRole: rolesConfig.defaultRole ?? 'user',
    resolveOnCreate: rolesConfig.resolveOnCreate,
    adminRoles: rolesConfig.adminRoles ?? ['admin'],
    adminUserIds: rolesConfig.adminUserIds ?? [],
  }

  function buildSignOptions(custom: Partial<SignOptions> = {}): SignOptions {
    const base = { ttl: custom.ttl, iss: custom.iss ?? iss, aud: custom.aud ?? aud, sub: custom.sub }
    if (algorithm === 'HS256') {
      return { algorithm, secret: custom.secret ?? secret, ...base }
    }
    else {
      if (custom.secret !== undefined && typeof custom.secret !== 'string')
        throw new AuthError('For ES256, the secret option must be a string.')
      const esSecret = custom.secret ?? secret
      return { algorithm, privateKey: custom.privateKey, secret: esSecret, ...base }
    }
  }

  function buildVerifyOptions(custom: Partial<VerifyOptions> = {}): VerifyOptions {
    const base = { iss: custom.iss ?? iss, aud: custom.aud ?? aud }
    if (algorithm === 'HS256') {
      return { algorithm, secret: custom.secret ?? secret, ...base }
    }
    else {
      if (custom.secret !== undefined && typeof custom.secret !== 'string')
        throw new AuthError('For ES256, the secret option must be a string.')
      const esSecret = custom.secret ?? secret
      return { algorithm, publicKey: custom.publicKey, secret: esSecret, ...base }
    }
  }

  async function signJWT<U extends Record<string, unknown>>(payload: U, customOptions: Partial<SignOptions> = {}): Promise<string> {
    return sign(payload, buildSignOptions(customOptions))
  }

  async function verifyJWT<U = Record<string, unknown>>(token: string, customOptions: Partial<VerifyOptions> = {}): Promise<U | null> {
    const options = buildVerifyOptions(customOptions)
    try {
      return await verify<U>(token, options)
    }
    catch {
      return null
    }
  }

  async function createSession(userId: string, data: Record<string, unknown> = {}, ttl = defaultTTL): Promise<string> {
    const payload = { sub: userId, ...data }
    return signJWT(payload, { ttl })
  }

  async function validateSession(token: string): Promise<GauSession | null> {
    const payload = await verifyJWT<{ sub: string } & Record<string, unknown>>(token)
    if (!payload)
      return null

    const userAndAccounts = await adapter.getUserAndAccounts(payload.sub)
    if (!userAndAccounts)
      return null

    const { user, accounts } = userAndAccounts
    const isAdmin = Boolean(
      user
      && (
        (user.role && resolvedRoles.adminRoles.includes(user.role))
        || (resolvedRoles.adminUserIds.length > 0 && resolvedRoles.adminUserIds.includes(user.id))
      ),
    )
    const sessionUser = user ? { ...user, isAdmin } : null

    return { user: sessionUser, session: { id: token, ...payload }, accounts }
  }

  async function getAccessToken(userId: string, providerId: string) {
    const provider = providerMap.get(providerId)
    if (!provider)
      return null

    const accounts = await adapter.getAccounts(userId)
    const account = accounts.find(a => a.provider === providerId)
    if (!account || !account.accessToken)
      return null

    const now = Math.floor(Date.now() / 1000)
    const isExpired = typeof account.expiresAt === 'number' ? account.expiresAt <= now : false

    if (!isExpired)
      return { accessToken: account.accessToken, expiresAt: account.expiresAt ?? null }

    if (!account.refreshToken || !provider.refreshAccessToken)
      return null

    try {
      const refreshed = await provider.refreshAccessToken(account.refreshToken, {})
      const updated = {
        userId,
        provider: account.provider,
        providerAccountId: account.providerAccountId,
        accessToken: refreshed.accessToken ?? account.accessToken,
        refreshToken: refreshed.refreshToken ?? account.refreshToken,
        expiresAt: refreshed.expiresAt ?? null,
        idToken: refreshed.idToken ?? account.idToken ?? null,
        tokenType: refreshed.tokenType ?? account.tokenType ?? null,
        scope: refreshed.scope ?? account.scope ?? null,
      }
      await adapter.updateAccount?.(updated)
      return { accessToken: updated.accessToken!, expiresAt: updated.expiresAt }
    }
    catch {
      return null
    }
  }

  return {
    ...adapter,
    providerMap: providerMap as Map<ProviderId<TProviders[number]>, TProviders[number]>,
    basePath,
    cookieOptions,
    jwt: {
      ttl: defaultTTL,
    },
    onOAuthExchange,
    mapExternalProfile,
    onBeforeLinkAccount,
    onAfterLinkAccount,
    signJWT,
    verifyJWT,
    createSession,
    validateSession,
    getAccessToken,
    trustHosts,
    autoLink,
    allowDifferentEmails,
    profiles: resolvedProfiles,
    updateUserInfoOnLink,
    sessionStrategy,
    development: false,
    roles: resolvedRoles,
    cors: resolvedCors,
  }
}
