import type { CreateAuthOptions, GauServerSession, GauSession, ProviderIds, RefreshSessionOptions } from '../core'
import type { AuthInstance } from '../core/serverSession'
import type { OAuthProvider } from '../oauth'
import type { RequestEvent, ResponseStub } from '@solidjs/web'
import { getRequestEvent } from '@solidjs/web'
import { DEV } from 'esm-env'
import { createHandler, REFRESHED_TOKEN_HEADER } from '../core'
import { createRequestSessionCache, resolveAuth } from '../core/serverSession'

export { REFRESHED_TOKEN_HEADER }

export interface Solid2APIEvent {
  request: Request
  params?: Record<string, string>
  [key: string]: unknown
}

export type Solid2MiddlewareNext = (request?: Request) => Response | Promise<Response>
export type Solid2Middleware = (request: Request, next: Solid2MiddlewareNext) => Response | Promise<Response>

/** Request-local Gau session helpers suitable for `@solidjs/web` augmentation. */
export interface GauSolid2Locals<TAuth = unknown> {
  /** Client-safe session. This value may be serialized. */
  getSession: () => Promise<GauSession<ProviderIds<TAuth>>>
  /** Sensitive server session, including linked-account tokens. Never serialize it. */
  getServerSession: () => Promise<GauServerSession<ProviderIds<TAuth>>>
}

/**
 * Creates filesystem-routing-compatible handlers for Gau's Fetch API.
 * The supplied auth instance is never mutated.
 */
export function SolidAuth<const TProviders extends OAuthProvider<any>[]>(
  optionsOrAuth: CreateAuthOptions<TProviders> | AuthInstance<TProviders>,
) {
  const auth = resolveAuth(optionsOrAuth)
  const handler = createHandler({ ...auth, development: DEV })
  const solidHandler = (event: Solid2APIEvent) => handler(event.request)

  return {
    GET: solidHandler,
    POST: solidHandler,
    OPTIONS: solidHandler,
  }
}

/** Attaches memoized, request-local safe and sensitive session resolvers. */
export function authMiddleware<const TProviders extends OAuthProvider<any>[]>(
  optionsOrAuth: CreateAuthOptions<TProviders> | AuthInstance<TProviders>,
): Solid2Middleware {
  const auth = resolveAuth(optionsOrAuth)

  return (request, next) => {
    const event = getRequestEvent()
    if (!event)
      throw new Error('Gau Solid 2 auth middleware requires an active @solidjs/web request event.')

    const session = createRequestSessionCache(auth, request)
    const locals = event.locals as GauSolid2Locals<AuthInstance<TProviders>>
    locals.getSession = session.getSession
    locals.getServerSession = session.getServerSession
    return next()
  }
}

/**
 * Refreshes Gau sessions around the downstream Fetch handler.
 * Auth API requests are skipped so refresh cannot overwrite callback or
 * signout cookies produced by Gau's handler.
 */
export function refreshMiddleware<const TProviders extends OAuthProvider<any>[]>(
  optionsOrAuth: CreateAuthOptions<TProviders> | AuthInstance<TProviders>,
  options: RefreshSessionOptions = {},
): Solid2Middleware {
  const auth = resolveAuth(optionsOrAuth)

  return async (request, next) => {
    if (isAuthPath(new URL(request.url).pathname, auth.basePath))
      return next()

    const event = getRequestEvent() as EventWithResponse | undefined
    const refreshed = await auth.refreshSession(request, options)
    const response = await next()
    if (!refreshed)
      return response

    const name = refreshed.source === 'cookie' ? 'Set-Cookie' : REFRESHED_TOKEN_HEADER
    const value = refreshed.source === 'cookie' ? refreshed.cookie : refreshed.token
    const append = refreshed.source === 'cookie'

    if (event?.response && !event.response.committed) {
      if (append)
        event.response.headers.append(name, value)
      else
        event.response.headers.set(name, value)
      return response
    }

    return writeResponseHeader(response, name, value, append)
  }
}

type EventWithResponse = RequestEvent & { response?: ResponseStub }

function isAuthPath(pathname: string, configuredBasePath: string): boolean {
  const basePath = configuredBasePath === '/'
    ? '/'
    : `/${configuredBasePath.replace(/^\/+|\/+$/g, '')}`
  return basePath === '/'
    || pathname === basePath
    || pathname.startsWith(`${basePath}/`)
}

function writeResponseHeader(response: Response, name: string, value: string, append: boolean): Response {
  try {
    if (append)
      response.headers.append(name, value)
    else
      response.headers.set(name, value)
    return response
  }
  catch {
    const headers = new Headers(response.headers)
    if (append)
      headers.append(name, value)
    else
      headers.set(name, value)
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }
}
