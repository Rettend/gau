import { BROWSER } from 'esm-env'
import { getSessionToken } from '../../client/token'

export function isTauri(): boolean {
  return BROWSER && '__TAURI_INTERNALS__' in (globalThis as any)
}

export async function signInWithTauri(
  provider: string,
  baseUrl: string,
  scheme: string = 'gau',
  redirectOverride?: string,
  profile?: string,
) {
  if (!isTauri())
    return

  const { platform } = await import('@tauri-apps/plugin-os')
  const { openUrl } = await import('@tauri-apps/plugin-opener')

  const currentPlatform = platform() // platform is NO LONGER an async function
  let redirectTo: string

  if (redirectOverride)
    redirectTo = redirectOverride
  else if (currentPlatform === 'android' || currentPlatform === 'ios')
    redirectTo = new URL(baseUrl).origin
  else
    redirectTo = `${scheme}://oauth/callback`

  const params = new URLSearchParams()
  params.set('redirectTo', redirectTo)
  if (profile)
    params.set('profile', profile)
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

export async function linkAccountWithTauri(
  provider: string,
  baseUrl: string,
  scheme: string = 'gau',
  redirectOverride?: string,
  profile?: string,
) {
  if (!isTauri())
    return

  const { platform } = await import('@tauri-apps/plugin-os')
  const { open } = await import('@tauri-apps/plugin-shell')

  const currentPlatform = platform()
  let redirectTo: string

  if (redirectOverride)
    redirectTo = redirectOverride
  else if (currentPlatform === 'android' || currentPlatform === 'ios')
    redirectTo = new URL(baseUrl).origin
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
    params.set('profile', profile)
  const linkUrl = `${baseUrl}/link/${provider}?${params.toString()}`
  await open(linkUrl)
}
