/**
 * Default messages for each error code.
 * This is the single source of truth for error codes and their messages.
 */
export const ErrorMessages = {
  // OAuth Flow Errors
  CSRF_INVALID: 'Invalid CSRF token',
  PKCE_MISSING: 'Missing PKCE code verifier',
  PKCE_CHALLENGE_MISSING: 'Missing PKCE challenge',
  OAUTH_CANCELLED: 'Authentication was cancelled',
  PROVIDER_NOT_FOUND: 'Provider not found',
  AUTHORIZATION_URL_FAILED: 'Could not create authorization URL',

  // Account/User Errors
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

  // Session/Auth Errors
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

/** Error code type derived from ErrorMessages keys */
export type ErrorCode = keyof typeof ErrorMessages

/**
 * Error codes object for developer ergonomics.
 * Usage: `ErrorCodes.CSRF_INVALID` instead of `'CSRF_INVALID'`
 */
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

/**
 * Structured error class for gau authentication errors.
 * Contains all information needed for error handling and user feedback.
 *
 * @example
 * // Using default message
 * throw new GauError(ErrorCodes.CSRF_INVALID, { status: 403 })
 *
 * // Using custom message
 * throw new GauError(ErrorCodes.PROVIDER_NOT_FOUND, `Provider "${id}" not found`)
 */
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
    // Handle overloaded signatures
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

  /**
   * Convert to JSON-serializable object for API responses.
   */
  toJSON() {
    return {
      error: this.message,
      code: this.code,
      ...(this.redirectUrl && { redirectUrl: this.redirectUrl }),
    }
  }
}

/**
 * Create an error redirect URL with query params.
 * Used when errorRedirect is configured.
 */
export function createErrorRedirectUrl(baseUrl: string, error: GauError): string {
  const url = new URL(baseUrl, 'http://placeholder')
  url.searchParams.set('code', error.code)
  url.searchParams.set('message', error.message)
  url.searchParams.set('status', String(error.status))
  if (error.redirectUrl)
    url.searchParams.set('redirect', error.redirectUrl)

  return url.pathname + url.search
}

/**
 * Context passed to error handlers.
 */
export interface ErrorContext {
  error: GauError
  request: Request
}

/**
 * Configuration for error handling.
 */
export interface ErrorHandlerConfig {
  basePath: string
  onError?: (context: ErrorContext) => Response | Promise<Response | undefined> | undefined
  errorRedirect?: string
}

/**
 * Determine if a request is user-facing (browser OAuth flow)
 * vs API (programmatic fetch).
 *
 * Uses route-based detection (reliable) rather than Accept headers (unreliable).
 *
 * User-facing routes (browser navigates directly):
 *   - GET /:provider         → OAuth sign-in start
 *   - GET /callback/:provider → OAuth callback from provider
 *   - GET /link/:provider    → Account linking start
 *
 * API routes (JS fetch):
 *   - GET /session           → Get current session
 *   - POST /signout          → Sign out
 *   - POST /token            → PKCE token exchange
 *   - POST /unlink/:provider → Unlink account
 */
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

/**
 * Handle an error according to configuration.
 * Returns the appropriate Response based on context.
 *
 * Priority:
 * 1. Custom onError handler (if returns Response)
 * 2. errorRedirect (for user-facing requests only)
 * 3. Default: HTML error page for user-facing, JSON for API
 */
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

  // Determine if this is a user-facing request
  const userFacing = isUserFacingRequest(request, config.basePath)

  // 2. Try errorRedirect (only for user-facing requests)
  if (config.errorRedirect && userFacing) {
    const redirectUrl = createErrorRedirectUrl(config.errorRedirect, error)
    return new Response(null, {
      status: 302,
      headers: { Location: redirectUrl },
    })
  }

  // 3. Default handling
  if (userFacing) {
    // Import dynamically to avoid circular dependency
    const { renderErrorPage, htmlResponse } = await import('./templates')
    const html = renderErrorPage({
      title: 'Authentication Error',
      message: error.message,
      code: error.code,
      redirectUrl: error.redirectUrl,
    })
    return htmlResponse(html, error.status)
  }

  // API response - return JSON
  return new Response(JSON.stringify(error.toJSON()), {
    status: error.status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}
