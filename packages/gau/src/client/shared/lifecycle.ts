import type { GauSession, ProviderIds } from '../../core'

const EMPTY_CLIENT_SESSION = {
  user: null,
  session: null,
  accounts: null,
} as const

interface SharedLifecycleClient<TAuth = unknown> {
  onSessionChange: (listener: (session: GauSession<ProviderIds<TAuth>>) => void) => () => void
  startTauriBridge: () => Promise<(() => void) | void>
  unlinkAccount: (provider: ProviderIds<TAuth>) => Promise<boolean>
}

interface SharedLifecycleAuthFlow {
  handleRedirectCallback: () => Promise<boolean>
}

interface SharedClientLifecycleOptions<TAuth = unknown> {
  client: SharedLifecycleClient<TAuth>
  authFlow: SharedLifecycleAuthFlow
  isBrowser: boolean
  isTauri: boolean
  refresh: () => Promise<void>
  onSession: (session: GauSession<ProviderIds<TAuth>>) => void
  onReady?: () => void
  logger?: Pick<Console, 'error'>
}

export function createEmptyClientSession<TProviders extends string = string>(): GauSession<TProviders> {
  return { ...EMPTY_CLIENT_SESSION, providers: [] }
}

export function createSharedClientLifecycle<const TAuth = unknown>({
  client,
  authFlow,
  isBrowser,
  isTauri,
  refresh,
  onSession,
  onReady,
  logger = console,
}: SharedClientLifecycleOptions<TAuth>) {
  async function unlinkAccount(provider: ProviderIds<TAuth>) {
    const ok = await client.unlinkAccount(provider)
    if (!ok)
      logger.error('Failed to unlink account')
  }

  function mount(): () => void {
    if (!isBrowser)
      return () => {}

    const unsubscribe = client.onSessionChange(onSession)
    let disposed = false
    let cleanup: (() => void) | undefined

    void (async () => {
      try {
        const handled = await authFlow.handleRedirectCallback()
        if (!handled)
          await refresh()
      }
      finally {
        if (!disposed)
          onReady?.()
      }
    })()

    if (isTauri) {
      void (async () => {
        const unlisten = await client.startTauriBridge()
        if (disposed)
          unlisten?.()
        else
          cleanup = unlisten ?? undefined
      })()
    }

    return () => {
      disposed = true
      cleanup?.()
      cleanup = undefined
      unsubscribe()
    }
  }

  return {
    mount,
    unlinkAccount,
  }
}
