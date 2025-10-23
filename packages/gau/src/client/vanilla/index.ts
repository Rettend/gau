import type { Account, Session, User } from '../../core'

export interface TokenStore {
  get: () => string | null
  set: (token: string) => void
  clear: () => void
}

export interface AuthClientOptions {
  baseUrl: string
  tokenStore: TokenStore
}

export interface GauSessionLike<TProviders extends string = string> {
  user: User | null
  session: Session | null
  accounts?: Account[] | null
  providers?: TProviders[]
}

type SessionListener = (session: GauSessionLike) => void

function buildQuery(params: Record<string, string | undefined | null>): string {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '')
      q.set(k, String(v))
  }
  const s = q.toString()
  return s ? `?${s}` : ''
}

export function createAuthClient<TProviders extends string = string>({ baseUrl, tokenStore }: AuthClientOptions) {
  let currentSession: GauSessionLike<TProviders> = { user: null, session: null, accounts: null, providers: [] }
  const listeners = new Set<SessionListener>()

  const notify = () => {
    for (const l of listeners)
      l(currentSession)
  }

  async function fetchSession(): Promise<GauSessionLike<TProviders>> {
    const token = tokenStore.get()
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined
    const res = await fetch(`${baseUrl}/session`, token ? { headers } : { credentials: 'include' })
    const contentType = res.headers.get('content-type')
    if (contentType?.includes('application/json'))
      return await res.json()
    return { user: null, session: null, accounts: null, providers: [] }
  }

  async function refreshSession(): Promise<GauSessionLike<TProviders>> {
    const next = await fetchSession()
    currentSession = next
    notify()
    return next
  }

  function onSessionChange(listener: SessionListener): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  function makeProviderUrl(provider: string, params?: { redirectTo?: string, profile?: string }): string {
    const q = buildQuery({ redirectTo: params?.redirectTo, profile: params?.profile })
    return `${baseUrl}/${provider}${q}`
  }

  function makeLinkUrl(provider: string, params: { redirectTo?: string, profile?: string, redirect?: 'false' | 'true' }): string {
    const q = buildQuery({ redirectTo: params.redirectTo, profile: params.profile, redirect: params.redirect })
    return `${baseUrl}/link/${provider}${q}`
  }

  async function signIn(provider: string, options?: { redirectTo?: string, profile?: string }): Promise<string> {
    const url = makeProviderUrl(provider, options)
    return url
  }

  async function linkAccount(provider: string, options?: { redirectTo?: string, profile?: string }): Promise<string> {
    const linkUrl = makeLinkUrl(provider, { redirectTo: options?.redirectTo, profile: options?.profile, redirect: 'false' })
    const token = tokenStore.get()
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

  async function unlinkAccount(provider: string): Promise<boolean> {
    const token = tokenStore.get()
    const fetchOptions: RequestInit = token ? { headers: { Authorization: `Bearer ${token}` } } : { credentials: 'include' }
    const res = await fetch(`${baseUrl}/unlink/${provider}`, { method: 'POST', ...fetchOptions })
    if (res.ok) {
      await refreshSession()
      return true
    }
    return false
  }

  async function signOut(): Promise<void> {
    tokenStore.clear()
    const token = tokenStore.get()
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined
    await fetch(`${baseUrl}/signout`, token ? { method: 'POST', headers } : { method: 'POST', credentials: 'include' })
    await refreshSession()
  }

  return {
    get session() {
      return currentSession
    },
    fetchSession,
    refreshSession,
    onSessionChange,
    signIn,
    linkAccount,
    unlinkAccount,
    signOut,
  }
}
