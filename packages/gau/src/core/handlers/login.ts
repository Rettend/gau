import type { Auth } from '../createAuth'
import { Cookies, LINKING_TOKEN_COOKIE_NAME, parseCookies, SESSION_COOKIE_NAME } from '../cookies'

import { json } from '../index'
import { ErrorCodes, GauError } from '../errors'
import { prepareOAuthRedirect } from './utils'

export async function handleSignIn(request: Request, auth: Auth, providerId: string): Promise<Response> {
  return prepareOAuthRedirect(request, auth, providerId, null)
}

export async function handleSignOut(request: Request, auth: Auth): Promise<Response> {
  const url = new URL(request.url)
  const redirectTo = url.searchParams.get('redirectTo')
  let destination: URL | undefined
  if (redirectTo) {
    try {
      destination = new URL(redirectTo, url)
      if (destination.origin !== url.origin || !['http:', 'https:'].includes(destination.protocol))
        throw new Error('Invalid redirect')
    } catch {
      throw new GauError(ErrorCodes.INVALID_REDIRECT_URL, 'Sign-out redirects must use the same origin.', {
        status: 400,
      })
    }
  }
  const requestCookies = parseCookies(request.headers.get('Cookie'))
  const cookies = new Cookies(requestCookies, auth.cookieOptions)
  cookies.delete(SESSION_COOKIE_NAME, {
    sameSite: auth.development ? 'lax' : 'none',
    secure: !auth.development,
  })
  cookies.delete(LINKING_TOKEN_COOKIE_NAME, {
    sameSite: auth.development ? 'lax' : 'none',
    secure: !auth.development,
  })

  const response = destination
    ? new Response(null, { status: 303, headers: { Location: destination.href } })
    : json({ message: 'Signed out' })
  for (const cookie of cookies.toHeaders().getSetCookie()) response.headers.append('Set-Cookie', cookie)

  return response
}
