import type { SerializeOptions } from 'cookie'
import { parse, serialize } from 'cookie'

export const DEFAULT_COOKIE_SERIALIZE_OPTIONS: SerializeOptions = {
  path: '/',
  sameSite: 'lax',
  secure: true,
  httpOnly: true,
}

export type Cookie = [string, string, SerializeOptions]

export function parseCookies(cookieHeader: string | null | undefined): Map<string, string> {
  const cookies = new Map<string, string>()
  if (cookieHeader) {
    const parsed = parse(cookieHeader)
    for (const name in parsed)
      cookies.set(name, parsed[name]!)
  }
  return cookies
}

export class Cookies {
  #new: Cookie[] = []

  constructor(
    private readonly requestCookies: Map<string, string>,
    private readonly defaultOptions: SerializeOptions,
  ) {}

  get(name: string): string | undefined {
    return this.requestCookies.get(name)
  }

  set(name: string, value: string, options?: SerializeOptions): void {
    const combinedOptions = { ...this.defaultOptions, ...options }
    this.#new.push([name, value, combinedOptions])
  }

  delete(name: string, options?: Omit<SerializeOptions, 'expires' | 'maxAge'>): void {
    this.set(name, '', { ...options, expires: new Date(0), maxAge: 0 })
  }

  toHeaders(): Headers {
    const headers = new Headers()
    for (const [name, value, options] of this.#new)
      headers.append('Set-Cookie', serialize(name, value, options))

    return headers
  }
}

export const CSRF_COOKIE_NAME = '__gau-csrf-token'
export const SESSION_COOKIE_NAME = '__gau-session-token'
export const SESSION_STASH_COOKIE_NAME = '__gau-session-stash'
export const SESSION_STRATEGY_COOKIE_NAME = '__gau-session-strategy'
export const LINKING_TOKEN_COOKIE_NAME = '__gau-linking-token'
export const PKCE_COOKIE_NAME = '__gau-pkce-code-verifier'
export const CALLBACK_URI_COOKIE_NAME = '__gau-callback-uri'
export const PROVIDER_OPTIONS_COOKIE_NAME = '__gau-provider-options'
export const CLIENT_CHALLENGE_COOKIE_NAME = '__gau-client-challenge'

export const CSRF_MAX_AGE = 60 * 10 // 10 minutes
