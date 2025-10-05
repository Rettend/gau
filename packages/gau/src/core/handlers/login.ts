import type { Auth } from '../createAuth'
import { Cookies, LINKING_TOKEN_COOKIE_NAME, parseCookies, SESSION_COOKIE_NAME } from '../cookies'

import { json } from '../index'
import { prepareOAuthRedirect } from './utils'

export async function handleSignIn(request: Request, auth: Auth, providerId: string): Promise<Response> {
  return prepareOAuthRedirect(request, auth, providerId, null)
}

export async function handleSignOut(request: Request, auth: Auth): Promise<Response> {
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

  const response = json({ message: 'Signed out' })
  cookies.toHeaders().forEach((value, key) => {
    response.headers.append(key, value)
  })

  return response
}
