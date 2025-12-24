import { BROWSER } from 'esm-env'

export const SESSION_TOKEN_KEY = '__gau-session-token'

export const REFRESHED_TOKEN_HEADER = 'X-Refreshed-Token'

export function storeSessionToken(token: string) {
  if (!BROWSER)
    return
  try {
    localStorage.setItem(SESSION_TOKEN_KEY, token)
  }
  catch {}
}

export function getSessionToken(): string | null {
  if (!BROWSER)
    return null
  try {
    return localStorage.getItem(SESSION_TOKEN_KEY)
  }
  catch {
    return null
  }
}

export function clearSessionToken() {
  if (!BROWSER)
    return
  try {
    localStorage.removeItem(SESSION_TOKEN_KEY)
  }
  catch {}
}

export function handleRefreshedToken(response: Response): void {
  if (!BROWSER)
    return
  const refreshed = response.headers.get(REFRESHED_TOKEN_HEADER)
  if (refreshed)
    storeSessionToken(refreshed)
}

export async function generatePKCE() {
  if (!BROWSER || !window.crypto || !window.crypto.subtle)
    throw new Error('PKCE relies on window.crypto, which is not available in this environment.')

  function base64UrlEncode(array: Uint8Array): string {
    return btoa(String.fromCharCode(...array))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
  }

  const verifierLength = 43
  const randomValues = new Uint8Array(verifierLength)
  window.crypto.getRandomValues(randomValues)
  const codeVerifier = base64UrlEncode(randomValues)

  const encoder = new TextEncoder()
  const data = encoder.encode(codeVerifier)
  const hash = await window.crypto.subtle.digest('SHA-256', data)
  const codeChallenge = base64UrlEncode(new Uint8Array(hash))

  return { codeVerifier, codeChallenge }
}
