import { parseCookies, SESSION_COOKIE_NAME } from './cookies'

export type SessionTokenSource = 'cookie' | 'bearer'

/**
 * Extract the session token from a Request.
 * Prefers Cookie, then falls back to Authorization: Bearer.
 */
export function getSessionTokenFromRequest(request: Request): { token?: string, source?: SessionTokenSource } {
  const cookies = parseCookies(request.headers.get('Cookie'))
  const cookieToken = cookies.get(SESSION_COOKIE_NAME)
  if (cookieToken)
    return { token: cookieToken, source: 'cookie' }

  const authHeader = request.headers.get('Authorization')
  if (authHeader?.startsWith('Bearer '))
    return { token: authHeader.substring(7), source: 'bearer' }

  return {}
}
