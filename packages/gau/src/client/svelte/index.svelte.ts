import type { GauSession, ProfileName, ProviderIds } from '../../core'
import { BROWSER } from 'esm-env'
import { getContext, setContext } from 'svelte'
import { NULL_SESSION } from '../../core'
import { handleTauriDeepLink, isTauri, linkAccountWithTauri, setupTauriListener, signInWithTauri } from '../../runtimes/tauri'
import { clearSessionToken, getSessionToken, storeSessionToken } from '../token'

interface AuthContextValue<TAuth = unknown> {
  session: GauSession<ProviderIds<TAuth>>
  signIn: <P extends ProviderIds<TAuth>>(provider: P, options?: { redirectTo?: string, profile?: ProfileName<TAuth, P> }) => Promise<void>
  linkAccount: <P extends ProviderIds<TAuth>>(provider: P, options?: { redirectTo?: string, profile?: ProfileName<TAuth, P> }) => Promise<void>
  unlinkAccount: (provider: ProviderIds<TAuth>) => Promise<void>
  signOut: () => Promise<void>
}

const AUTH_CONTEXT_KEY = Symbol('gau-auth')

export function createSvelteAuth<const TAuth = unknown>({
  baseUrl = '/api/auth',
  scheme = 'gau',
  redirectTo: defaultRedirectTo,
}: {
  baseUrl?: string
  scheme?: string
  redirectTo?: string
} = {}) {
  type CurrentSession = GauSession<ProviderIds<TAuth>>
  let session = $state<CurrentSession>({ ...NULL_SESSION, providers: [] })

  async function replaceUrlSafe(url: string) {
    let replaceUrl: (url: string) => void = u => window.history.replaceState(null, '', u)
    try {
      const navPath = '$' + 'app/navigation'
      const { replaceState } = await import(/* @vite-ignore */ navPath)
      replaceUrl = u => replaceState(u, {})
    }
    catch {}
    replaceUrl(url)
  }

  async function fetchSession() {
    if (!BROWSER) {
      session = { ...NULL_SESSION, providers: [] }
      return
    }

    const token = getSessionToken()
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined
    const res = await fetch(`${baseUrl}/session`, token ? { headers } : { credentials: 'include' })

    const contentType = res.headers.get('content-type')
    if (contentType?.includes('application/json')) {
      session = await res.json()
    }
    else {
      session = {
        ...NULL_SESSION,
        providers: [] as ProviderIds<TAuth>[],
      }
    }
  }

  async function signIn<P extends ProviderIds<TAuth>>(provider: P, { redirectTo, profile }: { redirectTo?: string, profile?: ProfileName<TAuth, P> } = {}) {
    let finalRedirectTo = redirectTo ?? defaultRedirectTo
    if (isTauri()) {
      await signInWithTauri(provider as string, baseUrl, scheme, finalRedirectTo, profile as string | undefined)
    }
    else {
      if (!finalRedirectTo && BROWSER)
        finalRedirectTo = window.location.origin

      const params = new URLSearchParams()
      if (finalRedirectTo)
        params.set('redirectTo', finalRedirectTo)
      if (profile)
        params.set('profile', String(profile))
      const q = params.toString()
      window.location.href = `${baseUrl}/${provider as string}${q ? `?${q}` : ''}`
    }
  }

  async function linkAccount<P extends ProviderIds<TAuth>>(provider: P, { redirectTo, profile }: { redirectTo?: string, profile?: ProfileName<TAuth, P> } = {}) {
    if (isTauri()) {
      await linkAccountWithTauri(provider as string, baseUrl, scheme, redirectTo, profile as string | undefined)
      return
    }

    let finalRedirectTo = redirectTo ?? defaultRedirectTo
    if (!finalRedirectTo && BROWSER)
      finalRedirectTo = window.location.href

    const params = new URLSearchParams()
    if (finalRedirectTo)
      params.set('redirectTo', finalRedirectTo)
    if (profile)
      params.set('profile', String(profile))
    params.set('redirect', 'false')
    const linkUrl = `${baseUrl}/link/${provider as string}?${params.toString()}`

    const token = getSessionToken()

    const fetchOptions: RequestInit = token
      ? { headers: { Authorization: `Bearer ${token}` } }
      : { credentials: 'include' }

    const res = await fetch(linkUrl, fetchOptions)
    if (res.redirected) {
      window.location.href = res.url
    }
    else {
      try {
        const data = await res.json()
        if (data.url)
          window.location.href = data.url
      }
      catch (e) {
        console.error('Failed to parse response from link endpoint', e)
      }
    }
  }

  async function unlinkAccount(provider: ProviderIds<TAuth>) {
    const token = getSessionToken()
    const fetchOptions: RequestInit = token
      ? { headers: { Authorization: `Bearer ${token}` } }
      : { credentials: 'include' }

    const res = await fetch(`${baseUrl}/unlink/${provider as string}`, {
      method: 'POST',
      ...fetchOptions,
    })

    if (res.ok)
      await fetchSession()
    else
      console.error('Failed to unlink account', await res.json())
  }

  async function signOut() {
    clearSessionToken()
    const token = getSessionToken()
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined
    await fetch(`${baseUrl}/signout`, token ? { method: 'POST', headers } : { method: 'POST', credentials: 'include' })
    await fetchSession()
  }

  if (BROWSER) {
    if (window.location.hash === '#_=_')
      void replaceUrlSafe(window.location.pathname + window.location.search)

    const hash = new URL(window.location.href).hash.substring(1)
    const params = new URLSearchParams(hash)
    const tokenFromUrl = params.get('token')

    if (tokenFromUrl) {
      storeSessionToken(tokenFromUrl)
      void (async () => {
        await replaceUrlSafe(window.location.pathname + window.location.search)
        await fetchSession()
      })()
    }
    else {
      fetchSession()
    }
  }

  $effect(() => {
    if (!BROWSER || !isTauri())
      return

    let cleanup: (() => void) | void
    let disposed = false

    setupTauriListener(async (url) => {
      handleTauriDeepLink(url, baseUrl, scheme, async (token) => {
        storeSessionToken(token)
        await fetchSession()
      })
    }).then((unlisten) => {
      if (disposed)
        unlisten?.()
      else
        cleanup = unlisten
    })

    return () => {
      disposed = true
      cleanup?.()
    }
  })

  const contextValue: AuthContextValue<TAuth> = {
    get session() {
      return session
    },
    signIn,
    linkAccount,
    unlinkAccount: unlinkAccount as (provider: ProviderIds<TAuth>) => Promise<void>,
    signOut,
  }

  setContext(AUTH_CONTEXT_KEY, contextValue)
}

export function useAuth<const TAuth = unknown>(): AuthContextValue<TAuth> {
  const context = getContext<AuthContextValue<TAuth>>(AUTH_CONTEXT_KEY)
  if (!context)
    throw new Error('useAuth must be used within an AuthProvider')

  return context
}
