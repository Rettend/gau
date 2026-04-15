import type { Accessor, ParentProps, Resource } from 'solid-js'
import type { GauSession, ProfileName, ProviderIds } from '../../core'
import { createContext, createMemo, createResource, createSignal, onCleanup, onMount, untrack, useContext } from 'solid-js'
import { isServer } from 'solid-js/web'
import { NULL_SESSION } from '../../core'
import { isTauri } from '../../runtimes/tauri'
import { createSharedAuthFlow } from '../shared/authFlow'
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

  // Internal resource for CSR-only mode
  const fetchSession = async (isMounted: boolean): Promise<GauSession<ProviderIds<TAuth>>> => {
    if (isServer || !isMounted)
      return { ...NULL_SESSION, providers: [] }
    return client.refreshSession()
  }

  const [internalSession, { refetch: internalRefetch }] = createResource<GauSession<ProviderIds<TAuth>>, boolean>(
    mounted,
    fetchSession,
    { initialValue: { ...NULL_SESSION, providers: [] } },
  )

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
      return clientOverride() ?? ext ?? { ...NULL_SESSION, providers: [] }
    }

    // CSR mode: use internal resource
    return clientSession() ?? internalSession()
  })

  const isLoading = createMemo(() => {
    if (hasExternalSession()) {
      // For Resource type from createAsync
      const s = props.session as Resource<GauSession<ProviderIds<TAuth>>> | undefined
      return s?.loading ?? false
    }
    return !mounted() || (clientSession() === null && internalSession.loading)
  })

  // Refetch function that works in both modes
  const refetch = async () => {
    const refreshed = hasExternalSession()
      ? await client.refreshSession()
      : await internalRefetch()

    if (refreshed)
      setResolvedSession(refreshed)

    return refreshed
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

  async function signIn<P extends ProviderIds<TAuth>>(provider: P, options: { redirectTo?: string, profile?: ProfileName<TAuth, P> } = {}) {
    await authFlow.signIn(provider, options)
  }

  async function linkAccount<P extends ProviderIds<TAuth>>(provider: P, options: { redirectTo?: string, profile?: ProfileName<TAuth, P> } = {}) {
    await authFlow.linkAccount(provider, options)
  }

  async function unlinkAccount(provider: ProviderIds<TAuth>) {
    const ok = await client.unlinkAccount(provider)
    if (!ok)
      console.error('Failed to unlink account')
  }

  const signOut = async () => {
    await client.signOut()
  }

  onMount(() => {
    // For CSR-only mode: trigger the resource to fetch
    // Use untrack to avoid reactivity warning - props.session won't change after mount
    if (!untrack(hasExternalSession))
      setMounted(true)

    const unsubscribe = client.onSessionChange((next) => {
      setResolvedSession(next)
    })

    if (!isTauri()) {
      void authFlow.handleRedirectCallback()
      onCleanup(unsubscribe)
      return
    }

    let disposed = false
    let unlisten: (() => void) | undefined
    void (async () => {
      const maybeUnlisten = await client.startTauriBridge()
      if (disposed)
        maybeUnlisten?.()
      else
        unlisten = maybeUnlisten ?? undefined
    })()
    onCleanup(() => {
      disposed = true
      unsubscribe()
      unlisten?.()
      unlisten = undefined
    })
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
