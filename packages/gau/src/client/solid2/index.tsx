import type { Accessor } from 'solid-js'
import type { JSX } from '@solidjs/web'
import type { GauSession, ProfileName, ProviderIds } from '../../core'
import { createContext, createMemo, createStore, onSettled, untrack, useContext } from 'solid-js'
import { isServer } from '@solidjs/web'
import { isTauri } from '../../runtimes/tauri'
import { createSharedAuthFlow } from '../shared/authFlow'
import { createEmptyClientSession, createSharedClientLifecycle } from '../shared/lifecycle'
import { createAuthClient } from '../vanilla'
import { installSolidStartFetchBridge } from '../solid/solidStartFetchBridge'

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

const AuthContext = createContext<AuthContextValue<any>>()

type SessionValue<TAuth = unknown> = GauSession<ProviderIds<TAuth>>
type SessionInput<TAuth = unknown> = SessionValue<TAuth> | Accessor<SessionValue<TAuth>>

interface AuthProviderState<TAuth = unknown> {
  mounted: boolean
  isRefreshing: boolean
  isReady: boolean
  clientOverride: GauSession<ProviderIds<TAuth>> | null
  clientSession: GauSession<ProviderIds<TAuth>> | null
}

interface AuthProviderProps<TAuth = unknown> {
  auth?: TAuth
  baseUrl?: string
  scheme?: string
  redirectTo?: string
  children?: JSX.Element
  /**
   * Optional session value or server-function-backed accessor for SSR support.
   * Pass a client-safe session value that matches the server HTML.
   *
   * @example
   * ```tsx
   * const [session] = createSignal(() => getSession(), { deferStream: true })
   * <Loading>
   *   <AuthProvider session={session}>
   *     {props.children}
   *   </AuthProvider>
   * </Loading>
   * ```
   */
  session?: SessionInput<TAuth>
}

function onClientReady(fn: () => void | (() => void)) {
  if (isServer)
    return

  onSettled(fn)
}

export function AuthProvider<const TAuth = unknown>(props: AuthProviderProps<TAuth>): JSX.Element {
  const scheme = untrack(() => props.scheme ?? 'gau')
  const baseUrl = untrack(() => props.baseUrl ?? '/api/auth')

  if (!isServer && isTauri())
    installSolidStartFetchBridge()

  const client = createAuthClient<TAuth>({
    baseUrl,
    scheme,
  })

  const hasExternalSession = () => props.session !== undefined

  const getExternalSession = (): SessionValue<TAuth> => {
    const external = props.session!
    return typeof external === 'function' ? external() : external
  }

  const [state, setState] = createStore<AuthProviderState<TAuth>>({
    mounted: false,
    isRefreshing: false,
    isReady: false,
    clientOverride: null,
    clientSession: null,
  })

  const fetchSession = async (): Promise<GauSession<ProviderIds<TAuth>>> => {
    if (isServer)
      return createEmptyClientSession()
    return client.refreshSession()
  }

  const setResolvedSession = (next: GauSession<ProviderIds<TAuth>>) => {
    setState((s) => {
      if (hasExternalSession())
        s.clientOverride = next
      else
        s.clientSession = next
    })
  }

  const session = createMemo<GauSession<ProviderIds<TAuth>>>(() => {
    const override = state.clientOverride
    if (override !== null)
      return override

    if (hasExternalSession()) {
      const ext = getExternalSession()
      return ext
    }

    return state.clientSession ?? createEmptyClientSession()
  })

  const isLoading = createMemo(() => {
    if (hasExternalSession())
      return false
    return !state.mounted || !state.isReady || (state.clientSession === null && state.isRefreshing)
  })

  const refetch = async () => {
    setState((s) => { s.isRefreshing = true })
    try {
      const refreshed = await fetchSession()
      setResolvedSession(refreshed)
      return refreshed
    }
    finally {
      setState((s) => { s.isRefreshing = false })
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
    onReady: () => { setState((s) => { s.isReady = true }) },
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

  const contextValue: AuthContextValue<TAuth> = {
    session,
    isLoading,
    signIn,
    linkAccount,
    unlinkAccount,
    signOut,
    refresh: async () => { await refetch() },
    fetch: client.fetch,
  }

  const provider = (
    <AuthContext value={contextValue as AuthContextValue<any>}>
      {props.children}
    </AuthContext>
  )

  onClientReady(() => {
    if (!untrack(hasExternalSession))
      setState((s) => { s.mounted = true })

    return lifecycle.mount()
  })

  return provider
}

export function useAuth<const TAuth = unknown>(): AuthContextValue<TAuth> {
  return useContext(AuthContext) as AuthContextValue<TAuth>
}

export { Protected } from './Protected'
