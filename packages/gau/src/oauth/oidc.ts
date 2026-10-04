import type { JWTPayload } from 'jose'
import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose'

export type OIDCClientAuthentication =
  | { tokenEndpointAuthMethod?: 'none'; clientSecret?: never }
  | { tokenEndpointAuthMethod: 'client_secret_basic'; clientSecret: string }

export type OIDCClientConfig = OIDCClientAuthentication & {
  issuer: string
  clientId: string
  /** Defaults to RS256. Discovery cannot widen this allowlist. */
  signingAlgorithms?: string[]
  fetch?: typeof fetch
}

export interface OIDCDiscovery {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
  id_token_signing_alg_values_supported: string[]
  token_endpoint_auth_methods_supported?: string[]
}

export interface OIDCTokenResponse {
  id_token?: string
  access_token?: string
  refresh_token?: string
  token_type?: string
  scope?: string
  expires_in?: number
  [key: string]: unknown
}

function secureUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid OIDC endpoint')
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash)
    throw new Error('OIDC endpoints must use HTTPS without credentials or fragments')
  return value
}

function encodeFormComponent(value: string): string {
  return new URLSearchParams({ value }).toString().slice('value='.length)
}

/** Shared discovery, token exchange, and signature verification for web and local OIDC clients. */
export function createOIDCClient(config: OIDCClientConfig) {
  const issuer = secureUrl(config.issuer)
  if (new URL(issuer).search || !config.clientId?.trim()) throw new Error('Invalid OIDC client configuration')
  const method = config.tokenEndpointAuthMethod ?? 'none'
  if (method !== 'none' && method !== 'client_secret_basic')
    throw new Error('Unsupported token endpoint authentication method')
  if (method === 'client_secret_basic' && !config.clientSecret)
    throw new Error('client_secret_basic requires a client secret')
  if (method === 'none' && config.clientSecret !== undefined)
    throw new Error('Public clients must not send a client secret')
  const algorithms = config.signingAlgorithms ?? ['RS256']
  if (
    !algorithms.length ||
    algorithms.some(
      (algorithm) =>
        !['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA'].includes(algorithm),
    )
  )
    throw new Error('Unsupported ID token signing algorithm')
  const request: typeof fetch = (...args) => (config.fetch ?? globalThis.fetch)(...args)
  let discovery: Promise<OIDCDiscovery> | undefined
  let discoveryExpiresAt = 0
  let jwks: ReturnType<typeof createRemoteJWKSet> | undefined
  let jwksUri: string | undefined

  async function getDiscovery(): Promise<OIDCDiscovery> {
    if (!discovery || discoveryExpiresAt <= Date.now()) {
      discoveryExpiresAt = Date.now() + 60 * 60 * 1000
      discovery = (async () => {
        const response = await request(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`, {
          headers: { Accept: 'application/json' },
          redirect: 'error',
        })
        if (!response.ok) throw new Error('OIDC discovery failed')
        const data = (await response.json()) as OIDCDiscovery
        if (data.issuer !== issuer) throw new Error('OIDC discovery issuer mismatch')
        secureUrl(data.authorization_endpoint)
        secureUrl(data.token_endpoint)
        secureUrl(data.jwks_uri)
        if (
          !Array.isArray(data.id_token_signing_alg_values_supported) ||
          !algorithms.some((algorithm) => data.id_token_signing_alg_values_supported.includes(algorithm))
        )
          throw new Error('OIDC discovery has no supported signing algorithm')
        const methods = data.token_endpoint_auth_methods_supported ?? ['client_secret_basic']
        if (!Array.isArray(methods) || !methods.includes(method))
          throw new Error('Token endpoint authentication method is not supported')
        return data
      })()
      // Retry failed discovery rather than caching an error for an hour.
      discovery.catch(() => {
        discovery = undefined
      })
    }
    return discovery
  }

  async function exchangeAuthorizationCode(options: {
    code: string
    codeVerifier: string
    redirectUri: string
  }): Promise<OIDCTokenResponse> {
    if (!options.code || !options.codeVerifier || !options.redirectUri) throw new Error('Incomplete OIDC token request')
    const metadata = await getDiscovery()
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    }
    if (method === 'client_secret_basic') {
      headers.Authorization = `Basic ${btoa(`${encodeFormComponent(config.clientId)}:${encodeFormComponent(config.clientSecret!)}`)}`
    }
    const response = await request(metadata.token_endpoint, {
      method: 'POST',
      headers,
      redirect: 'error',
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: options.code,
        code_verifier: options.codeVerifier,
        redirect_uri: options.redirectUri,
        client_id: config.clientId,
      }),
    })
    // Do not include response bodies (which may contain credentials) in errors.
    if (!response.ok) throw new Error('OIDC token exchange failed')
    const tokens: unknown = await response.json()
    if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) throw new Error('Invalid OIDC token response')
    return tokens as OIDCTokenResponse
  }

  async function verifyIdToken(idToken: string, expectedNonce: string): Promise<JWTPayload> {
    if (typeof idToken !== 'string' || !idToken || !expectedNonce) throw new Error('Missing ID token or nonce')
    const metadata = await getDiscovery()
    if (!jwks || jwksUri !== metadata.jwks_uri) {
      jwksUri = metadata.jwks_uri
      jwks = createRemoteJWKSet(new URL(jwksUri), { [customFetch]: request })
    }
    const { payload } = await jwtVerify(idToken, jwks, {
      issuer,
      audience: config.clientId,
      algorithms: algorithms.filter((algorithm) => metadata.id_token_signing_alg_values_supported.includes(algorithm)),
      requiredClaims: ['sub', 'exp', 'iat', 'nonce'],
      clockTolerance: 5,
    })
    const now = Math.floor(Date.now() / 1000)
    if (
      typeof payload.sub !== 'string' ||
      !payload.sub ||
      typeof payload.iat !== 'number' ||
      !Number.isFinite(payload.iat) ||
      payload.iat > now + 5 ||
      typeof payload.exp !== 'number' ||
      !Number.isFinite(payload.exp) ||
      payload.exp <= payload.iat ||
      payload.nonce !== expectedNonce
    )
      throw new Error('Invalid OIDC identity claims')
    if (
      (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== config.clientId) ||
      (payload.azp !== undefined && payload.azp !== config.clientId)
    )
      throw new Error('Invalid ID token authorized party')
    return payload
  }

  return { getDiscovery, exchangeAuthorizationCode, verifyIdToken }
}
