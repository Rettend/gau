import type { Auth } from '../createAuth'
import { ErrorCodes, GauError } from '../errors'
import { json, NULL_SESSION, toClientSession } from '../index'
import { getSessionTokenFromRequest } from '../utils'

export async function handleSession(request: Request, auth: Auth): Promise<Response> {
  const { token: sessionToken } = getSessionTokenFromRequest(request)

  const providers = Array.from(auth.providerMap.keys())

  if (!sessionToken)
    return json({ ...NULL_SESSION, providers })

  try {
    const sessionData = await auth.validateSession(sessionToken)

    if (!sessionData)
      return json({ ...NULL_SESSION, providers }, { status: 401 })

    return json({ ...toClientSession(sessionData), providers })
  }
  catch (error) {
    console.error('Error validating session:', error)
    throw new GauError(ErrorCodes.SESSION_VALIDATION_FAILED, { cause: error })
  }
}
