import type { ProfileName, ProviderIds } from '../../core'
import { BROWSER } from 'esm-env'
import { getSessionToken } from '../../client/token'

export function isTauri(): boolean {
  return BROWSER && '__TAURI_INTERNALS__' in globalThis
}

function resolveOrigin(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).origin
  }
  catch {
    if (BROWSER && typeof window !== 'undefined') {
      try {
        return new URL(baseUrl, window.location.origin).origin
      }
      catch {
        return null
      }
    }
    return null
  }
}

export async function signInWithTauri<const TAuth = unknown, P extends ProviderIds<TAuth> = ProviderIds<TAuth>, PR extends (ProfileName<TAuth, P> | string) | undefined = undefined>(
  provider: P,
  baseUrl: string,
  scheme: string = 'gau',
  redirectOverride?: string,
  profile?: PR,
) {
  if (!isTauri())
    return

  const { openUrl } = await import('@tauri-apps/plugin-opener')

  function resolveAbsoluteBase(base: string): string {
    try {
      const u = new URL(base)
      return u.toString().replace(/\/$/, '')
    }
    catch {
      if (BROWSER && typeof window !== 'undefined') {
        try {
          const u = new URL(base, window.location.origin)
          return u.toString().replace(/\/$/, '')
        }
        catch {
          return base
        }
      }
      return base
    }
  }

  let redirectTo: string

  if (redirectOverride)
    redirectTo = redirectOverride
  else
    redirectTo = `${scheme}://oauth/callback`

  const params = new URLSearchParams()
  params.set('redirectTo', redirectTo)
  if (profile)
    params.set('profile', String(profile))
  const resolvedBase = resolveAbsoluteBase(baseUrl)
  const authUrl = `${resolvedBase}/${provider}?${params.toString()}`
  await openUrl(authUrl)
}

export async function setupTauriListener(
  handler: (url: string) => Promise<void>,
): Promise<(() => void) | void> {
  if (!isTauri())
    return

  const { listen } = await import('@tauri-apps/api/event')
  try {
    const unlisten = await listen<string>('deep-link', async (event) => {
      await handler(event.payload)
    })
    return unlisten
  }
  catch (err) {
    console.error(err)
  }
}

export function handleTauriDeepLink(url: string, baseUrl: string, scheme: string, onToken: (token: string) => void) {
  const parsed = new URL(url)
  const baseOrigin = resolveOrigin(baseUrl)
  if (parsed.protocol !== `${scheme}:` && (!baseOrigin || parsed.origin !== baseOrigin))
    return

  const params = new URLSearchParams(parsed.hash.substring(1))
  const token = params.get('token')
  if (token)
    onToken(token)
}

export async function linkAccountWithTauri<const TAuth = unknown, P extends ProviderIds<TAuth> = ProviderIds<TAuth>, PR extends (ProfileName<TAuth, P> | string) | undefined = undefined>(
  provider: P,
  baseUrl: string,
  scheme: string = 'gau',
  redirectOverride?: string,
  profile?: PR,
) {
  if (!isTauri())
    return

  const { openUrl } = await import('@tauri-apps/plugin-opener')

  let redirectTo: string

  if (redirectOverride)
    redirectTo = redirectOverride
  else
    redirectTo = `${scheme}://oauth/callback`

  const token = getSessionToken()
  if (!token) {
    console.error('No session token found, cannot link account.')
    return
  }

  const params = new URLSearchParams()
  params.set('redirectTo', redirectTo)
  params.set('token', token)
  if (profile)
    params.set('profile', String(profile))
  const resolvedBase = (() => {
    try {
      const u = new URL(baseUrl)
      return u.toString().replace(/\/$/, '')
    }
    catch {
      if (BROWSER && typeof window !== 'undefined') {
        try {
          const u = new URL(baseUrl, window.location.origin)
          return u.toString().replace(/\/$/, '')
        }
        catch {
          return baseUrl
        }
      }
      return baseUrl
    }
  })()
  const linkUrl = `${resolvedBase}/link/${provider}?${params.toString()}`
  await openUrl(linkUrl)
}

export async function startAuthBridge(
  baseUrl: string,
  scheme: string,
  onToken: (token: string) => Promise<void> | void,
): Promise<(() => void) | void> {
  if (!isTauri())
    return

  const unlisten = await setupTauriListener(async (url) => {
    handleTauriDeepLink(url, baseUrl, scheme, onToken)
  })
  return unlisten
}
