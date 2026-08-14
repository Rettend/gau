import type { Accessor, ParentProps, Resource } from 'solid-js'
import type { GauSession, ProviderIds } from '../../core'
import type { ClientAuthControls } from '../shared/clientAuth'
import { createContext, createMemo, createSignal, onCleanup, onMount, untrack, useContext } from 'solid-js'
import { isServer } from 'solid-js/web'
import { isTauri } from '../../runtimes/tauri'
import { createClientAuth, createEmptyClientSession } from '../shared/clientAuth'
import { installSolidStartFetchBridge } from '../shared/solidStartFetchBridge'
import { createAuthClient } from '../vanilla'

interface AuthContextValue<TAuth = unknown> extends ClientAuthControls<TAuth> {
  session: Accessor<GauSession<ProviderIds<TAuth>>>
  isLoading: Accessor<boolean>
}

const AuthContext = createContext<any>()

interface AuthProviderProps<TAuth = unknown> extends ParentProps {
  auth?: TAuth
  baseUrl?: string
  scheme?: string
  redirectTo?: string
  /**
   * Optional session accessor from `createAsync()` for SSR support.
   * When provided, the session is fetched server-side and serialized into HTML.
   *
   * @example
   * ```tsx
   * const session = createAsync(() => getSession())
   * <AuthProvider session={session}>
   * ```
   */
  session?: Accessor<GauSession<ProviderIds<TAuth>> | undefined> | Resource<GauSession<ProviderIds<TAuth>>>
}

export function AuthProvider<const TAuth = unknown>(props: AuthProviderProps<TAuth>) {
  const scheme = untrack(() => props.scheme ?? 'gau')
  const baseUrl = untrack(() => props.baseUrl ?? '/api/auth')

  if (!isServer && isTauri())
    installSolidStartFetchBridge()

  const client = createAuthClient<TAuth>({
    baseUrl,
    scheme,
  })

  // Check if we're in SSR mode (session prop provided)
  const hasExternalSession = () => props.session !== undefined

  // For CSR-only mode: signal to trigger client-side refetch after hydration
  const [mounted, setMounted] = createSignal(false)
  const [isRefreshing, setIsRefreshing] = createSignal(false)
  const [isReady, setIsReady] = createSignal(false)

  // For SSR mode: track refreshed session after client-side mutations
  const [clientOverride, setClientOverride] = createSignal<GauSession<ProviderIds<TAuth>> | null>(null)
  const [clientSession, setClientSession] = createSignal<GauSession<ProviderIds<TAuth>> | null>(null)

  const setResolvedSession = (next: GauSession<ProviderIds<TAuth>>) => {
    if (hasExternalSession())
      setClientOverride(next)
    else
      setClientSession(next)
  }

  // Combined session accessor
  const session = createMemo<GauSession<ProviderIds<TAuth>>>(() => {
    // If we have a client override from a mutation, use it
    const override = clientOverride()
    if (override !== null)
      return override

    // SSR mode: use external session
    if (hasExternalSession()) {
      const ext = props.session!()
      return clientOverride() ?? ext ?? createEmptyClientSession()
    }

    // CSR mode: use client-managed session state
    return clientSession() ?? createEmptyClientSession()
  })

  const isLoading = createMemo(() => {
    if (hasExternalSession()) {
      // For Resource type from createAsync
      const s = props.session as Resource<GauSession<ProviderIds<TAuth>>> | undefined
      return s?.loading ?? false
    }
    return !mounted() || !isReady() || (clientSession() === null && isRefreshing())
  })

  const auth = createClientAuth<TAuth>({
    client,
    redirectTo: untrack(() => props.redirectTo),
    setSession: setResolvedSession,
    onReady: () => { setIsReady(true) },
    onRefreshing: (refreshing) => { setIsRefreshing(refreshing) },
  })

  onMount(() => {
    // For CSR-only mode: trigger the resource to fetch
    // Use untrack to avoid reactivity warning - props.session won't change after mount
    if (!untrack(hasExternalSession))
      setMounted(true)

    onCleanup(auth.mount())
  })

  return (
    <AuthContext.Provider value={{ session, isLoading, ...auth.controls }}>
      {props.children}
    </AuthContext.Provider>
  )
}

export function useAuth<const TAuth = unknown>(): AuthContextValue<TAuth> {
  const context = useContext(AuthContext)
  if (!context)
    throw new Error('useAuth must be used within an AuthProvider')
  return context as AuthContextValue<TAuth>
}

export { Protected } from './Protected'
