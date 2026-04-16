import type { Accessor, ParentProps, Resource } from 'solid-js'
import type { GauSession, ProfileName, ProviderIds } from '../../core'
import { createContext, createMemo, createSignal, onCleanup, onMount, untrack, useContext } from 'solid-js'
import { isServer } from 'solid-js/web'
import { isTauri } from '../../runtimes/tauri'
import { createSharedAuthFlow } from '../shared/authFlow'
import { createEmptyClientSession, createSharedClientLifecycle } from '../shared/lifecycle'
import { createAuthClient } from '../vanilla'
import { installSolidStartFetchBridge } from './solidStartFetchBridge'

interface AuthContextValue<TAuth = unknown> {
  session: Accessor<GauSession<ProviderIds<TAuth>>>
  isLoading: Accessor<boolean>
  signIn: <P extends ProviderIds<TAuth>>(provider: P, options?: { redirectTo?: string, profile?: ProfileName<TAuth, P> }) => Promise<void>
  linkAccount: <P extends ProviderIds<TAuth>>(provider: P, options?: { redirectTo?: string, profile?: ProfileName<TAuth, P> }) => Promise<void>
  unlinkAccount: (provider: ProviderIds<TAuth>) => Promise<void>
  signOut: () => Promise<void>
  refresh: () => Promise<void>
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
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

  const fetchSession = async (): Promise<GauSession<ProviderIds<TAuth>>> => {
    if (isServer)
      return createEmptyClientSession()
    return client.refreshSession()
  }

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

  // Refetch function that works in both modes
  const refetch = async () => {
    setIsRefreshing(true)
    try {
      const refreshed = await fetchSession()
      setResolvedSession(refreshed)
      return refreshed
    }
    finally {
      setIsRefreshing(false)
    }
  }

  const authFlow = createSharedAuthFlow<TAuth>({
    client,
    defaultRedirectTo: props.redirectTo,
    isBrowser: !isServer,
    isTauri: !isServer && isTauri(),
    getOrigin: () => window.location.origin,
    getHref: () => window.location.href,
    navigate: (url) => { window.location.href = url },
  })

  const lifecycle = createSharedClientLifecycle<TAuth>({
    client,
    authFlow,
    isBrowser: !isServer,
    isTauri: !isServer && isTauri(),
    refresh: async () => { await refetch() },
    onSession: next => { setResolvedSession(next) },
    onReady: () => { setIsReady(true) },
  })

  async function signIn<P extends ProviderIds<TAuth>>(provider: P, options: { redirectTo?: string, profile?: ProfileName<TAuth, P> } = {}) {
    await authFlow.signIn(provider, options)
  }

  async function linkAccount<P extends ProviderIds<TAuth>>(provider: P, options: { redirectTo?: string, profile?: ProfileName<TAuth, P> } = {}) {
    await authFlow.linkAccount(provider, options)
  }

  async function unlinkAccount(provider: ProviderIds<TAuth>) {
    await lifecycle.unlinkAccount(provider)
  }

  const signOut = async () => {
    await client.signOut()
  }

  onMount(() => {
    // For CSR-only mode: trigger the resource to fetch
    // Use untrack to avoid reactivity warning - props.session won't change after mount
    if (!untrack(hasExternalSession))
      setMounted(true)

    onCleanup(lifecycle.mount())
  })

  return (
    <AuthContext.Provider value={{ session, isLoading, signIn, linkAccount, unlinkAccount, signOut, refresh: async () => { await refetch() }, fetch: client.fetch }}>
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
