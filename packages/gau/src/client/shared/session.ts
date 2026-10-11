import type { GauSession } from '../../core'

export class AuthClientError extends Error {
  readonly endpoint: string

  constructor(
    readonly code: 'NETWORK_ERROR' | 'HTTP_ERROR' | 'INVALID_RESPONSE' | 'INVALID_SESSION' | 'INVALID_PROOF',
    url: string,
    readonly status?: number,
  ) {
    const address = new URL(url, typeof window === 'undefined' ? 'http://localhost' : window.location.href)
    const endpoint = `${address.origin}${address.pathname}`
    super(
      code === 'NETWORK_ERROR'
        ? `Cannot reach the auth backend at ${endpoint}.`
        : code === 'HTTP_ERROR'
          ? `The auth backend at ${endpoint} returned HTTP ${status}.`
          : code === 'INVALID_SESSION'
            ? `The auth backend at ${endpoint} did not return a valid session.`
            : code === 'INVALID_PROOF'
              ? 'The sign-in request expired. Start sign-in again.'
              : `The auth backend at ${endpoint} did not return a valid JSON response.`,
    )
    this.name = 'AuthClientError'
    this.endpoint = endpoint
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isSession(value: unknown): value is GauSession {
  return (
    isRecord(value) &&
    (value.user === null || (isRecord(value.user) && typeof value.user.id === 'string')) &&
    (value.session === null || (isRecord(value.session) && typeof value.session.sub === 'string')) &&
    (value.accounts == null ||
      (Array.isArray(value.accounts) &&
        value.accounts.every(
          (account) =>
            isRecord(account) && typeof account.provider === 'string' && typeof account.providerAccountId === 'string',
        ))) &&
    (value.providers === undefined ||
      (Array.isArray(value.providers) && value.providers.every((provider) => typeof provider === 'string')))
  )
}

export async function requestAuthJson(url: string, init: RequestInit): Promise<unknown> {
  // Never include response bodies or fetch causes in client-visible diagnostics.
  let response: Response
  try {
    response = await fetch(url, init)
  } catch {
    throw new AuthClientError('NETWORK_ERROR', url)
  }
  if (!response.ok) throw new AuthClientError('HTTP_ERROR', url, response.status)
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json'))
    throw new AuthClientError('INVALID_RESPONSE', url, response.status)
  try {
    return await response.json()
  } catch {
    throw new AuthClientError('INVALID_RESPONSE', url, response.status)
  }
}

export async function requestSession<TProviders extends string>(
  url: string,
  init: RequestInit,
): Promise<GauSession<TProviders>> {
  const session = await requestAuthJson(url, init)
  if (!isSession(session)) throw new AuthClientError('INVALID_SESSION', url)
  return session as GauSession<TProviders>
}
