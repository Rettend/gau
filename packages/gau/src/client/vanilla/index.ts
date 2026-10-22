import type { GauSession, ProfileName, ProviderIds } from '../../core'
import type { EmailOptions, EmailProviderId, EmailResult, OAuthProviderIds } from '../shared/email'
import { createEmailFlow } from '../shared/email'
import { createBrowserOAuthFlow } from '../shared/oauth'
import { AuthClientError, requestSession } from '../shared/session'
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
export { AuthClientError } from '../shared/session'

export interface AuthClientOptions<TAuth = unknown> {
  baseUrl: string
  scheme?: string
  session?: GauSession<ProviderIds<TAuth>>
  /** Omit uses bearer-only sessions and browser PKCE. Defaults to include in browsers and omit in Tauri. */
  credentials?: RequestCredentials
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
  credentials = isTauri() ? 'omit' : 'include',
}: AuthClientOptions<TAuth>) {
  const emailFlow = createEmailFlow(baseUrl)
  const oauthFlow = createBrowserOAuthFlow(baseUrl)
  let sessionLoaded = session !== undefined
  let currentSession: GauSession<ProviderIds<TAuth>> = session ?? {
    user: null,
    session: null,
    accounts: null,
    providers: [],
  }
  let revision = 0
  // Session reads must not cancel an in-flight OAuth exchange.
  let authRevision = 0
  let currentSessionError: unknown | null = null
  const listeners = new Set<SessionListener<TAuth>>()
  const errorListeners = new Set<(error: unknown | null) => void>()

  function reportSessionError(error: unknown | null) {
    currentSessionError = error
    for (const listener of errorListeners) listener(error)
  }

  function requestCredentials(token: string | null): RequestInit {
    return {
      credentials: token ? 'omit' : credentials,
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
    }
  }

  const notify = () => {
    for (const l of listeners) l(currentSession)
  }

  async function fetchSession(): Promise<GauSession<ProviderIds<TAuth>>> {
    const token = getSessionToken()
    const { session } = await requestSession<ProviderIds<TAuth>>(`${baseUrl}/session`, requestCredentials(token))
    return session
  }

  async function refreshSession(): Promise<GauSession<ProviderIds<TAuth>>> {
    const started = ++revision
    const token = getSessionToken()
    try {
      const { session: next, rejected } = await requestSession<ProviderIds<TAuth>>(
        `${baseUrl}/session`,
        requestCredentials(token),
      )
      if (started !== revision || getSessionToken() !== token) return currentSession
      if (rejected && token) clearSessionToken()
      currentSession = next
      sessionLoaded = true
      reportSessionError(null)
      notify()
      return next
    } catch (error) {
      if (started === revision && getSessionToken() === token) reportSessionError(error)
      throw error
    }
  }

  async function applySessionToken(token: string): Promise<void> {
    authRevision++
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
    const search = new URLSearchParams(window.location.search)
    const code = (credentials === 'omit' || getSessionToken()) && !isTauri() ? search.get('code') : null
    const token = new URLSearchParams(window.location.hash?.substring(1)).get('token')
    if (!code && !token && window.location.hash !== '#_=_') return false
    if (code) search.delete('code')
    const cleanUrl =
      window.location.pathname +
      (code ? (search.size ? `?${search}` : '') : window.location.search) +
      (code ? window.location.hash : '')
    if (replaceUrl) replaceUrl(cleanUrl)
    else window.history.replaceState(null, '', cleanUrl)
    if (!code && !token) return false
    revision++
    const started = ++authRevision
    try {
      const sessionToken = code ? await oauthFlow.complete(code) : token!
      if (started !== authRevision) return false
      await applySessionToken(sessionToken)
    } catch (error) {
      if (started === authRevision) reportSessionError(error)
      throw error
    }
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
      credentials: token ? 'omit' : credentials,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(
        starting
          ? {
              ...options,
              clientChallenge: proof!.clientChallenge,
              session: credentials === 'omit' ? 'token' : 'cookie',
            }
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
    } else if (credentials === 'omit' && typeof window !== 'undefined') {
      return oauthFlow.authorize(provider, {
        ...options,
        profile: options?.profile == null ? undefined : String(options.profile),
      })
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

    let linkUrl = makeLinkUrl<P, PR>(provider, {
      redirectTo: options?.redirectTo,
      profile: options?.profile,
      redirect: 'false',
    })
    const token = getSessionToken()
    if (token && typeof window !== 'undefined') {
      const url = new URL(await oauthFlow.authorize(`link/${provider}`, {
        ...options,
        redirectTo: options?.redirectTo ?? window.location.href,
        profile: options?.profile == null ? undefined : String(options.profile),
      }))
      url.searchParams.set('redirect', 'false')
      linkUrl = url.href
    }
    const fetchOptions = requestCredentials(token)
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
    const fetchOptions = requestCredentials(token)
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
    revision++
    const started = ++authRevision
    currentSession = { user: null, session: null, accounts: null, providers: currentSession.providers }
    reportSessionError(null)
    notify()
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined
    try {
      const response = await fetch(`${baseUrl}/signout`, {
        method: 'POST',
        credentials,
        ...(headers ? { headers } : {}),
      })
      if (!response.ok) throw new AuthClientError('HTTP_ERROR', `${baseUrl}/signout`, response.status)
    } finally {
      if (started === authRevision) await refreshSession()
    }
  }

  async function startTauriBridge(): Promise<(() => void) | void> {
    if (!isTauri()) return

    const { setupTauriListener, handleTauriDeepLink } = await import('../../runtimes/tauri/index')
    const cleanup = await setupTauriListener(async (url) => {
      const started = authRevision
      await handleTauriDeepLink(url, baseUrl, scheme, (token) => {
        if (started === authRevision) return applySessionToken(token)
      })
    })
    return cleanup
  }

  /**
   * Fetch wrapper that automatically handles authentication:
   * - Adds Authorization header if a token is stored (Tauri/mobile)
   * - Uses the configured credentials when no bearer token is stored
   * - Automatically stores refreshed tokens from X-Refreshed-Token header
   */
  async function authFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const token = getSessionToken()
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined))

    if (token) headers.set('Authorization', `Bearer ${token}`)

    const res = await globalThis.fetch(input, {
      ...init,
      headers,
      credentials: token ? 'omit' : (init.credentials ?? credentials),
    })

    if (token && getSessionToken() === token) handleRefreshedToken(res)

    return res
  }

  return {
    /** Apply fresh server data after navigation. This does not authenticate a request. */
    setSession(session: GauSession<ProviderIds<TAuth>>) {
      revision++
      currentSession = session
      sessionLoaded = true
      reportSessionError(null)
      notify()
    },
    get session() {
      return currentSession
    },
    get sessionError() {
      return currentSessionError
    },
    get sessionLoaded() {
      return sessionLoaded
    },
    onSessionError(listener: (error: unknown | null) => void) {
      errorListeners.add(listener)
      return () => errorListeners.delete(listener)
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
