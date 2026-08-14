import { BROWSER } from 'esm-env'
import { getSessionToken, handleRefreshedToken } from '../token'

interface ServerFunctionEndpoint {
  protocol: string
  host: string
  path: string
  url: URL
}

interface SolidStartFetchBridgeState {
  source: ServerFunctionEndpoint
  destination: ServerFunctionEndpoint | null
  originalFetch: typeof globalThis.fetch
  wrappedFetch: typeof globalThis.fetch
}

interface SolidStartFetchBridgeOptions {
  /**
   * SolidStart server-function base URL. Defaults to Vite's
   * `SERVER_BASE_URL` and is independent from Gau's auth base URL.
   */
  serverBaseUrl?: string
  /** Overrides Vite's BASE_URL for tests and custom SolidStart runtimes. */
  applicationBaseUrl?: string
}

declare global {
  interface Window {
    __GAU_SOLIDSTART_FETCH_BRIDGE__?: SolidStartFetchBridgeState
  }
}

/**
 * Adds Tauri bearer authentication to legacy SolidStart server functions.
 */
export function installSolidStartFetchBridge(options: SolidStartFetchBridgeOptions = {}): void {
  if (!BROWSER || typeof window === 'undefined')
    return

  const applicationBaseUrl = options.applicationBaseUrl
    ?? (((import.meta as any).env.BASE_URL ?? '/') as string)
  const serverBaseUrl = options.serverBaseUrl
    ?? (((import.meta as any).env.SERVER_BASE_URL ?? '') as string)
  const source = resolveServerFunctionEndpoint(applicationBaseUrl, window.location.href)
  const destination = resolveDestination(serverBaseUrl)
  const installed = window.__GAU_SOLIDSTART_FETCH_BRIDGE__

  if (installed) {
    if (!isSameEndpoint(installed.source, source))
      throw new Error('SolidStart fetch bridge is already installed for a different application base URL.')

    if (installed.destination && destination && !isSameEndpoint(installed.destination, destination))
      throw new Error('SolidStart fetch bridge is already installed with a different server base URL.')

    if (!installed.destination && destination)
      installed.destination = destination

    return
  }

  const previousFetch = globalThis.fetch
  const state: SolidStartFetchBridgeState = {
    source,
    destination,
    originalFetch: previousFetch.bind(globalThis),
    wrappedFetch: undefined as unknown as typeof globalThis.fetch,
  }

  const wrappedFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = resolveRequestUrl(input)
    if (!requestUrl)
      return state.originalFetch(input, init)

    const matchesSource = isServerFunctionRequest(requestUrl, state.source)
    const matchesDestination = state.destination
      ? isServerFunctionRequest(requestUrl, state.destination)
      : false

    if (!matchesSource && !matchesDestination)
      return state.originalFetch(input, init)

    const targetUrl = matchesSource && state.destination
      ? rewriteRequestUrl(requestUrl, state.destination)
      : requestUrl
    const request = createRequest(input, init, targetUrl)
    const headers = new Headers(request.headers)

    if (!headers.has('Authorization')) {
      const token = getSessionToken()
      if (token)
        headers.set('Authorization', `Bearer ${token}`)
    }

    const response = await state.originalFetch(new Request(request, { headers }))
    handleRefreshedToken(response)
    return response
  }

  const wrappedFetchWithBunCompat = wrappedFetch as unknown as typeof globalThis.fetch
  ;(wrappedFetchWithBunCompat as any).preconnect = (previousFetch as any).preconnect?.bind(previousFetch)

  state.wrappedFetch = wrappedFetchWithBunCompat
  window.__GAU_SOLIDSTART_FETCH_BRIDGE__ = state
  globalThis.fetch = wrappedFetchWithBunCompat
  window.fetch = wrappedFetchWithBunCompat
}

function resolveDestination(serverBaseUrl: string): ServerFunctionEndpoint | null {
  const trimmed = serverBaseUrl.trim()
  if (!trimmed)
    return null

  try {
    const url = new URL(trimmed, window.location.origin)
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      return null

    return resolveServerFunctionEndpoint(url.href, window.location.href)
  }
  catch {
    return null
  }
}

function resolveServerFunctionEndpoint(baseUrl: string, fallbackUrl: string): ServerFunctionEndpoint {
  let url: URL
  try {
    url = new URL(baseUrl, fallbackUrl)
  }
  catch {
    throw new Error(`Invalid SolidStart server functions base URL: ${baseUrl}`)
  }

  const basePath = normalizePath(url.pathname)
  url.pathname = basePath === '/' ? '/_server' : `${basePath}/_server`
  url.search = ''
  url.hash = ''

  return {
    protocol: url.protocol,
    host: url.host,
    path: normalizePath(url.pathname),
    url,
  }
}

function resolveRequestUrl(input: RequestInfo | URL): URL | null {
  try {
    if (input instanceof URL)
      return input
    if (typeof input === 'string')
      return new URL(input, window.location.href)
    return new URL(input.url, window.location.href)
  }
  catch {
    return null
  }
}

function createRequest(input: RequestInfo | URL, init: RequestInit | undefined, targetUrl: URL): Request {
  const request = input instanceof Request
    ? new Request(input, init)
    : new Request(resolveRequestUrl(input)!, init)

  if (request.url === targetUrl.href)
    return request

  return new Request(targetUrl, request)
}

function rewriteRequestUrl(requestUrl: URL, destination: ServerFunctionEndpoint): URL {
  const rewritten = new URL(destination.url)
  rewritten.search = requestUrl.search
  rewritten.hash = requestUrl.hash
  return rewritten
}

function isServerFunctionRequest(requestUrl: URL, endpoint: ServerFunctionEndpoint): boolean {
  return requestUrl.protocol === endpoint.protocol
    && requestUrl.host === endpoint.host
    && normalizePath(requestUrl.pathname) === endpoint.path
}

function isSameEndpoint(left: ServerFunctionEndpoint, right: ServerFunctionEndpoint): boolean {
  return left.protocol === right.protocol
    && left.host === right.host
    && left.path === right.path
}

function normalizePath(pathname: string): string {
  if (!pathname)
    return '/'

  const normalized = pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '')
  return normalized || '/'
}
