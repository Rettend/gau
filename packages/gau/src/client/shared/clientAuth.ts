import type { GauSession, ProfileName, ProviderIds } from '../../core'
import { isTauri as detectTauri } from '../../runtimes/tauri'

const EMPTY_CLIENT_SESSION = {
  user: null,
  session: null,
  accounts: null,
} as const

type Session<TAuth = unknown> = GauSession<ProviderIds<TAuth>>

export interface ClientAuthControls<TAuth = unknown> {
  signIn: <P extends ProviderIds<TAuth>>(provider: P, options?: { redirectTo?: string, profile?: ProfileName<TAuth, P> }) => Promise<void>
  linkAccount: <P extends ProviderIds<TAuth>>(provider: P, options?: { redirectTo?: string, profile?: ProfileName<TAuth, P> }) => Promise<void>
  unlinkAccount: (provider: ProviderIds<TAuth>) => Promise<void>
  signOut: () => Promise<void>
  refresh: () => Promise<void>
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
}

interface ClientAuthClient<TAuth = unknown> {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  refreshSession: () => Promise<Session<TAuth>>
  handleRedirectCallback: (replaceUrl?: (url: string) => void | Promise<void>) => Promise<boolean>
  onSessionChange: (listener: (session: Session<TAuth>) => void) => () => void
  startTauriBridge: () => Promise<(() => void) | void>
  signIn: <P extends ProviderIds<TAuth>, PR extends (ProfileName<TAuth, P> | string) | undefined>(provider: P, options?: { redirectTo?: string, profile?: PR }) => Promise<string>
  linkAccount: <P extends ProviderIds<TAuth>, PR extends (ProfileName<TAuth, P> | string) | undefined>(provider: P, options?: { redirectTo?: string, profile?: PR }) => Promise<string>
  unlinkAccount: (provider: ProviderIds<TAuth>) => Promise<boolean>
  signOut: () => Promise<void>
}

interface BrowserAuthEnvironment {
  isBrowser: () => boolean
  isTauri: () => boolean
  origin: () => string
  href: () => string
  navigate: (url: string) => void
}

interface ClientAuthOptions<TAuth = unknown> {
  client: ClientAuthClient<TAuth>
  redirectTo?: string
  setSession: (session: Session<TAuth>) => void
  onReady?: () => void
  onRefreshing?: (refreshing: boolean) => void
  replaceUrl?: (url: string) => void | Promise<void>
  logger?: Pick<Console, 'error'>
  env?: Partial<BrowserAuthEnvironment>
}

export function createEmptyClientSession<TProviders extends string = string>(): GauSession<TProviders> {
  return { ...EMPTY_CLIENT_SESSION, providers: [] }
}

function isBrowser() {
  return typeof window !== 'undefined'
}

function createBrowserEnvironment(env: Partial<BrowserAuthEnvironment> = {}): BrowserAuthEnvironment {
  return {
    isBrowser,
    isTauri: () => isBrowser() && detectTauri(),
    origin: () => window.location.origin,
    href: () => window.location.href,
    navigate: (url) => { window.location.href = url },
    ...env,
  }
}

export function createClientAuth<const TAuth = unknown>({
  client,
  redirectTo: defaultRedirectTo,
  setSession,
  onReady,
  onRefreshing,
  replaceUrl,
  logger = console,
  env,
}: ClientAuthOptions<TAuth>): { mount: () => () => void, controls: ClientAuthControls<TAuth> } {
  const browser = createBrowserEnvironment(env)

  function resolveRedirectTo(type: 'signIn' | 'linkAccount', redirectTo?: string) {
    let next = redirectTo ?? defaultRedirectTo
    if (!next && browser.isBrowser())
      next = type === 'signIn' ? browser.origin() : browser.href()
    return next
  }

  function navigateTo(url: string) {
    if (browser.isBrowser() && !browser.isTauri())
      browser.navigate(url)
  }

  async function refresh() {
    onRefreshing?.(true)
    try {
      setSession(browser.isBrowser() ? await client.refreshSession() : createEmptyClientSession<ProviderIds<TAuth>>())
    }
    finally {
      onRefreshing?.(false)
    }
  }

  async function signIn<P extends ProviderIds<TAuth>>(provider: P, options: { redirectTo?: string, profile?: ProfileName<TAuth, P> } = {}) {
    const profile = options.profile
    const url = await client.signIn<P, typeof profile>(provider, { redirectTo: resolveRedirectTo('signIn', options.redirectTo), profile })
    navigateTo(url)
  }

  async function linkAccount<P extends ProviderIds<TAuth>>(provider: P, options: { redirectTo?: string, profile?: ProfileName<TAuth, P> } = {}) {
    const profile = options.profile
    const url = await client.linkAccount<P, typeof profile>(provider, { redirectTo: resolveRedirectTo('linkAccount', options.redirectTo), profile })
    navigateTo(url)
  }

  async function unlinkAccount(provider: ProviderIds<TAuth>) {
    const ok = await client.unlinkAccount(provider)
    if (!ok)
      logger.error('Failed to unlink account')
  }

  function mount(): () => void {
    if (!browser.isBrowser())
      return () => {}

    const unsubscribe = client.onSessionChange(setSession)
    let disposed = false
    let cleanup: (() => void) | undefined

    void (async () => {
      try {
        const handled = await client.handleRedirectCallback(replaceUrl)
        if (!handled)
          await refresh()
      }
      finally {
        if (!disposed)
          onReady?.()
      }
    })()

    if (browser.isTauri()) {
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
    controls: {
      signIn,
      linkAccount,
      unlinkAccount,
      signOut: client.signOut,
      refresh,
      fetch: client.fetch,
    },
  }
}
