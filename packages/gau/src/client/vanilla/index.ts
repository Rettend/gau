import type { GauSession, ProfileName, ProviderIds } from '../../core'
import type { EmailOptions, EmailProviderId, EmailResult, OAuthProviderIds } from '../shared/email'
import { createEmailFlow } from '../shared/email'
import { isTauri } from '../../runtimes/tauri/index'
import { clearSessionToken, getSessionToken, handleRefreshedToken, storeSessionToken } from '../token'

export {
  clearSessionToken,
  getSessionToken,
  handleRefreshedToken,
  REFRESHED_TOKEN_HEADER,
  SESSION_TOKEN_KEY,
  storeSessionToken,
} from '../token'
export type {
  EmailStartOptions,
  EmailVerifyOptions,
  EmailChallengeResult,
  EmailAuthenticatedResult,
} from '../shared/email'

export interface AuthClientOptions<TAuth = unknown> {
  baseUrl: string
  scheme?: string
  session?: GauSession<ProviderIds<TAuth>>
}

type SessionListener<TAuth = unknown> = (session: GauSession<ProviderIds<TAuth>>) => void

function buildQuery(params: Record<string, string | undefined | null>): string {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') q.set(k, String(v))
  }
  const s = q.toString()
  return s ? `?${s}` : ''
}

