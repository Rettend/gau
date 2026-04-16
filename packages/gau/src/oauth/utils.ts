import type { OAuthProviderConfig, RefreshedTokens } from './index'
import { CodeChallengeMethod, generateCodeVerifier, generateState, OAuth2Client } from 'arctic'

export function createOAuthUris() {
  const state = generateState()
  const codeVerifier = generateCodeVerifier()

  return {
    state,
    codeVerifier,
  }
}

export function createOAuthClientResolver(config: Pick<OAuthProviderConfig, 'clientId' | 'clientSecret' | 'redirectUri'>) {
  const defaultClient = new OAuth2Client(config.clientId, config.clientSecret, config.redirectUri ?? null)

  return (redirectUri?: string) => {
    if (!redirectUri || redirectUri === config.redirectUri)
      return defaultClient

    return new OAuth2Client(config.clientId, config.clientSecret, redirectUri)
  }
}

export function mergeOAuthParams(configParams?: Record<string, string>, optionParams?: Record<string, string>) {
  return { ...(configParams ?? {}), ...(optionParams ?? {}) }
}

export function applyOAuthParams(url: URL, params?: Record<string, string>, omitKeys: string[] = []) {
  const omitted = new Set(omitKeys)

  for (const [key, value] of Object.entries(params ?? {})) {
    if (!omitted.has(key) && value != null)
      url.searchParams.set(key, String(value))
  }

  return url
}

export async function createOAuthAuthorizationUrl(options: {
  client: OAuth2Client
  authorizationUrl: string
  state: string
  codeVerifier: string
  scopes: string[]
  configParams?: Record<string, string>
  params?: Record<string, string>
  extraParams?: Record<string, string>
  omitParamKeys?: string[]
}) {
  const url = await options.client.createAuthorizationURLWithPKCE(
    options.authorizationUrl,
    options.state,
    CodeChallengeMethod.S256,
    options.codeVerifier,
    options.scopes,
  )

  applyOAuthParams(url, mergeOAuthParams(options.configParams, options.params), options.omitParamKeys)
  applyOAuthParams(url, options.extraParams)

  return url
}

export function normalizeRefreshedTokens(tokens: Record<string, any>, refreshToken: string): RefreshedTokens {
  const expiresIn = typeof tokens.expires_in === 'number'
    ? tokens.expires_in
    : typeof tokens.expires_in === 'string'
      ? Number(tokens.expires_in)
      : undefined
  const expiresAt = Number.isFinite(expiresIn)
    ? Math.floor(Date.now() / 1000) + Math.floor(expiresIn as number)
    : null

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? refreshToken,
    expiresAt,
    idToken: tokens.id_token ?? null,
    tokenType: tokens.token_type ?? null,
    scope: tokens.scope ?? null,
  }
}

export async function refreshOAuthAccessToken(options: {
  tokenUrl: string
  clientId: string
  clientSecret: string
  refreshToken: string
  scopes?: string[]
}) {
  const body = new URLSearchParams({
    client_id: options.clientId,
    client_secret: options.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: options.refreshToken,
  })

  if (options.scopes?.length)
    body.set('scope', options.scopes.join(' '))

  const response = await fetch(options.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  })
  const json = await response.json() as Record<string, any>

  if (!response.ok)
    throw json

  return normalizeRefreshedTokens(json, options.refreshToken)
}
