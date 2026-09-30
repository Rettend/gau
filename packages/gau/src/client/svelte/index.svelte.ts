import type { GauSession, ProviderIds } from '../../core'
import type { ClientAuthControls } from '../shared/clientAuth'
import { BROWSER } from 'esm-env'
import { getContext, onMount, setContext, untrack } from 'svelte'
import { createClientAuth, createEmptyClientSession } from '../shared/clientAuth'
import { createAuthClient } from '../vanilla'
import type { AuthClient } from '../vanilla'

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
  client: suppliedClient,
  replaceUrl,
}: {
  baseUrl?: string
  scheme?: string
  redirectTo?: string
  session?: GauSession<ProviderIds<TAuth>>
  client?: AuthClient<TAuth>
  replaceUrl?: (url: string) => void | Promise<void>
} = {}) {
  type CurrentSession = GauSession<ProviderIds<TAuth>>

  const client =
    suppliedClient ??
    createAuthClient<TAuth>({
      baseUrl,
      scheme,
      session: initialSession,
    })
  if (suppliedClient && initialSession) client.setSession(initialSession)

  let session: CurrentSession = $state(initialSession ?? suppliedClient?.session ?? createEmptyClientSession())
  let isLoading = $state(!initialSession && !suppliedClient)

  const auth = createClientAuth<TAuth>({
    client,
    redirectTo: defaultRedirectTo,
    setSession: (next) => {
      session = next
    },
    onReady: () => {
      isLoading = false
    },
    refreshOnMount: !initialSession && !suppliedClient,
    replaceUrl: replaceUrl ?? replaceUrlSafe,
  })

  async function replaceUrlSafe(url: string) {
    if (BROWSER) window.history.replaceState(window.history.state, '', url)
  }

  onMount(() => {
    session = client.session
    return auth.mount()
  })

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
  return {
    setSession(next: CurrentSession) {
      untrack(() => client.setSession(next))
      session = next
    },
  }
}

export function useAuth<const TAuth = unknown>(): AuthContextValue<TAuth> {
  const context = getContext<AuthContextValue<TAuth>>(AUTH_CONTEXT_KEY)
  if (!context) throw new Error('useAuth must be used within an AuthProvider')

  return context
}
