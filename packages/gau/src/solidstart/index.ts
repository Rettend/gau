import type { CreateAuthOptions, GauServerSession, GauSession, ProviderIds, RefreshSessionOptions } from '../core'
import type { OAuthProvider } from '../oauth'
import process from 'node:process'
import { createAuth, createHandler, getSessionTokenFromRequest, NULL_SESSION, REFRESHED_TOKEN_HEADER, toClientSession } from '../core'

export { REFRESHED_TOKEN_HEADER }

type AuthInstance<TProviders extends OAuthProvider<any>[]> = ReturnType<typeof createAuth<TProviders>>

/**
 * Creates GET and POST handlers for SolidStart.
 *
 * @example
 * ```ts
 * // src/routes/api/auth/[...auth].ts
 * import { SolidAuth } from '@rttnd/gau/solid-start'
 * import { authOptions } from '~/server/auth'
 *
 * export const { GET, POST } = SolidAuth(authOptions)
 * ```
 */
export function SolidAuth<const TProviders extends OAuthProvider<any>[]>(optionsOrAuth: CreateAuthOptions<TProviders> | AuthInstance<TProviders>) {
  const auth = resolveAuth(optionsOrAuth)

  auth.development = process.env.NODE_ENV === 'development'

  if (!auth.errorRedirect)
    auth.errorRedirect = '/auth/error'

  const handler = createHandler(auth)
  const solidHandler = (event: any) => handler(event.request)
  return {
    GET: solidHandler,
    POST: solidHandler,
    OPTIONS: solidHandler,
  }
}

/**
 * Creates a SolidStart-compatible getServerSession resolver to validate a session from a Request.
 * Returns full session data including access tokens - for server-side use only.
 * @internal
 */
export function createSolidStartGetServerSession<const TProviders extends OAuthProvider<any>[]>(auth: AuthInstance<TProviders>) {
  return async function getServerSessionFromRequest(
    request: Request,
  ): Promise<GauServerSession<ProviderIds<AuthInstance<TProviders>>>> {
    const { token: sessionToken } = getSessionTokenFromRequest(request)

    const providers = Array.from(auth.providerMap.keys()) as ProviderIds<AuthInstance<TProviders>>[]

    if (!sessionToken)
      return { ...NULL_SESSION, providers }

    try {
      const validated = await auth.validateSession(sessionToken)
      if (!validated)
        return { ...NULL_SESSION, providers }

      return { ...validated, providers }
    }
    catch {
      return { ...NULL_SESSION, providers }
    }
  }
}

/**
 * SolidStart middleware factory to attach `locals.getSession` and `locals.getServerSession`.
 *
 * - `getSession()` - Returns client-safe session (no tokens). Safe to serialize to browser.
 * - `getServerSession()` - Returns full session with access/refresh tokens. Server-only.
 *
 * @param pathsToPreLoad - Control eager vs lazy session loading:
 *   - `true` - Preload session on all routes
 *   - `false` - Lazy load (resolve on first `getSession()` call)
 *   - `string[]` - Preload only on specific paths
 *
 * @example
 * ```ts
 * // middleware.ts
 * export default createMiddleware({
 *   onRequest: [authMiddleware(true, auth)],
 * })
 */
export function authMiddleware<const TProviders extends OAuthProvider<any>[]>(
  pathsToPreLoad: string[] | boolean,
  optionsOrAuth: CreateAuthOptions<TProviders> | AuthInstance<TProviders>,
) {
  const auth = resolveAuth(optionsOrAuth)

  const getServerSessionFromRequest = createSolidStartGetServerSession(auth)

  return async (event: any) => {
    const url = new URL(event.request.url)
    const shouldPreload = typeof pathsToPreLoad === 'boolean'
      ? pathsToPreLoad
      : pathsToPreLoad.includes(url.pathname)

    if (shouldPreload) {
      const preloaded = await getServerSessionFromRequest(event.request)
      const clientSession = toClientSession(preloaded)
      event.locals.getSession = async () => clientSession
      event.locals.getServerSession = async () => preloaded
      return
    }

    let cachedServer: Promise<GauServerSession<ProviderIds<AuthInstance<TProviders>>>> | null = null
    let cachedClient: Promise<GauSession<ProviderIds<AuthInstance<TProviders>>>> | null = null

    event.locals.getServerSession = () => cachedServer ??= getServerSessionFromRequest(event.request)
    event.locals.getSession = () => cachedClient ??= event.locals.getServerSession().then(toClientSession)
  }
}

function resolveAuth<const TProviders extends OAuthProvider<any>[]>(
  optionsOrAuth: CreateAuthOptions<TProviders> | AuthInstance<TProviders>,
): AuthInstance<TProviders> {
  const isInstance = 'providerMap' in optionsOrAuth && 'signJWT' in optionsOrAuth
  return isInstance
    ? (optionsOrAuth as AuthInstance<TProviders>)
    : createAuth(optionsOrAuth as CreateAuthOptions<TProviders>)
}

/**
 * SolidStart middleware to automatically refresh sessions.
 * Sets the appropriate header based on how the token was provided:
 * - Cookie → Set-Cookie header
 * - Bearer token → X-Refreshed-Token header (for Tauri/mobile clients)
 *
 * @example
 * ```ts
 * // middleware.ts
 * import { authMiddleware, refreshMiddleware } from '@rttnd/gau/solidstart'
 *
 * export default createMiddleware({
 *   onRequest: [
 *     authMiddleware(true, auth),
 *     refreshMiddleware(auth, { threshold: 0.5 }),
 *   ],
 * })
 * ```
 */
export function refreshMiddleware<const TProviders extends OAuthProvider<any>[]>(
  optionsOrAuth: CreateAuthOptions<TProviders> | AuthInstance<TProviders>,
  options: RefreshSessionOptions = {},
) {
  const auth = resolveAuth(optionsOrAuth)

  return async (event: any) => {
    const refreshed = await auth.refreshSession(event.request, options)

    if (refreshed) {
      if (refreshed.source === 'cookie')
        event.response.headers.set('Set-Cookie', refreshed.cookie)
      else
        event.response.headers.set(REFRESHED_TOKEN_HEADER, refreshed.token)
    }
  }
}
