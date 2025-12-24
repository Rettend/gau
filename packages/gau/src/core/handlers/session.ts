import type { Auth } from '../createAuth'
import { json, NULL_SESSION } from '../index'
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

    return json({ ...sessionData, providers })
  }
  catch (error) {
    console.error('Error validating session:', error)
    return json({ error: 'Failed to validate session' }, { status: 500 })
  }
}
