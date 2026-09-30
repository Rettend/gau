import type { Auth } from './createAuth'
import { ErrorCodes, GauError, handleError } from './errors'
import { handleEmail } from './handlers/email'
import {
  applyCors,
  handleCallback,
  handleLink,
  handlePreflight,
  handleSession,
  handleSignIn,
  handleSignOut,
  handleToken,
  handleUnlink,
  verifyRequestOrigin,
} from './handlers'

export function createHandler(auth: Auth): (request: Request) => Promise<Response> {
  const { basePath } = auth

  return async function (request: Request): Promise<Response> {
    if (request.method === 'OPTIONS')
      return handlePreflight(request, auth)

    const url = new URL(request.url)
    const finish = (response: Response) => {
      if ([`${basePath}/email`, `${basePath}/link/email`, `${basePath}/callback/email`].includes(url.pathname)) {
        response.headers.set('Cache-Control', 'no-store, private')
        response.headers.set('Referrer-Policy', 'no-referrer')
        response.headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'")
      }
      return applyCors(request, response, auth)
    }

    if (!url.pathname.startsWith(basePath)) {
      const error = new GauError(ErrorCodes.NOT_FOUND)
      const response = await handleError(
        { error, request },
        { basePath, onError: auth.onError, errorRedirect: auth.errorRedirect },
      )
      return finish(response)
    }

    try {
      // CSRF protection for POST requests
      if (request.method === 'POST' && !verifyRequestOrigin(request, auth.trustHosts, auth.development)) {
        const origin = request.headers.get('origin') ?? 'unknown'
        const message = auth.development
          ? `Untrusted origin: '${origin}'. Add this origin to 'trustHosts' in createAuth() or ensure you are using 'localhost' or '127.0.0.1' for development.`
          : 'Forbidden'
        throw new GauError(ErrorCodes.FORBIDDEN, message, { status: 403 })
      }

      const path = url.pathname.substring(basePath.length)
      const parts = path.split('/').filter(Boolean)
      const action = parts[0]

      if (!action)
        throw new GauError(ErrorCodes.NOT_FOUND)

      let response: Response

      if (request.method === 'GET') {
        if (action === 'session')
          response = await handleSession(request, auth)
        else if (parts.length === 2 && parts[0] === 'link')
          response = await handleLink(request, auth, parts[1] as string)
        else if (parts.length === 2 && parts[0] === 'callback' && parts[1] === 'email')
          response = await handleEmail(request, auth, 'signin', true)
        else if (parts.length === 2 && parts[0] === 'callback')
          response = await handleCallback(request, auth, parts[1] as string)
        else if (parts.length === 1)
          response = await handleSignIn(request, auth, action)
        else
          throw new GauError(ErrorCodes.NOT_FOUND)
      }
      else if (request.method === 'POST') {
        if (parts.length === 1 && action === 'email')
          response = await handleEmail(request, auth)
        else if (parts.length === 2 && action === 'link' && parts[1] === 'email')
          response = await handleEmail(request, auth, 'link')
        else if (parts.length === 2 && action === 'callback' && parts[1] === 'email')
          response = await handleEmail(request, auth, 'signin', true)
        else if (parts.length === 1 && action === 'signout')
          response = await handleSignOut(request, auth)
        else if (parts.length === 1 && action === 'token')
          response = await handleToken(request, auth)
        else if (parts.length === 2 && parts[0] === 'unlink')
          response = await handleUnlink(request, auth, parts[1] as string)
        else
          throw new GauError(ErrorCodes.NOT_FOUND)
      }
      else {
        throw new GauError(ErrorCodes.METHOD_NOT_ALLOWED)
      }

      // Add cache headers
      try {
        response.headers.set('Cache-Control', 'no-store, private')
        response.headers.set('Pragma', 'no-cache')
        response.headers.set('Expires', '0')
      }
      catch {}

      return finish(response)
    }
    catch (error) {
      if (error instanceof GauError) {
        const response = await handleError(
          { error, request },
          { basePath, onError: auth.onError, errorRedirect: auth.errorRedirect },
        )
        return finish(response)
      }

      // Unknown error - wrap in GauError
      console.error('Unexpected error in gau handler:', error)
      const gauError = new GauError(
        ErrorCodes.INTERNAL_ERROR,
        { cause: error },
      )
      const response = await handleError(
        { error: gauError, request },
        { basePath, onError: auth.onError, errorRedirect: auth.errorRedirect },
      )
      return finish(response)
    }
  }
}
