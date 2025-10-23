import type { Accessor, ParentProps } from 'solid-js'
import type { GauSession, ProfileName, ProviderIds } from '../../core'
import { createContext, createResource, onCleanup, onMount, untrack, useContext } from 'solid-js'
import { isServer } from 'solid-js/web'
import { NULL_SESSION } from '../../core'
import { clearSessionToken, getSessionToken, storeSessionToken } from '../token'
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

  const client = createAuthClient<ProviderIds<TAuth>>({
    baseUrl,
    tokenStore: {
      get: () => getSessionToken(),
      set: t => storeSessionToken(t),
      clear: () => clearSessionToken(),
    },
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

    const isTauriEnv = !isServer && ('__TAURI_INTERNALS__' in (globalThis as any))
    if (isTauriEnv) {
      const { signInWithTauri } = await import('../../runtimes/tauri')
      await signInWithTauri(provider as string, baseUrl, scheme, finalRedirectTo, profile as string | undefined)
      return
    }

    const url = await client.signIn(provider as string, { redirectTo: finalRedirectTo, profile: profile as string | undefined })
    if (!isServer)
      window.location.href = url
  }

  async function linkAccount<P extends ProviderIds<TAuth>>(provider: P, { redirectTo, profile }: { redirectTo?: string, profile?: ProfileName<TAuth, P> } = {}) {
    const isTauriEnv = !isServer && ('__TAURI_INTERNALS__' in (globalThis as any))
    if (isTauriEnv) {
      const { linkAccountWithTauri } = await import('../../runtimes/tauri')
      await linkAccountWithTauri(provider as string, baseUrl, scheme, redirectTo, profile as string | undefined)
      return
    }

    let finalRedirectTo = redirectTo ?? props.redirectTo
    if (!finalRedirectTo && !isServer)
      finalRedirectTo = window.location.href

    const url = await client.linkAccount(provider as string, { redirectTo: finalRedirectTo, profile: profile as any })
    if (!isServer)
      window.location.href = url
  }

  async function unlinkAccount(provider: ProviderIds<TAuth>) {
    const ok = await client.unlinkAccount(provider as string)
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
    if (!('__TAURI_INTERNALS__' in (globalThis as any))) {
      if (window.location.hash === '#_=_')
        window.history.replaceState(null, '', window.location.pathname + window.location.search)

      const hash = new URL(window.location.href).hash.substring(1)
      const params = new URLSearchParams(hash)
      const tokenParam = params.get('token')
      if (tokenParam) {
        storeSessionToken(tokenParam)
        refetch()
        window.history.replaceState(null, '', window.location.pathname + window.location.search)
      }
    }

    if (!('__TAURI_INTERNALS__' in (globalThis as any)))
      return

    let disposed = false
    void (async () => {
      const { setupTauriListener, handleTauriDeepLink } = await import('../../runtimes/tauri')
      const unlisten = await setupTauriListener(async (url) => {
        handleTauriDeepLink(url, baseUrl, scheme, (token) => {
          storeSessionToken(token)
          refetch()
        })
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
