import type { Auth } from '../createAuth'
import { ErrorCodes, GauError } from '../errors'
import { json } from '../index'

export async function handleToken(request: Request, auth: Auth): Promise<Response> {
  if (request.method !== 'POST')
    throw new GauError(ErrorCodes.METHOD_NOT_ALLOWED)

  let body: any
  try {
    body = await request.json()
  }
  catch {
    throw new GauError(ErrorCodes.INVALID_REQUEST, 'Invalid JSON body', { status: 400 })
  }

  const { code, codeVerifier } = body

  if (!code || !codeVerifier)
    throw new GauError(ErrorCodes.INVALID_REQUEST, 'Missing code or codeVerifier', { status: 400 })

  const payload = await auth.verifyJWT<{ sub: string, challenge: string }>(code)
  if (!payload)
    throw new GauError(ErrorCodes.TOKEN_EXPIRED, 'Invalid or expired code')

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
    throw new GauError(ErrorCodes.CODE_VERIFIER_INVALID)

  const sessionToken = await auth.createSession(userId)

  return json({ token: sessionToken })
}
