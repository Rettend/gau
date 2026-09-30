import type { CreateAuthOptions, RefreshSessionOptions } from './createAuth'
import type { AuthProvider } from './providers'
import type { AuthInstance } from './serverSession'
import { createHandler } from './handler'
import { createRequestSessionCache, resolveAuth } from './serverSession'
import { REFRESHED_TOKEN_HEADER } from './index'

/** Request-scoped sessions and Fetch handlers for server-rendered applications. */
export function createWebAuth<const TProviders extends AuthProvider[]>(
  optionsOrAuth: CreateAuthOptions<TProviders> | AuthInstance<TProviders>,
  options: { development?: boolean } = {},
) {
  const auth = { ...resolveAuth(optionsOrAuth), ...options }
  const sessions = new WeakMap<Request, ReturnType<typeof createRequestSessionCache<TProviders>>>()
  function session(request: Request) {
    let cached = sessions.get(request)
    if (!cached) {
      cached = createRequestSessionCache(auth, request)
      sessions.set(request, cached)
    }
    return cached
  }
  const basePath = `/${auth.basePath.replace(/^\/+|\/+$/g, '')}`
  return {
    handle: createHandler(auth),
    getSession: (request: Request) => session(request).getSession(),
    getServerSession: (request: Request) => session(request).getServerSession(),
    async refresh<TResponse extends Pick<Response, 'body' | 'headers' | 'status' | 'statusText'>>(
      request: Request,
      next: () => TResponse | Promise<TResponse>,
      refreshOptions: RefreshSessionOptions = {},
    ): Promise<TResponse> {
      const path = new URL(request.url).pathname
      if (basePath === '/' || path === basePath || path.startsWith(`${basePath}/`)) return next()
      const refreshed = await auth.refreshSession(request, refreshOptions)
      const response = await next()
      if (!refreshed) return response
      const headers = new Headers(response.headers)
      if (refreshed.source === 'cookie') headers.append('Set-Cookie', refreshed.cookie)
      else headers.set(REFRESHED_TOKEN_HEADER, refreshed.token)
      // Marko Run brands responses with the data passed to next(). Preserve that type.
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      }) as unknown as TResponse
    },
  }
}
