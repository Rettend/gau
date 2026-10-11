import type { PrepareRequestHook, ServerFunctionsClientConfig } from '@solidjs/web/server-functions/client'
import { configureServerFunctionsClient } from '@solidjs/web/server-functions/client'
import { BROWSER } from 'esm-env'
import { getSessionToken, handleRefreshedToken } from '../token'

export interface ServerFunctionsOptions {
  /** @default '/_server' */
  endpoint?: string
  /** Runs after Gau adds its bearer token. */
  prepareRequest?: PrepareRequestHook
  fetch?: ServerFunctionsClientConfig['fetch']
}

/** Adds Gau bearer authentication to Solid 2 server-function requests. */
export function configureServerFunctions(options: ServerFunctionsOptions = {}): void {
  if (!BROWSER || typeof window === 'undefined') return

  const endpoint = new URL(options.endpoint ?? '/_server', window.location.href)
  configureServerFunctionsClient({
    endpoint: endpoint.href,
    prepareRequest(init, context) {
      const token = getSessionToken()
      const headers = new Headers(init.headers)
      if (token && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`)
      const prepared = headers.has('Authorization') ? { ...init, headers, credentials: 'omit' as const } : init

      return options.prepareRequest?.(prepared, context) ?? prepared
    },
    async fetch(address, init) {
      const token = getSessionToken()
      const authenticated = token && new Headers(init.headers).get('Authorization') === `Bearer ${token}`
      const response = await (options.fetch ?? globalThis.fetch)(address, init)
      // A late response must not restore a token after signout or account switching.
      if (authenticated && getSessionToken() === token) handleRefreshedToken(response)
      return response
    },
  })
}
