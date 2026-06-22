import type { Accessor } from 'solid-js'
import type { JSX } from '@solidjs/web'
import type { GauSession, ProviderIds } from '../../core'
import type { ClientAuthControls } from '../shared/clientAuth'
import { createContext, createMemo, createStore, onSettled, untrack, useContext } from 'solid-js'
import { isServer } from '@solidjs/web'
import { isTauri } from '../../runtimes/tauri'
import { createClientAuth, createEmptyClientSession } from '../shared/clientAuth'
import { createAuthClient } from '../vanilla'
import { installSolidStartFetchBridge } from '../solid/solidStartFetchBridge'

interface AuthContextValue<TAuth = unknown> extends ClientAuthControls<TAuth> {
  session: Accessor<GauSession<ProviderIds<TAuth>>>
  isLoading: Accessor<boolean>
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

  const auth = createClientAuth<TAuth>({
    client,
    redirectTo: props.redirectTo,
    setSession: setResolvedSession,
    onReady: () => { setState((s) => { s.isReady = true }) },
    onRefreshing: refreshing => { setState((s) => { s.isRefreshing = refreshing }) },
  })

  const contextValue: AuthContextValue<TAuth> = {
    session,
    isLoading,
    ...auth.controls,
  }

  const provider = (
    <AuthContext value={contextValue as AuthContextValue<any>}>
      {props.children}
    </AuthContext>
  )

  onClientReady(() => {
    if (!untrack(hasExternalSession))
      setState((s) => { s.mounted = true })

    return auth.mount()
  })

  return provider
}

export function useAuth<const TAuth = unknown>(): AuthContextValue<TAuth> {
  return useContext(AuthContext) as AuthContextValue<TAuth>
}

export { Protected } from './Protected'
