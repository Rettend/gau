import type { Accessor, ParentProps } from 'solid-js'
import type { GauSession, ProfileName, ProviderIds } from '../../core'
import { createContext, createResource, onCleanup, onMount, untrack, useContext } from 'solid-js'
import { isServer } from 'solid-js/web'
import { NULL_SESSION } from '../../core'
import { isTauri } from '../../runtimes/tauri'
import { createAuthClient } from '../vanilla'

interface AuthContextValue<TAuth = unknown> {
  session: Accessor<GauSession<ProviderIds<TAuth>>>
  signIn: <P extends ProviderIds<TAuth>>(provider: P, options?: { redirectTo?: string, profile?: ProfileName<TAuth, P> }) => Promise<void>
  linkAccount: <P extends ProviderIds<TAuth>>(provider: P, options?: { redirectTo?: string, profile?: ProfileName<TAuth, P> }) => Promise<void>
  unlinkAccount: (provider: ProviderIds<TAuth>) => Promise<void>
  signOut: () => Promise<void>
  refresh: () => Promise<void>
}

const AuthContext = createContext<any>()

export function AuthProvider<const TAuth = unknown>(props: ParentProps & { auth?: TAuth, baseUrl?: string, scheme?: string, redirectTo?: string }) {
  const scheme = untrack(() => props.scheme ?? 'gau')
  const baseUrl = untrack(() => props.baseUrl ?? '/api/auth')

  const client = createAuthClient<TAuth>({
    baseUrl,
  })

  const fetchSession = async (): Promise<GauSession<ProviderIds<TAuth>>> => {
    if (isServer)
      return { ...NULL_SESSION, providers: [] }
    return client.refreshSession()
  }

  const [session, { refetch }] = createResource<GauSession<ProviderIds<TAuth>>>(
    fetchSession,
    { initialValue: { ...NULL_SESSION, providers: [] } },
  )

  async function signIn<P extends ProviderIds<TAuth>>(provider: P, { redirectTo, profile }: { redirectTo?: string, profile?: ProfileName<TAuth, P> } = {}) {
    let finalRedirectTo = redirectTo ?? props.redirectTo
    if (!finalRedirectTo && !isServer)
      finalRedirectTo = window.location.origin

    if (!isServer && isTauri()) {
      const { signInWithTauri } = await import('../../runtimes/tauri')
      await signInWithTauri<TAuth, P, typeof profile>(provider, baseUrl, scheme, finalRedirectTo, profile)
      return
    }

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
      refetch()
    else
      console.error('Failed to unlink account')
  }

  const signOut = async () => {
    await client.signOut()
    refetch()
  }

  onMount(() => {
    if (!isTauri()) {
      void (async () => {
        const handled = await client.handleRedirectCallback()
        if (handled)
          refetch()
      })()
      return
    }

    let disposed = false
    void (async () => {
      const { startAuthBridge } = await import('../../runtimes/tauri')
      const unlisten = await startAuthBridge(baseUrl, scheme, async (token) => {
        await client.applySessionToken(token)
        refetch()
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
    <AuthContext.Provider value={{ session, signIn, linkAccount, unlinkAccount, signOut, refresh: async () => { await refetch() } }}>
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
