import type { Handle, RequestEvent } from '@sveltejs/kit'
import type { CreateAuthOptions, GauSession, ProviderIds, RefreshSessionOptions } from '../core'
import type { OAuthProvider } from '../oauth'
import { createAuth, createHandler, getSessionTokenFromRequest, NULL_SESSION, REFRESHED_TOKEN_HEADER } from '../core'

export { REFRESHED_TOKEN_HEADER }

type AuthInstance<TProviders extends OAuthProvider<any>[]> = ReturnType<typeof createAuth<TProviders>>

/**
 * Creates GET and POST handlers for SvelteKit.
 *
 * @example
 * ```ts
 * // src/routes/api/auth/[...gau]/+server.ts
 * import { SvelteKitAuth } from '@rttnd/gau/sveltekit'
 * import { auth } from '$lib/server/auth'
 *
 * export const { GET, POST } = SvelteKitAuth(auth)
 * ```
 */
export function SvelteKitAuth<const TProviders extends OAuthProvider<any>[]>(optionsOrAuth: CreateAuthOptions<TProviders> | AuthInstance<TProviders>) {
  // TODO: Duck-type to check if we have an instance or raw options
  const isInstance = 'providerMap' in optionsOrAuth && 'signJWT' in optionsOrAuth

  const auth = isInstance
    ? (optionsOrAuth as AuthInstance<TProviders>)
    : createAuth(optionsOrAuth as CreateAuthOptions<TProviders>)

  void (async () => {
    try {
      auth.development = (await import('$app/environment')).dev
    }
    catch {
      auth.development = false
    }
  })()

  const handler = createHandler(auth)
  const sveltekitHandler = (event: RequestEvent) => handler(event.request)

  const handle: Handle = async ({ event, resolve }) => {
    let cached: Promise<GauSession<ProviderIds<AuthInstance<TProviders>>>> | null = null;

    (event.locals as any).getSession = (): Promise<GauSession<ProviderIds<AuthInstance<TProviders>>>> => {
      return cached ??= (async () => {
        const { token: sessionToken } = getSessionTokenFromRequest(event.request)

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
      })()
    }
    return resolve(event)
  }

  return {
    GET: sveltekitHandler,
    POST: sveltekitHandler,
    OPTIONS: sveltekitHandler,
    handle,
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
 * Creates a SvelteKit handle that automatically refreshes sessions.
 * Sets the appropriate header based on how the token was provided:
 * - Cookie → Set-Cookie header
 * - Bearer token → X-Refreshed-Token header (for Tauri/mobile clients)
 *
 * @example
 * ```ts
 * // hooks.server.ts
 * import { sequence } from '@sveltejs/kit/hooks'
 * import { handle as authHandle } from './routes/api/auth/[...gau]/+server'
 * import { createRefreshHandle } from '@rttnd/gau/sveltekit'
 * import { auth } from '$lib/server/auth'
 *
 * export const handle = sequence(authHandle, createRefreshHandle(auth, { threshold: 0.5 }))
 * ```
 */
export function createRefreshHandle<const TProviders extends OAuthProvider<any>[]>(
  optionsOrAuth: CreateAuthOptions<TProviders> | AuthInstance<TProviders>,
  options: RefreshSessionOptions = {},
): Handle {
  const auth = resolveAuth(optionsOrAuth)

  return async ({ event, resolve }) => {
    const refreshed = await auth.refreshSession(event.request, options)

    const response = await resolve(event)

    if (refreshed) {
      if (refreshed.source === 'cookie')
        response.headers.set('Set-Cookie', refreshed.cookie)
      else
        response.headers.set(REFRESHED_TOKEN_HEADER, refreshed.token)
    }

    return response
  }
}
