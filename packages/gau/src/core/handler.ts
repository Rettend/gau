import type { Auth } from './createAuth'
import { ErrorCodes, GauError, handleError } from './errors'
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

    if (!url.pathname.startsWith(basePath)) {
      const error = new GauError(ErrorCodes.NOT_FOUND)
      const response = await handleError(
        { error, request },
        { basePath, onError: auth.onError, errorRedirect: auth.errorRedirect },
      )
      return applyCors(request, response, auth)
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
        else if (parts.length === 2 && parts[0] === 'callback')
          response = await handleCallback(request, auth, parts[1] as string)
        else if (parts.length === 1)
          response = await handleSignIn(request, auth, action)
        else
          throw new GauError(ErrorCodes.NOT_FOUND)
      }
      else if (request.method === 'POST') {
        if (parts.length === 1 && action === 'signout')
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

      return applyCors(request, response, auth)
    }
    catch (error) {
      if (error instanceof GauError) {
        const response = await handleError(
          { error, request },
          { basePath, onError: auth.onError, errorRedirect: auth.errorRedirect },
        )
        return applyCors(request, response, auth)
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
      return applyCors(request, response, auth)
    }
  }
}
