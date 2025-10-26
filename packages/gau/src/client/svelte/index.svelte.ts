import type { GauSession, ProfileName, ProviderIds } from '../../core'
// @ts-expect-error svelte-kit
import { replaceState } from '$app/navigation'
import { BROWSER } from 'esm-env'
import { getContext, onMount, setContext } from 'svelte'
import { NULL_SESSION } from '../../core'
import { isTauri } from '../../runtimes/tauri'
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

  const client = createAuthClient<TAuth>({
    baseUrl,
  })

  const fetchSession = async (): Promise<CurrentSession> => {
    if (!BROWSER)
      return { ...NULL_SESSION, providers: [] }
    return client.refreshSession()
  }

  let session: CurrentSession = $state({ ...NULL_SESSION, providers: [] })
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
    const inTauri = isTauri()
    let finalRedirectTo = redirectTo ?? defaultRedirectTo

    if (inTauri) {
      const { signInWithTauri } = await import('../../runtimes/tauri')
      await signInWithTauri<TAuth, P, typeof profile>(provider, baseUrl, scheme, finalRedirectTo, profile)
      return
    }

    if (!finalRedirectTo && BROWSER)
      finalRedirectTo = window.location.origin

    const url = await client.signIn<P, typeof profile>(provider, { redirectTo: finalRedirectTo, profile })
    if (BROWSER)
      window.location.href = url
  }

  async function linkAccount<P extends ProviderIds<TAuth>>(provider: P, { redirectTo, profile }: { redirectTo?: string, profile?: ProfileName<TAuth, P> } = {}) {
    if (isTauri()) {
      const { linkAccountWithTauri } = await import('../../runtimes/tauri')
      await linkAccountWithTauri<TAuth, P, typeof profile>(provider, baseUrl, scheme, redirectTo, profile)
      return
    }

    let finalRedirectTo = redirectTo ?? defaultRedirectTo
    if (!finalRedirectTo && BROWSER)
      finalRedirectTo = window.location.href

    const url = await client.linkAccount<P, typeof profile>(provider, { redirectTo: finalRedirectTo, profile })
    if (BROWSER)
      window.location.href = url
  }

  async function unlinkAccount(provider: ProviderIds<TAuth>) {
    const ok = await client.unlinkAccount(provider)
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

    void (async () => {
      const handled = await client.handleRedirectCallback(async url => replaceUrlSafe(url))
      if (!handled)
        session = await fetchSession()

      isLoading = false
    })()

    let cleanup: (() => void) | void
    let disposed = false

    if (!isTauri())
      return

    void (async () => {
      const { startAuthBridge } = await import('../../runtimes/tauri')
      const unlisten = await startAuthBridge(baseUrl, scheme, async (token) => {
        await client.applySessionToken(token)
        session = await fetchSession()
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
