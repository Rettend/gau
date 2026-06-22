import type { GauSession, ProviderIds } from '../../core'
import type { ClientAuthControls } from '../shared/clientAuth'
// @ts-expect-error svelte-kit
import { replaceState } from '$app/navigation'
import { BROWSER } from 'esm-env'
import { getContext, onMount, setContext } from 'svelte'
import { createClientAuth, createEmptyClientSession } from '../shared/clientAuth'
import { createAuthClient } from '../vanilla'

interface AuthContextValue<TAuth = unknown> extends ClientAuthControls<TAuth> {
  session: GauSession<ProviderIds<TAuth>>
  isLoading: boolean
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

  let session: CurrentSession = $state(initialSession ?? createEmptyClientSession())
  let isLoading = $state(!initialSession)

  const auth = createClientAuth<TAuth>({
    client,
    redirectTo: defaultRedirectTo,
    setSession: next => { session = next },
    onReady: () => { isLoading = false },
    replaceUrl: url => replaceUrlSafe(url),
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

  onMount(auth.mount)

  const contextValue: AuthContextValue<TAuth> = {
    get session() {
      return session
    },
    get isLoading() {
      return isLoading
    },
    ...auth.controls,
  }

  setContext(AUTH_CONTEXT_KEY, contextValue)
}

export function useAuth<const TAuth = unknown>(): AuthContextValue<TAuth> {
  const context = getContext<AuthContextValue<TAuth>>(AUTH_CONTEXT_KEY)
  if (!context)
    throw new Error('useAuth must be used within an AuthProvider')

  return context
}
