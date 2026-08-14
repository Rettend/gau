import type { PrepareRequestHook } from '@solidjs/web/server-functions/client'
import { configureServerFunctionsClient } from '@solidjs/web/server-functions/client'
import { BROWSER } from 'esm-env'
import { getSessionToken, handleRefreshedToken } from '../token'

export interface ServerFunctionsOptions {
  /** @default '/_server' */
  endpoint?: string
  /** Runs after Gau adds its bearer token. */
  prepareRequest?: PrepareRequestHook
}

interface ServerFunctionsFetchState {
  endpoint: URL
  originalFetch: typeof globalThis.fetch
  wrappedFetch: typeof globalThis.fetch
}

declare global {
  interface Window {
    __GAU_SOLID2_SERVER_FUNCTIONS__?: ServerFunctionsFetchState
  }
}

/** Adds Gau bearer authentication to Solid 2 server-function requests. */
export function configureServerFunctions(options: ServerFunctionsOptions = {}): void {
  if (!BROWSER || typeof window === 'undefined')
    return

  const endpoint = new URL(options.endpoint ?? '/_server', window.location.href)
  configureServerFunctionsClient({
    endpoint: endpoint.href,
    prepareRequest(init, context) {
      const token = getSessionToken()
      let prepared = init
      if (token) {
        const headers = new Headers(init.headers)
        if (!headers.has('Authorization')) {
          headers.set('Authorization', `Bearer ${token}`)
          prepared = { ...init, headers }
        }
      }

      return options.prepareRequest?.(prepared, context) ?? prepared
    },
  })

  const installed = window.__GAU_SOLID2_SERVER_FUNCTIONS__
  if (installed) {
    installed.endpoint = endpoint
    return
  }

  const previousFetch = globalThis.fetch
  const state: ServerFunctionsFetchState = {
    endpoint,
    originalFetch: previousFetch.bind(globalThis),
    wrappedFetch: undefined as unknown as typeof globalThis.fetch,
  }
  const wrappedFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await state.originalFetch(input, init)
    if (isServerFunctionRequest(input, init, state.endpoint))
      handleRefreshedToken(response)
    return response
  }
  const compatibleFetch = wrappedFetch as unknown as typeof globalThis.fetch
  ;(compatibleFetch as any).preconnect = (previousFetch as any).preconnect?.bind(previousFetch)

  state.wrappedFetch = compatibleFetch
  window.__GAU_SOLID2_SERVER_FUNCTIONS__ = state
  globalThis.fetch = compatibleFetch
  window.fetch = compatibleFetch
}

function isServerFunctionRequest(input: RequestInfo | URL, init: RequestInit | undefined, endpoint: URL): boolean {
  try {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    if (headers.has('X-Server-Function-Id'))
      return true

    const url = input instanceof URL
      ? input
      : new URL(typeof input === 'string' ? input : input.url, window.location.href)
    return url.origin === endpoint.origin && normalizePath(url.pathname) === normalizePath(endpoint.pathname)
  }
  catch {
    return false
  }
}

function normalizePath(pathname: string): string {
  const normalized = `/${pathname}`.replace(/\/{2,}/g, '/').replace(/\/+$/, '')
  return normalized || '/'
}