export function createAuthClient<const TAuth = unknown>({
  baseUrl,
  scheme = 'gau',
  session,
}: AuthClientOptions<TAuth>) {
  const emailFlow = createEmailFlow(baseUrl)
  let currentSession: GauSession<ProviderIds<TAuth>> = session ?? {
    user: null,
    session: null,
    accounts: null,
    providers: [],
  }
  let revision = 0
  const listeners = new Set<SessionListener<TAuth>>()

  const notify = () => {
    for (const l of listeners) l(currentSession)
  }

  async function fetchSession(): Promise<GauSession<ProviderIds<TAuth>>> {
    const token = getSessionToken()
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined
    const res = await fetch(`${baseUrl}/session`, token ? { headers } : { credentials: 'include' })
    const contentType = res.headers.get('content-type')
    if (contentType?.includes('application/json')) return await res.json()
    return { user: null, session: null, accounts: null, providers: [] }
  }

  async function refreshSession(): Promise<GauSession<ProviderIds<TAuth>>> {
    const started = ++revision
    const next = await fetchSession()
    if (started !== revision) return currentSession
    currentSession = next
    notify()
    return next
  }

  async function applySessionToken(token: string): Promise<void> {
    try {
      storeSessionToken(token)
    } finally {
      await refreshSession()
    }
  }

  function onSessionChange(listener: SessionListener<TAuth>): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  async function handleRedirectCallback(replaceUrl?: (url: string) => void): Promise<boolean> {
    if (typeof window === 'undefined') return false

    if (window.location.hash === '#_=_') {
      const cleanUrl = window.location.pathname + window.location.search
      if (replaceUrl) replaceUrl(cleanUrl)
      else window.history.replaceState(null, '', cleanUrl)
      return false
    }

    const hash = window.location.hash?.substring(1) ?? ''
    if (!hash) return false

    const params = new URLSearchParams(hash)
    const token = params.get('token')
    if (!token) return false

    await applySessionToken(token)

    const cleanUrl = window.location.pathname + window.location.search
    if (replaceUrl) replaceUrl(cleanUrl)
    else window.history.replaceState(null, '', cleanUrl)

    return true
  }

  function makeProviderUrl<P extends ProviderIds<TAuth>, PR extends (ProfileName<TAuth, P> | string) | undefined>(
    provider: P,
    params?: { redirectTo?: string; profile?: PR },
  ): string {
    const q = buildQuery({
      redirectTo: params?.redirectTo,
      profile: params?.profile != null ? String(params.profile) : undefined,
    })
    return `${baseUrl}/${provider}${q}`
  }

  function makeLinkUrl<P extends ProviderIds<TAuth>, PR extends (ProfileName<TAuth, P> | string) | undefined>(
    provider: P,
    params: { redirectTo?: string; profile?: PR; redirect?: 'false' | 'true' },
  ): string {
    const q = buildQuery({
      redirectTo: params.redirectTo,
      profile: params.profile != null ? String(params.profile) : undefined,
      redirect: params.redirect,
    })
    return `${baseUrl}/link/${provider}${q}`
  }

  async function emailAction(options: EmailOptions, linking: boolean) {
    const starting = typeof options.email === 'string'
    const proof = starting ? await emailFlow.start() : undefined
    const token = linking ? getSessionToken() : null
    const response = await fetch(`${baseUrl}/${linking ? 'link/' : ''}email`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(
        starting
          ? { ...options, clientChallenge: proof!.clientChallenge, session: isTauri() ? 'token' : 'cookie' }
          : { ...options, verifier: emailFlow.get(options.challengeId!) },
      ),
    })
    const result = await response.json()
    if (!response.ok)
      throw Object.assign(new Error(result.error ?? 'Email sign-in failed.'), {
        code: result.code,
        status: response.status,
      })
    if (starting) {
      emailFlow.save(result.challengeId, proof!.verifier)
    } else {
      emailFlow.clear(options.challengeId!)
      if (result.token) await applySessionToken(result.token)
      else await refreshSession()
    }
    const { token: _token, ...safeResult } = result
    return safeResult
  }

  function signIn<O extends EmailOptions>(provider: EmailProviderId<TAuth>, options: O): Promise<EmailResult<O>>
  function signIn<
    P extends OAuthProviderIds<TAuth>,
    PR extends (ProfileName<TAuth, P> | string) | undefined = undefined,
  >(provider: P, options?: { redirectTo?: string; profile?: PR }): Promise<string>
  async function signIn(
    provider: string,
    options?: EmailOptions | { redirectTo?: string; profile?: string },
  ): Promise<any> {
    if (provider === 'email') {
      if (!options || !('email' in options || 'challengeId' in options))
        throw new Error('Email sign-in requires an email address or a verification code.')
      return emailAction(options as EmailOptions, false)
    }
    return oauthSignIn(provider as ProviderIds<TAuth>, options as { redirectTo?: string; profile?: string })
  }

  async function oauthSignIn<P extends ProviderIds<TAuth>, PR extends (ProfileName<TAuth, P> | string) | undefined>(
    provider: P,
    options?: { redirectTo?: string; profile?: PR },
  ): Promise<string> {
    const url = makeProviderUrl<P, PR>(provider, options)

    if (isTauri()) {
      const { signInWithTauri } = await import('../../runtimes/tauri/index')
      await signInWithTauri<TAuth, P, PR>(provider, baseUrl, scheme, options?.redirectTo, options?.profile)
    }

    return url
  }

  function linkAccount<O extends EmailOptions>(provider: EmailProviderId<TAuth>, options: O): Promise<EmailResult<O>>
  function linkAccount<
    P extends OAuthProviderIds<TAuth>,
    PR extends (ProfileName<TAuth, P> | string) | undefined = undefined,
  >(provider: P, options?: { redirectTo?: string; profile?: PR }): Promise<string>
  async function linkAccount(
    provider: string,
    options?: EmailOptions | { redirectTo?: string; profile?: string },
  ): Promise<any> {
    if (provider === 'email') {
      if (!options || !('email' in options || 'challengeId' in options))
        throw new Error('Linking email requires an email address or a verification code.')
      return emailAction(options as EmailOptions, true)
    }
    return oauthLinkAccount(provider as ProviderIds<TAuth>, options as { redirectTo?: string; profile?: string })
  }

  async function oauthLinkAccount<
    P extends ProviderIds<TAuth>,
    PR extends (ProfileName<TAuth, P> | string) | undefined,
  >(provider: P, options?: { redirectTo?: string; profile?: PR }): Promise<string> {
    if (isTauri()) {
      const { linkAccountWithTauri } = await import('../../runtimes/tauri/index')
      await linkAccountWithTauri<TAuth, P, PR>(provider, baseUrl, scheme, options?.redirectTo, options?.profile)
      return makeLinkUrl<P, PR>(provider, {
        redirectTo: options?.redirectTo,
        profile: options?.profile,
        redirect: 'false',
      })
    }

    const linkUrl = makeLinkUrl<P, PR>(provider, {
      redirectTo: options?.redirectTo,
      profile: options?.profile,
      redirect: 'false',
    })
    const token = getSessionToken()
    const fetchOptions: RequestInit = token
      ? { headers: { Authorization: `Bearer ${token}` } }
      : { credentials: 'include' }
    const res: Response = await fetch(linkUrl, fetchOptions)
    if (res.redirected) return res.url
    try {
      const data = await res.json()
      if (data?.url) return data.url
    } catch {}
    return linkUrl
  }

  async function unlinkAccount<P extends ProviderIds<TAuth>>(provider: P): Promise<boolean> {
    const token = getSessionToken()
    const fetchOptions: RequestInit = token
      ? { headers: { Authorization: `Bearer ${token}` } }
      : { credentials: 'include' }
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
    if (!isTauri()) return

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

    if (token) headers.set('Authorization', `Bearer ${token}`)

    const res = await globalThis.fetch(input, {
      ...init,
      headers,
      ...(!token && { credentials: 'include' as RequestCredentials }),
    })

    handleRefreshedToken(res)

    return res
  }

  return {
    /** Apply fresh server data after navigation. This does not authenticate a request. */
    setSession(session: GauSession<ProviderIds<TAuth>>) {
      revision++
      currentSession = session
      notify()
    },
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

export type AuthClient<TAuth = unknown> = ReturnType<typeof createAuthClient<TAuth>>
