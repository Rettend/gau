import type { Auth } from './createAuth'
import {
  applyCors,
  handleCallback,
  handleLink,
  handlePreflight,
  handleSession,
  handleSignIn,
  handleSignOut,
  handleUnlink,
  verifyRequestOrigin,
} from './handlers'
import { json } from './index'

export function createHandler(auth: Auth): (request: Request) => Promise<Response> {
  const { basePath } = auth

  return async function (request: Request): Promise<Response> {
    // Handle preflight requests early
    if (request.method === 'OPTIONS')
      return handlePreflight(request, auth)

    const url = new URL(request.url)
    if (!url.pathname.startsWith(basePath))
      return applyCors(request, json({ error: 'Not Found' }, { status: 404 }), auth)

    if (request.method === 'POST' && !verifyRequestOrigin(request, auth.trustHosts, auth.development)) {
      if (auth.development) {
        const origin = request.headers.get('origin') ?? 'N/A'
        const message = `Untrusted origin: '${origin}'. Add this origin to 'trustHosts' in createAuth() or ensure you are using 'localhost' or '127.0.0.1' for development.`
        return applyCors(request, json({ error: 'Forbidden', message }, { status: 403 }), auth)
      }
      return applyCors(request, json({ error: 'Forbidden' }, { status: 403 }), auth)
    }

    const path = url.pathname.substring(basePath.length)
    const parts = path.split('/').filter(Boolean)
    const action = parts[0]

    if (!action)
      return applyCors(request, json({ error: 'Not Found' }, { status: 404 }), auth)

    let response: Response

    if (request.method === 'GET') {
      if (action === 'session')
        response = await handleSession(request, auth)
      else if (parts.length === 2 && parts[0] === 'link')
        response = await handleLink(request, auth, parts[1] as string)
      else if (parts.length === 2 && parts[1] === 'callback')
        response = await handleCallback(request, auth, action)
      else if (parts.length === 1)
        response = await handleSignIn(request, auth, action)
      else
        response = json({ error: 'Not Found' }, { status: 404 })
    }
    else if (request.method === 'POST') {
      if (parts.length === 1 && action === 'signout')
        response = await handleSignOut(request, auth)
      else if (parts.length === 2 && parts[0] === 'unlink')
        response = await handleUnlink(request, auth, parts[1] as string)
      else
        response = json({ error: 'Not Found' }, { status: 404 })
    }
    else {
      response = json({ error: 'Method Not Allowed' }, { status: 405 })
    }

    try {
      response.headers.set('Cache-Control', 'no-store, private')
      response.headers.set('Pragma', 'no-cache')
      response.headers.set('Expires', '0')
    }
    catch {}

    return applyCors(request, response, auth)
  }
}
