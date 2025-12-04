import type { ProfileName, ProviderIds } from '../../core'
import { BROWSER } from 'esm-env'
import { generatePKCE, getSessionToken } from '../../client/token'

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

  const { codeVerifier, codeChallenge } = await generatePKCE()
  localStorage.setItem('gau-pkce-verifier', codeVerifier)

  const params = new URLSearchParams()
  params.set('redirectTo', redirectTo)
  if (profile)
    params.set('profile', String(profile))
  params.set('code_challenge', codeChallenge)
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

export async function handleTauriDeepLink(url: string, baseUrl: string, scheme: string, onToken: (token: string) => void) {
  const parsed = new URL(url)
  const baseOrigin = resolveOrigin(baseUrl)
  if (parsed.protocol !== `${scheme}:` && (!baseOrigin || parsed.origin !== baseOrigin))
    return

  const queryParams = new URLSearchParams(parsed.search)
  const code = queryParams.get('code')
  if (code) {
    const verifier = localStorage.getItem('gau-pkce-verifier')
    if (!verifier) {
      console.error('No PKCE verifier found')
      return
    }
    localStorage.removeItem('gau-pkce-verifier')

    try {
      const res = await fetch(`${baseUrl}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, codeVerifier: verifier }),
      })
      if (res.ok) {
        const data = await res.json()
        if (data.token)
          onToken(data.token)
      }
      else {
        console.error('Failed to exchange code for token')
      }
    }
    catch (e) {
      console.error('Error exchanging code for token:', e)
    }
  }
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
