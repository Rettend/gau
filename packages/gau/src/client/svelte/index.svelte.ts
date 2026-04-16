import type { GauSession, ProfileName, ProviderIds } from '../../core'
// @ts-expect-error svelte-kit
import { replaceState } from '$app/navigation'
import { BROWSER } from 'esm-env'
import { getContext, onMount, setContext } from 'svelte'
import { isTauri } from '../../runtimes/tauri'
import { createSharedAuthFlow } from '../shared/authFlow'
import { createEmptyClientSession, createSharedClientLifecycle } from '../shared/lifecycle'
import { createAuthClient } from '../vanilla'

interface AuthContextValue<TAuth = unknown> {
  session: GauSession<ProviderIds<TAuth>>
  isLoading: boolean
  signIn: <P extends ProviderIds<TAuth>>(provider: P, options?: { redirectTo?: string, profile?: ProfileName<TAuth, P> }) => Promise<void>
  linkAccount: <P extends ProviderIds<TAuth>>(provider: P, options?: { redirectTo?: string, profile?: ProfileName<TAuth, P> }) => Promise<void>
  unlinkAccount: (provider: ProviderIds<TAuth>) => Promise<void>
  signOut: () => Promise<void>
  refresh: () => Promise<void>
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
}

const AUTH_CONTEXT_KEY = Symbol('gau-auth')

export function createSvelteAuth<const TAuth = unknown>({
  baseUrl = '/api/auth',
  scheme = 'gau',
  redirectTo: defaultRedirectTo,
  session: initialSession,
}: {
  baseUrl?: string
  scheme?: string
  redirectTo?: string
  session?: GauSession<ProviderIds<TAuth>>
} = {}) {
  type CurrentSession = GauSession<ProviderIds<TAuth>>

  const client = createAuthClient<TAuth>({
    baseUrl,
    scheme,
  })

  const fetchSession = async (): Promise<CurrentSession> => {
    if (!BROWSER)
      return createEmptyClientSession()
    return client.refreshSession()
  }

  let session: CurrentSession = $state(initialSession ?? createEmptyClientSession())
  let isLoading = $state(!initialSession)

  const authFlow = createSharedAuthFlow<TAuth>({
    client,
    defaultRedirectTo,
    isBrowser: BROWSER,
    isTauri: BROWSER && isTauri(),
    getOrigin: () => window.location.origin,
    getHref: () => window.location.href,
    navigate: (url) => { window.location.href = url },
    replaceUrl: url => replaceUrlSafe(url),
  })

  const lifecycle = createSharedClientLifecycle<TAuth>({
    client,
    authFlow,
    isBrowser: BROWSER,
    isTauri: BROWSER && isTauri(),
    refresh: async () => { session = await fetchSession() },
    onSession: next => { session = next },
    onReady: () => { isLoading = false },
  })

  async function replaceUrlSafe(url: string) {
    try {
      replaceState(url, {})
    }
    catch {
      if (BROWSER)
        window.history.replaceState(null, '', url)
    }
  }

  async function signIn<P extends ProviderIds<TAuth>>(provider: P, options: { redirectTo?: string, profile?: ProfileName<TAuth, P> } = {}) {
    await authFlow.signIn(provider, options)
  }

  async function linkAccount<P extends ProviderIds<TAuth>>(provider: P, options: { redirectTo?: string, profile?: ProfileName<TAuth, P> } = {}) {
    await authFlow.linkAccount(provider, options)
  }

  async function unlinkAccount(provider: ProviderIds<TAuth>) {
    await lifecycle.unlinkAccount(provider)
  }

  async function signOut() {
    await client.signOut()
  }

  onMount(() => lifecycle.mount())

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
    fetch: client.fetch,
  }

  setContext(AUTH_CONTEXT_KEY, contextValue)
}

export function useAuth<const TAuth = unknown>(): AuthContextValue<TAuth> {
  const context = getContext<AuthContextValue<TAuth>>(AUTH_CONTEXT_KEY)
  if (!context)
    throw new Error('useAuth must be used within an AuthProvider')

  return context
}
