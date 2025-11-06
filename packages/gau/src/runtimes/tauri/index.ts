import type { ProfileName, ProviderIds } from '../../core'
import { BROWSER } from 'esm-env'
import { getSessionToken } from '../../client/token'

export function isTauri(): boolean {
  return BROWSER && '__TAURI_INTERNALS__' in globalThis
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

  const { platform } = await import('@tauri-apps/plugin-os')
  const { openUrl } = await import('@tauri-apps/plugin-opener')

  const currentPlatform = platform() // platform is NO LONGER an async function
  let redirectTo: string

  if (redirectOverride) {
    redirectTo = redirectOverride
  }
  else if (currentPlatform === 'android' || currentPlatform === 'ios') {
    // Use HTTPS deep link for mobile with a specific callback path
    const baseOrigin = new URL(baseUrl).origin
    redirectTo = `${baseOrigin}/auth/mobile/callback`
  }
  else {
    redirectTo = `${scheme}://oauth/callback`
  }

  const params = new URLSearchParams()
  params.set('redirectTo', redirectTo)
  // Add mobile flag to help server detect mobile requests
  if (currentPlatform === 'android' || currentPlatform === 'ios')
    params.set('mobile', 'true')
  if (profile)
    params.set('profile', String(profile))
  const authUrl = `${baseUrl}/${provider}?${params.toString()}`
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
  if (parsed.protocol !== `${scheme}:` && parsed.origin !== new URL(baseUrl).origin)
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

  const { platform } = await import('@tauri-apps/plugin-os')
  const { openUrl } = await import('@tauri-apps/plugin-opener')

  const currentPlatform = platform()
  let redirectTo: string

  if (redirectOverride) {
    redirectTo = redirectOverride
  }
  else if (currentPlatform === 'android' || currentPlatform === 'ios') {
    // Use HTTPS deep link for mobile with a specific callback path
    const baseOrigin = new URL(baseUrl).origin
    redirectTo = `${baseOrigin}/auth/mobile/callback`
  }
  else {
    redirectTo = `${scheme}://oauth/callback`
  }

  const token = getSessionToken()
  if (!token) {
    console.error('No session token found, cannot link account.')
    return
  }

  const params = new URLSearchParams()
  params.set('redirectTo', redirectTo)
  params.set('token', token)
  // Add mobile flag to help server detect mobile requests
  if (currentPlatform === 'android' || currentPlatform === 'ios')
    params.set('mobile', 'true')
  if (profile)
    params.set('profile', String(profile))
  const linkUrl = `${baseUrl}/link/${provider}?${params.toString()}`
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
