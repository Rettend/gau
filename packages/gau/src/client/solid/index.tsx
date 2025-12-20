import type { Accessor, ParentProps, Resource } from 'solid-js'
import type { GauSession, ProfileName, ProviderIds } from '../../core'
import { createContext, createMemo, createResource, createSignal, onCleanup, onMount, untrack, useContext } from 'solid-js'
import { isServer } from 'solid-js/web'
import { NULL_SESSION } from '../../core'
import { isTauri } from '../../runtimes/tauri'
import { createAuthClient } from '../vanilla'

interface AuthContextValue<TAuth = unknown> {
  session: Accessor<GauSession<ProviderIds<TAuth>>>
  isLoading: Accessor<boolean>
  signIn: <P extends ProviderIds<TAuth>>(provider: P, options?: { redirectTo?: string, profile?: ProfileName<TAuth, P> }) => Promise<void>
  linkAccount: <P extends ProviderIds<TAuth>>(provider: P, options?: { redirectTo?: string, profile?: ProfileName<TAuth, P> }) => Promise<void>
  unlinkAccount: (provider: ProviderIds<TAuth>) => Promise<void>
  signOut: () => Promise<void>
  refresh: () => Promise<void>
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

  const client = createAuthClient<TAuth>({
    baseUrl,
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

  // Combined session accessor
  const session = createMemo<GauSession<ProviderIds<TAuth>>>(() => {
    // If we have a client override from a mutation, use it
    const override = clientOverride()
    if (override !== null)
      return override

    // SSR mode: use external session
    if (hasExternalSession()) {
      const ext = props.session!()
      return ext ?? { ...NULL_SESSION, providers: [] }
    }

    // CSR mode: use internal resource
    return internalSession()
  })

  const isLoading = createMemo(() => {
    if (hasExternalSession()) {
      // For Resource type from createAsync
      const s = props.session as Resource<GauSession<ProviderIds<TAuth>>> | undefined
      return s?.loading ?? false
    }
    return internalSession.loading
  })

  // Refetch function that works in both modes
  const refetch = async () => {
    if (hasExternalSession()) {
      // In SSR mode, fetch via client and set as override
      const refreshed = await client.refreshSession()
      setClientOverride(refreshed)
    }
    else {
      internalRefetch()
    }
  }

  async function signIn<P extends ProviderIds<TAuth>>(provider: P, { redirectTo, profile }: { redirectTo?: string, profile?: ProfileName<TAuth, P> } = {}) {
    const inTauri = !isServer && isTauri()
    let finalRedirectTo = redirectTo ?? props.redirectTo

    if (inTauri) {
      const { signInWithTauri } = await import('../../runtimes/tauri')
      await signInWithTauri<TAuth, P, typeof profile>(provider, baseUrl, scheme, finalRedirectTo, profile)
      return
    }

    if (!finalRedirectTo && !isServer)
      finalRedirectTo = window.location.origin

    const url = await client.signIn<P, typeof profile>(provider, { redirectTo: finalRedirectTo, profile })
    if (!isServer)
      window.location.href = url
  }

  async function linkAccount<P extends ProviderIds<TAuth>>(provider: P, { redirectTo, profile }: { redirectTo?: string, profile?: ProfileName<TAuth, P> } = {}) {
    if (!isServer && isTauri()) {
      const { linkAccountWithTauri } = await import('../../runtimes/tauri')
      await linkAccountWithTauri<TAuth, P, typeof profile>(provider, baseUrl, scheme, redirectTo, profile)
      return
    }

    let finalRedirectTo = redirectTo ?? props.redirectTo
    if (!finalRedirectTo && !isServer)
      finalRedirectTo = window.location.href

    const url = await client.linkAccount<P, typeof profile>(provider, { redirectTo: finalRedirectTo, profile })
    if (!isServer)
      window.location.href = url
  }

  async function unlinkAccount(provider: ProviderIds<TAuth>) {
    const ok = await client.unlinkAccount(provider)
    if (ok)
      await refetch()
    else
      console.error('Failed to unlink account')
  }

  const signOut = async () => {
    await client.signOut()
    await refetch()
  }

  onMount(() => {
    // For CSR-only mode: trigger the resource to fetch
    // Use untrack to avoid reactivity warning - props.session won't change after mount
    if (!untrack(hasExternalSession))
      setMounted(true)

    // Capture refetch in untrack to avoid reactivity warnings in async callbacks
    const doRefetch = untrack(() => refetch)

    if (!isTauri()) {
      void (async () => {
        const handled = await client.handleRedirectCallback()
        if (handled)
          await doRefetch()
      })()
      return
    }

    let disposed = false
    void (async () => {
      const { startAuthBridge } = await import('../../runtimes/tauri')
      const unlisten = await startAuthBridge(baseUrl, scheme, async (token) => {
        await client.applySessionToken(token)
        await doRefetch()
      })
      if (disposed)
        unlisten?.()
      else if (unlisten)
        onCleanup(() => unlisten())
    })()
    onCleanup(() => {
      disposed = true
    })
  })

  return (
    <AuthContext.Provider value={{ session, isLoading, signIn, linkAccount, unlinkAccount, signOut, refresh: refetch }}>
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
