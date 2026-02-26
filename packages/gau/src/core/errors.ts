export const ErrorMessages = {
  // OAuth Flow Errors
  CSRF_INVALID: 'Invalid CSRF token',
  PKCE_MISSING: 'Missing PKCE code verifier',
  PKCE_CHALLENGE_MISSING: 'Missing PKCE challenge',
  OAUTH_CANCELLED: 'Authentication was cancelled',
  PROVIDER_NOT_FOUND: 'Provider not found',
  AUTHORIZATION_URL_FAILED: 'Could not create authorization URL',

  // User Errors
  USER_NOT_FOUND: 'User not found',
  USER_CREATE_FAILED: 'Failed to create user',
  ACCOUNT_ALREADY_LINKED: 'Account already linked to another user',
  ACCOUNT_LINK_FAILED: 'Failed to link account',
  ACCOUNT_NOT_LINKED: 'Account not linked',
  CANNOT_UNLINK_LAST_ACCOUNT: 'Cannot unlink the last account',
  EMAIL_ALREADY_EXISTS: 'An account with this email already exists',
  EMAIL_MISMATCH: 'Email mismatch between existing account and provider',
  LINKING_NOT_ALLOWED: 'Linking not allowed',
  LINK_ONLY_PROVIDER: 'Sign-in with this provider is disabled. Please link it to an existing account.',

  // Session Errors
  UNAUTHORIZED: 'Unauthorized',
  FORBIDDEN: 'Forbidden',
  SESSION_INVALID: 'Invalid session',
  SESSION_VALIDATION_FAILED: 'Failed to validate session',

  // Token Errors
  TOKEN_INVALID: 'Invalid token',
  TOKEN_EXPIRED: 'Token expired',
  CODE_VERIFIER_INVALID: 'Invalid code verifier',

  // Request Errors
  NOT_FOUND: 'Not found',
  METHOD_NOT_ALLOWED: 'Method not allowed',
  INVALID_REQUEST: 'Invalid request',
  INVALID_REDIRECT_URL: 'Invalid redirect URL',
  UNTRUSTED_HOST: 'Untrusted redirect host',
  UNKNOWN_PROFILE: 'Unknown profile',

  // Internal Errors
  INTERNAL_ERROR: 'An unexpected error occurred',

  // Impersonation Errors
  IMPERSONATION_DISABLED: 'Impersonation is not enabled',
  IMPERSONATION_NOT_ALLOWED: 'You are not allowed to impersonate users',
  IMPERSONATION_TARGET_PROTECTED: 'Cannot impersonate users with protected roles',
} as const

export type ErrorCode = keyof typeof ErrorMessages

export const ErrorCodes: { [K in ErrorCode]: K } = Object.fromEntries(
  Object.keys(ErrorMessages).map(k => [k, k]),
) as { [K in ErrorCode]: K }

/**
 * Default HTTP status codes for each error code.
 * Errors not listed here default to 400.
 */
export const ErrorStatuses: Partial<Record<ErrorCode, number>> = {
  CSRF_INVALID: 403,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  INTERNAL_ERROR: 500,
  USER_CREATE_FAILED: 500,
  ACCOUNT_LINK_FAILED: 500,
  AUTHORIZATION_URL_FAILED: 500,
  SESSION_VALIDATION_FAILED: 500,
  ACCOUNT_ALREADY_LINKED: 409,
  EMAIL_ALREADY_EXISTS: 409,
  LINKING_NOT_ALLOWED: 403,
  IMPERSONATION_DISABLED: 403,
  IMPERSONATION_NOT_ALLOWED: 403,
  IMPERSONATION_TARGET_PROTECTED: 403,
}

export interface GauErrorOptions {
  /** HTTP status code (uses default for error code if not specified) */
  status?: number
  /** URL to redirect to after showing error (for OAuth flow errors) */
  redirectUrl?: string
  /** Original error that caused this error */
  cause?: unknown
}

export class GauError extends Error {
  readonly code: ErrorCode
  readonly status: number
  readonly redirectUrl?: string
  override readonly cause?: unknown

  constructor(
    code: ErrorCode,
    messageOrOptions?: string | GauErrorOptions,
    options?: GauErrorOptions,
  ) {
    const message = typeof messageOrOptions === 'string'
      ? messageOrOptions
      : ErrorMessages[code]
    const opts = typeof messageOrOptions === 'object'
      ? messageOrOptions
      : options ?? {}

    super(message)
    this.name = 'GauError'
    this.code = code
    this.status = opts.status ?? ErrorStatuses[code] ?? 400
    this.redirectUrl = opts.redirectUrl
    this.cause = opts.cause
  }

  toJSON() {
    return {
      error: this.message,
      code: this.code,
      ...(this.redirectUrl && { redirectUrl: this.redirectUrl }),
    }
  }
}

export function createErrorRedirectUrl(baseUrl: string, error: GauError): string {
  const url = new URL(baseUrl, 'http://placeholder')
  url.searchParams.set('code', error.code)
  url.searchParams.set('message', error.message)
  url.searchParams.set('status', String(error.status))
  if (error.redirectUrl)
    url.searchParams.set('redirect', error.redirectUrl)

  return url.pathname + url.search
}

export interface ErrorContext {
  error: GauError
  request: Request
}

export interface ErrorHandlerConfig {
  basePath: string
  onError?: (context: ErrorContext) => Response | Promise<Response | undefined> | undefined
  errorRedirect?: string
}

export function isUserFacingRequest(request: Request, basePath: string): boolean {
  // POST requests are always API calls
  if (request.method !== 'GET')
    return false

  const url = new URL(request.url)
  const path = url.pathname.substring(basePath.length)
  const parts = path.split('/').filter(Boolean)

  // GET /session is an API call
  if (parts.length === 1 && parts[0] === 'session')
    return false

  // GET /:provider (sign-in start) - user-facing
  if (parts.length === 1)
    return true

  // GET /callback/:provider or GET /link/:provider - user-facing
  if (parts.length === 2 && (parts[0] === 'callback' || parts[0] === 'link'))
    return true

  return false
}

export async function handleError(
  context: ErrorContext,
  config: ErrorHandlerConfig,
): Promise<Response> {
  const { error, request } = context

  // 1. Try custom onError handler
  if (config.onError) {
    try {
      const response = await config.onError(context)
      if (response)
        return response
    }
    catch (e) {
      console.error('onError handler threw:', e)
    }
  }

  const userFacing = isUserFacingRequest(request, config.basePath)

  // 2. Try errorRedirect for user-facing requests
  if (config.errorRedirect && userFacing) {
    const redirectUrl = createErrorRedirectUrl(config.errorRedirect, error)
    return new Response(null, {
      status: 302,
      headers: { Location: redirectUrl },
    })
  }

  // 3. Default handling
  if (userFacing) {
    const { renderErrorPage, htmlResponse } = await import('./templates')
    const html = renderErrorPage({
      title: 'Authentication Error',
      message: error.message,
      code: error.code,
      redirectUrl: error.redirectUrl,
    })
    return htmlResponse(html, error.status)
  }

  return new Response(JSON.stringify(error.toJSON()), {
    status: error.status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}
