import { BROWSER } from 'esm-env'
import { getSessionToken, handleRefreshedToken } from '../token'

declare global {
  interface Window {
    __GAU_SOLIDSTART_FETCH_BRIDGE_INSTALLED__?: boolean
  }
}

/**
 * In SolidStart, query/action server functions call `/_server` through global fetch.
 * In Tauri token mode this bridge injects Authorization and captures refreshed tokens.
 */
export function installSolidStartFetchBridge(options: { serverBaseUrl?: string } = {}): void {
  if (!BROWSER || typeof window === 'undefined')
    return
  if (window.__GAU_SOLIDSTART_FETCH_BRIDGE_INSTALLED__)
    return

  window.__GAU_SOLIDSTART_FETCH_BRIDGE_INSTALLED__ = true

  const originalFetch = globalThis.fetch.bind(globalThis)
  const serverFunctionTarget = resolveServerFunctionTarget(options.serverBaseUrl)

  const wrappedFetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const requestUrl = resolveRequestUrl(input)
    if (!requestUrl || !isSolidStartServerFunctionRequest(requestUrl, serverFunctionTarget))
      return originalFetch(input, init)

    const headers = mergeHeaders(input, init)
    if (!headers.has('Authorization')) {
      const token = getSessionToken()
      if (token)
        headers.set('Authorization', `Bearer ${token}`)
    }

    const response = await originalFetch(input, {
      ...init,
      headers,
    })

    handleRefreshedToken(response)
    return response
  }

  const wrappedFetchWithBunCompat = wrappedFetch as unknown as typeof globalThis.fetch
  ;(wrappedFetchWithBunCompat as any).preconnect = (originalFetch as any).preconnect?.bind(originalFetch)

  globalThis.fetch = wrappedFetchWithBunCompat
  window.fetch = wrappedFetchWithBunCompat
}

interface ServerFunctionTarget {
  origin: string
  path: string
}

function resolveServerFunctionTarget(serverBaseUrl?: string): ServerFunctionTarget {
  const envBase = serverBaseUrl ?? (((import.meta as any)?.env?.SERVER_BASE_URL ?? '') as string)
  const trimmed = envBase.trim()

  if (!trimmed || trimmed === '/') {
    return {
      origin: window.location.origin,
      path: '/_server',
    }
  }

  try {
    const baseUrl = new URL(trimmed, window.location.origin)
    const basePath = normalizePath(baseUrl.pathname)
    const serverPath = basePath === '/'
      ? '/_server'
      : `${basePath}/_server`

    return {
      origin: baseUrl.origin,
      path: normalizePath(serverPath),
    }
  }
  catch {
    return {
      origin: window.location.origin,
      path: '/_server',
    }
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

function mergeHeaders(input: RequestInfo | URL, init: RequestInit): Headers {
  const headers = new Headers()

  if (input instanceof Request) {
    input.headers.forEach((value, key) => {
      headers.set(key, value)
    })
  }

  if (init.headers) {
    new Headers(init.headers).forEach((value, key) => {
      headers.set(key, value)
    })
  }

  return headers
}

function isSolidStartServerFunctionRequest(requestUrl: URL, target: ServerFunctionTarget): boolean {
  if (requestUrl.origin !== target.origin)
    return false

  return normalizePath(requestUrl.pathname) === target.path
}

function normalizePath(pathname: string): string {
  if (!pathname)
    return '/'

  const normalized = pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '')
  return normalized || '/'
}
