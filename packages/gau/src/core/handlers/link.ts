import type { Auth } from '../createAuth'
import { ErrorCodes, GauError } from '../errors'
import { json } from '../index'
import { getSessionTokenFromRequest } from '../utils'
import { prepareOAuthRedirect } from './utils'

export async function handleLink(request: Request, auth: Auth, providerId: string): Promise<Response> {
  const url = new URL(request.url)
  let sessionToken = getSessionTokenFromRequest(request).token

  if (!sessionToken)
    sessionToken = url.searchParams.get('token') ?? undefined

  if (!sessionToken)
    throw new GauError(ErrorCodes.UNAUTHORIZED)

  const session = await auth.validateSession(sessionToken)
  if (!session)
    throw new GauError(ErrorCodes.UNAUTHORIZED)

  url.searchParams.delete('token')
  const cleanRequest = new Request(url.toString(), request as Request)

  return prepareOAuthRedirect(cleanRequest, auth, providerId, sessionToken)
}

export async function handleUnlink(request: Request, auth: Auth, providerId: string): Promise<Response> {
  const sessionToken = getSessionTokenFromRequest(request).token

  if (!sessionToken)
    throw new GauError(ErrorCodes.UNAUTHORIZED)

  const session = await auth.validateSession(sessionToken)
  if (!session || !session.user)
    throw new GauError(ErrorCodes.UNAUTHORIZED)

  const accounts = session.accounts ?? []

  if (accounts.length <= 1)
    throw new GauError(ErrorCodes.CANNOT_UNLINK_LAST_ACCOUNT)

  const accountToUnlink = accounts.find(a => a.provider === providerId)
  if (!accountToUnlink)
    throw new GauError(ErrorCodes.ACCOUNT_NOT_LINKED, `Provider "${providerId}" not linked`)

  await auth.unlinkAccount(providerId, accountToUnlink.providerAccountId)

  const remainingAccounts = await auth.getAccounts(session.user.id)

  // if there are remaining accounts, we need to potentially update the user's primary info
  // TODO: for now we just clear the email
  if (remainingAccounts.length > 0 && session.user.email) {
    try {
      await auth.updateUser({
        id: session.user.id,
        email: null,
        emailVerified: false,
      })
    }
    catch (error) {
      console.error('Failed to clear stale email after unlinking:', error)
    }
  }

  return json({ message: 'Account unlinked successfully' })
}
