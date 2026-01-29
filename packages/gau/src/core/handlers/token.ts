import type { Auth } from '../createAuth'
import { json } from '../index'

export async function handleToken(request: Request, auth: Auth): Promise<Response> {
  if (request.method !== 'POST')
    return json({ error: 'Method not allowed' }, { status: 405 })

  let body: any
  try {
    body = await request.json()
  }
  catch {
    return json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { code, codeVerifier } = body

  if (!code || !codeVerifier)
    return json({ error: 'Missing code or codeVerifier' }, { status: 400 })

  const payload = await auth.verifyJWT<{ sub: string, challenge: string }>(code)
  if (!payload)
    return json({ error: 'Invalid or expired code' }, { status: 400 })

  const { sub: userId, challenge } = payload

  const encoder = new TextEncoder()
  const data = encoder.encode(codeVerifier)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  const expectedChallenge = btoa(String.fromCharCode(...hashArray))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

  if (challenge !== expectedChallenge)
    return json({ error: 'Invalid code verifier' }, { status: 400 })

  const sessionToken = await auth.createSession(userId)

  return json({ token: sessionToken })
}
