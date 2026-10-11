import { generatePKCE } from '../token'
import { AuthClientError, requestAuthJson } from './session'

export function createBrowserOAuthFlow(baseUrl: string) {
  const storageKey = `gau:oauth:${baseUrl}`
  return {
    async authorize(provider: string, options?: { redirectTo?: string; profile?: string }) {
      const { codeVerifier: verifier, codeChallenge: challenge } = await generatePKCE()
      window.sessionStorage.setItem(storageKey, JSON.stringify({ verifier, createdAt: Date.now() }))
      const url = new URL(`${baseUrl}/${provider}`, window.location.href)
      url.searchParams.set('code_challenge', challenge)
      url.searchParams.set('redirectTo', options?.redirectTo ?? window.location.origin)
      if (options?.profile) url.searchParams.set('profile', options.profile)
      return url.href
    },
    async complete(code: string) {
      const stored = window.sessionStorage.getItem(storageKey)
      window.sessionStorage.removeItem(storageKey)
      let proof: unknown
      try {
        proof = stored && JSON.parse(stored)
      } catch {
        throw new AuthClientError('INVALID_PROOF', baseUrl)
      }
      if (
        !proof ||
        typeof proof !== 'object' ||
        !('verifier' in proof) ||
        typeof proof.verifier !== 'string' ||
        !/^[A-Za-z0-9_-]{43,128}$/.test(proof.verifier) ||
        !('createdAt' in proof) ||
        typeof proof.createdAt !== 'number' ||
        !Number.isFinite(proof.createdAt) ||
        Date.now() - proof.createdAt > 10 * 60 * 1000 ||
        proof.createdAt > Date.now()
      )
        throw new AuthClientError('INVALID_PROOF', baseUrl)
      const result = await requestAuthJson(`${baseUrl}/token`, {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, codeVerifier: proof.verifier }),
      })
      if (
        !result ||
        typeof result !== 'object' ||
        !('token' in result) ||
        typeof result.token !== 'string' ||
        !result.token
      )
        throw new AuthClientError('INVALID_RESPONSE', `${baseUrl}/token`)
      return result.token
    },
  }
}
