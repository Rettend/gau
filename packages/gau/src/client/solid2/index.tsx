import type { JSX } from '@solidjs/web'
import type { Accessor } from 'solid-js'
import type { GauSession, ProviderIds } from '../../core'
import type { ClientAuthControls } from '../shared/clientAuth'
import { isServer } from '@solidjs/web'
import { createContext, createMemo, createSignal, onSettled, untrack, useContext } from 'solid-js'
import { createClientAuth, createEmptyClientSession } from '../shared/clientAuth'
import { createAuthClient } from '../vanilla'

interface AuthContextValue<TAuth = unknown> extends ClientAuthControls<TAuth> {
  session: Accessor<GauSession<ProviderIds<TAuth>>>
  isLoading: Accessor<boolean>
}

const AuthContext = createContext<AuthContextValue<any>>()

type SessionValue<TAuth = unknown> = GauSession<ProviderIds<TAuth>>
type SessionInput<TAuth = unknown> = SessionValue<TAuth> | Accessor<SessionValue<TAuth>>

interface AuthProviderProps<TAuth = unknown> {
  auth?: TAuth
  baseUrl?: string
  scheme?: string
  redirectTo?: string
  children?: JSX.Element
  /**
   * Optional session value or server-function-backed accessor for SSR hydration.
   * It remains the initial source until an explicit client refresh or mutation
   * supplies a client-owned session. No redundant `/session` request is made
   * when this property is present.
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

  const client = createAuthClient<TAuth>({
    baseUrl,
    scheme,
  })

  const hasExternalSession = () => props.session !== undefined

  const getExternalSession = (): SessionValue<TAuth> => {
    const external = props.session!
    return typeof external === 'function' ? external() : external
  }

  const [mounted, setMounted] = createSignal(false)
  const [isRefreshing, setIsRefreshing] = createSignal(false)
  const [isReady, setIsReady] = createSignal(false)
  const [clientOverride, setClientOverride] = createSignal<SessionValue<TAuth> | null>(null)
  const [clientSession, setClientSession] = createSignal<SessionValue<TAuth> | null>(null)

  const setResolvedSession = (next: GauSession<ProviderIds<TAuth>>) => {
    if (hasExternalSession())
      setClientOverride(next)
    else
      setClientSession(next)
  }

  const session = createMemo<GauSession<ProviderIds<TAuth>>>(() => {
    const override = clientOverride()
    if (override !== null)
      return override

    if (hasExternalSession()) {
      const ext = getExternalSession()
      return ext
    }

    return clientSession() ?? createEmptyClientSession()
  })

  const isLoading = createMemo(() => {
    if (hasExternalSession())
      return false
    return !mounted() || !isReady() || (clientSession() === null && isRefreshing())
  })

  const auth = createClientAuth<TAuth>({
    client,
    redirectTo: untrack(() => props.redirectTo),
    refreshOnMount: !untrack(hasExternalSession),
    setSession: setResolvedSession,
    onReady: () => { setIsReady(true) },
    onRefreshing: setIsRefreshing,
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
      setMounted(true)

    return auth.mount()
  })

  return provider
}

export function useAuth<const TAuth = unknown>(): AuthContextValue<TAuth> {
  return useContext(AuthContext) as AuthContextValue<TAuth>
}

export { Protected } from './Protected'
export { configureServerFunctions } from './serverFunctions'
export type { ServerFunctionsOptions } from './serverFunctions'
