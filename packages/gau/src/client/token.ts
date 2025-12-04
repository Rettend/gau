import { BROWSER } from 'esm-env'

export function storeSessionToken(token: string) {
  if (!BROWSER)
    return
  try {
    localStorage.setItem('gau-token', token)
    document.cookie = `__gau-session-token=${token}; path=/; max-age=31536000; samesite=lax; secure`
  }
  catch {}
}

export function getSessionToken(): string | null {
  if (!BROWSER)
    return null
  return localStorage.getItem('gau-token')
}

export function clearSessionToken() {
  if (!BROWSER)
    return
  try {
    localStorage.removeItem('gau-token')
    document.cookie = `__gau-session-token=; path=/; max-age=0`
  }
  catch {}
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
