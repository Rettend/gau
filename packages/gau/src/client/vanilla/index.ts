import type { GauSession, ProfileName, ProviderIds } from '../../core'
import { isTauri } from '../../runtimes/tauri/index'
import { clearSessionToken, getSessionToken, handleRefreshedToken, storeSessionToken } from '../token'

export { clearSessionToken, getSessionToken, handleRefreshedToken, REFRESHED_TOKEN_HEADER, SESSION_TOKEN_KEY, storeSessionToken } from '../token'

export interface AuthClientOptions {
  baseUrl: string
  scheme?: string
}

type SessionListener<TAuth = unknown> = (session: GauSession<ProviderIds<TAuth>>) => void

function buildQuery(params: Record<string, string | undefined | null>): string {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '')
      q.set(k, String(v))
  }
  const s = q.toString()
  return s ? `?${s}` : ''
}

export function createAuthClient<const TAuth = unknown>({ baseUrl, scheme = 'gau' }: AuthClientOptions) {
  let currentSession: GauSession<ProviderIds<TAuth>> = { user: null, session: null, accounts: null, providers: [] }
  const listeners = new Set<SessionListener<TAuth>>()

  const notify = () => {
    for (const l of listeners)
      l(currentSession)
  }

  async function fetchSession(): Promise<GauSession<ProviderIds<TAuth>>> {
    const token = getSessionToken()
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined
    const res = await fetch(`${baseUrl}/session`, token ? { headers } : { credentials: 'include' })
    const contentType = res.headers.get('content-type')
    if (contentType?.includes('application/json'))
      return await res.json()
    return { user: null, session: null, accounts: null, providers: [] }
  }

  async function refreshSession(): Promise<GauSession<ProviderIds<TAuth>>> {
    const next = await fetchSession()
    currentSession = next
    notify()
    return next
  }

  async function applySessionToken(token: string): Promise<void> {
    try {
      storeSessionToken(token)
    }
    finally {
      await refreshSession()
    }
  }

  function onSessionChange(listener: SessionListener<TAuth>): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  async function handleRedirectCallback(replaceUrl?: (url: string) => void): Promise<boolean> {
    if (typeof window === 'undefined')
      return false

    if (window.location.hash === '#_=_') {
      const cleanUrl = window.location.pathname + window.location.search
      if (replaceUrl)
        replaceUrl(cleanUrl)
      else
        window.history.replaceState(null, '', cleanUrl)
      return false
    }

    const hash = window.location.hash?.substring(1) ?? ''
    if (!hash)
      return false

    const params = new URLSearchParams(hash)
    const token = params.get('token')
    if (!token)
      return false

    await applySessionToken(token)

    const cleanUrl = window.location.pathname + window.location.search
    if (replaceUrl)
      replaceUrl(cleanUrl)
    else
      window.history.replaceState(null, '', cleanUrl)

    return true
  }

  function makeProviderUrl<P extends ProviderIds<TAuth>, PR extends (ProfileName<TAuth, P> | string) | undefined>(provider: P, params?: { redirectTo?: string, profile?: PR }): string {
    const q = buildQuery({
      redirectTo: params?.redirectTo,
      profile: params?.profile != null ? String(params.profile) : undefined,
    })
    return `${baseUrl}/${provider}${q}`
  }

  function makeLinkUrl<P extends ProviderIds<TAuth>, PR extends (ProfileName<TAuth, P> | string) | undefined>(provider: P, params: { redirectTo?: string, profile?: PR, redirect?: 'false' | 'true' }): string {
    const q = buildQuery({
      redirectTo: params.redirectTo,
      profile: params.profile != null ? String(params.profile) : undefined,
      redirect: params.redirect,
    })
    return `${baseUrl}/link/${provider}${q}`
  }

  async function signIn<P extends ProviderIds<TAuth>, PR extends (ProfileName<TAuth, P> | string) | undefined>(provider: P, options?: { redirectTo?: string, profile?: PR }): Promise<string> {
    const url = makeProviderUrl<P, PR>(provider, options)

    if (isTauri()) {
      const { signInWithTauri } = await import('../../runtimes/tauri/index')
      await signInWithTauri<TAuth, P, PR>(provider, baseUrl, scheme, options?.redirectTo, options?.profile)
    }

    return url
  }

  async function linkAccount<P extends ProviderIds<TAuth>, PR extends (ProfileName<TAuth, P> | string) | undefined>(provider: P, options?: { redirectTo?: string, profile?: PR }): Promise<string> {
    if (isTauri()) {
      const { linkAccountWithTauri } = await import('../../runtimes/tauri/index')
      await linkAccountWithTauri<TAuth, P, PR>(provider, baseUrl, scheme, options?.redirectTo, options?.profile)
      return makeLinkUrl<P, PR>(provider, { redirectTo: options?.redirectTo, profile: options?.profile, redirect: 'false' })
    }

    const linkUrl = makeLinkUrl<P, PR>(provider, { redirectTo: options?.redirectTo, profile: options?.profile, redirect: 'false' })
    const token = getSessionToken()
    const fetchOptions: RequestInit = token ? { headers: { Authorization: `Bearer ${token}` } } : { credentials: 'include' }
    const res: Response = await fetch(linkUrl, fetchOptions)
    if (res.redirected)
      return res.url
    try {
      const data = await res.json()
      if (data?.url)
        return data.url
    }
    catch {}
    return linkUrl
  }

  async function unlinkAccount<P extends ProviderIds<TAuth>>(provider: P): Promise<boolean> {
    const token = getSessionToken()
    const fetchOptions: RequestInit = token ? { headers: { Authorization: `Bearer ${token}` } } : { credentials: 'include' }
    const res = await fetch(`${baseUrl}/unlink/${provider}`, { method: 'POST', ...fetchOptions })
    if (res.ok) {
      await refreshSession()
      return true
    }
    return false
  }

  async function signOut(): Promise<void> {
    const token = getSessionToken()
    clearSessionToken()
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined
    await fetch(`${baseUrl}/signout`, token ? { method: 'POST', headers } : { method: 'POST', credentials: 'include' })
    await refreshSession()
  }

  async function startTauriBridge(): Promise<(() => void) | void> {
    if (!isTauri())
      return

    const { startAuthBridge } = await import('../../runtimes/tauri/index')
    const cleanup = await startAuthBridge(baseUrl, scheme, async (token) => {
      await applySessionToken(token)
    })
    return cleanup
  }

  /**
   * Fetch wrapper that automatically handles authentication:
   * - Adds Authorization header if a token is stored (Tauri/mobile)
   * - Falls back to credentials: 'include' for cookie-based auth (web)
   * - Automatically stores refreshed tokens from X-Refreshed-Token header
   */
  async function authFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const token = getSessionToken()
    const headers = new Headers(init.headers)

    if (token)
      headers.set('Authorization', `Bearer ${token}`)

    const res = await globalThis.fetch(input, {
      ...init,
      headers,
      ...(!token && { credentials: 'include' as RequestCredentials }),
    })

    handleRefreshedToken(res)

    return res
  }

  return {
    get session() {
      return currentSession
    },
    fetch: authFetch,
    fetchSession,
    refreshSession,
    applySessionToken,
    handleRedirectCallback,
    onSessionChange,
    signIn,
    linkAccount,
    unlinkAccount,
    signOut,
    startTauriBridge,
  }
}
