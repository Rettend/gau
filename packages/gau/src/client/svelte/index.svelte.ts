import type { GauSession, ProfileName, ProviderIds } from '../../core'
// @ts-expect-error svelte-kit
import { replaceState } from '$app/navigation'
import { BROWSER } from 'esm-env'
import { getContext, onMount, setContext } from 'svelte'
import { NULL_SESSION } from '../../core'
import { clearSessionToken, getSessionToken, storeSessionToken } from '../token'
import { createAuthClient } from '../vanilla'

interface AuthContextValue<TAuth = unknown> {
  session: GauSession<ProviderIds<TAuth>>
  isLoading: boolean
  signIn: <P extends ProviderIds<TAuth>>(provider: P, options?: { redirectTo?: string, profile?: ProfileName<TAuth, P> }) => Promise<void>
  linkAccount: <P extends ProviderIds<TAuth>>(provider: P, options?: { redirectTo?: string, profile?: ProfileName<TAuth, P> }) => Promise<void>
  unlinkAccount: (provider: ProviderIds<TAuth>) => Promise<void>
  signOut: () => Promise<void>
  refresh: () => Promise<void>
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

  const client = createAuthClient<ProviderIds<TAuth>>({
    baseUrl,
  })

  const fetchSession = async (): Promise<CurrentSession> => {
    if (!BROWSER)
      return { ...NULL_SESSION, providers: [] }
    return client.refreshSession()
  }

  let session = $state({ ...NULL_SESSION, providers: [] } as CurrentSession)
  let isLoading = $state(true)

  async function replaceUrlSafe(url: string) {
    try {
      replaceState(url, {})
    }
    catch {
      if (BROWSER)
        window.history.replaceState(null, '', url)
    }
  }

  async function signIn<P extends ProviderIds<TAuth>>(provider: P, { redirectTo, profile }: { redirectTo?: string, profile?: ProfileName<TAuth, P> } = {}) {
    let finalRedirectTo = redirectTo ?? defaultRedirectTo
    if (!finalRedirectTo && BROWSER)
      finalRedirectTo = window.location.origin

    const isTauriEnv = BROWSER && ('__TAURI_INTERNALS__' in (globalThis as any))
    if (isTauriEnv) {
      const { signInWithTauri } = await import('../../runtimes/tauri')
      await signInWithTauri(provider as string, baseUrl, scheme, finalRedirectTo, profile as string | undefined)
      return
    }

    const url = await client.signIn(provider as string, { redirectTo: finalRedirectTo, profile: profile as string | undefined })
    if (BROWSER)
      window.location.href = url
  }

  async function linkAccount<P extends ProviderIds<TAuth>>(provider: P, { redirectTo, profile }: { redirectTo?: string, profile?: ProfileName<TAuth, P> } = {}) {
    const isTauriEnv = BROWSER && ('__TAURI_INTERNALS__' in (globalThis as any))
    if (isTauriEnv) {
      const { linkAccountWithTauri } = await import('../../runtimes/tauri')
      await linkAccountWithTauri(provider as string, baseUrl, scheme, redirectTo, profile as string | undefined)
      return
    }

    let finalRedirectTo = redirectTo ?? defaultRedirectTo
    if (!finalRedirectTo && BROWSER)
      finalRedirectTo = window.location.href

    const url = await client.linkAccount(provider as string, { redirectTo: finalRedirectTo, profile: profile as any })
    if (BROWSER)
      window.location.href = url
  }

  async function unlinkAccount(provider: ProviderIds<TAuth>) {
    const ok = await client.unlinkAccount(provider as string)
    if (ok)
      session = await fetchSession()
    else
      console.error('Failed to unlink account')
  }

  async function signOut() {
    await client.signOut()
    session = await fetchSession()
  }

  onMount(() => {
    if (!BROWSER)
      return

    if (window.location.hash === '#_=_')
      void replaceUrlSafe(window.location.pathname + window.location.search)

    const hash = new URL(window.location.href).hash.substring(1)
    const params = new URLSearchParams(hash)
    const tokenFromUrl = params.get('token')

    if (tokenFromUrl) {
      storeSessionToken(tokenFromUrl)
      void (async () => {
        await replaceUrlSafe(window.location.pathname + window.location.search)
        session = await fetchSession()
        isLoading = false
      })()
    }
    else {
      void (async () => {
        session = await fetchSession()
        isLoading = false
      })()
    }

    let cleanup: (() => void) | void
    let disposed = false

    const isTauriEnv = ('__TAURI_INTERNALS__' in (globalThis as any))
    if (!isTauriEnv)
      return

    void (async () => {
      const { setupTauriListener, handleTauriDeepLink } = await import('../../runtimes/tauri')
      const unlisten = await setupTauriListener(async (url) => {
        handleTauriDeepLink(url, baseUrl, scheme, async (token) => {
          storeSessionToken(token)
          session = await fetchSession()
        })
      })
      if (disposed)
        unlisten?.()
      else
        cleanup = unlisten
    })()

    return () => {
      disposed = true
      cleanup?.()
    }
  })

  const contextValue: AuthContextValue<TAuth> = {
    get session() {
      return session
    },
    get isLoading() {
      return isLoading
    },
    signIn,
    linkAccount,
    unlinkAccount,
    signOut,
    refresh: async () => { session = await fetchSession() },
  }

  setContext(AUTH_CONTEXT_KEY, contextValue)
}

export function useAuth<const TAuth = unknown>(): AuthContextValue<TAuth> {
  const context = getContext<AuthContextValue<TAuth>>(AUTH_CONTEXT_KEY)
  if (!context)
    throw new Error('useAuth must be used within an AuthProvider')

  return context
}
