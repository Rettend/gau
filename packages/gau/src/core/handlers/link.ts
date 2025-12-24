import type { Auth } from '../createAuth'
import { json } from '../index'
import { getSessionTokenFromRequest } from '../utils'
import { prepareOAuthRedirect } from './utils'

export async function handleLink(request: Request, auth: Auth, providerId: string): Promise<Response> {
  const url = new URL(request.url)
  let sessionToken = getSessionTokenFromRequest(request).token

  if (!sessionToken)
    sessionToken = url.searchParams.get('token') ?? undefined

  if (!sessionToken)
    return json({ error: 'Unauthorized' }, { status: 401 })

  const session = await auth.validateSession(sessionToken)
  if (!session)
    return json({ error: 'Unauthorized' }, { status: 401 })

  url.searchParams.delete('token')
  const cleanRequest = new Request(url.toString(), request as Request)

  return prepareOAuthRedirect(cleanRequest, auth, providerId, sessionToken)
}

export async function handleUnlink(request: Request, auth: Auth, providerId: string): Promise<Response> {
  const sessionToken = getSessionTokenFromRequest(request).token

  if (!sessionToken)
    return json({ error: 'Unauthorized' }, { status: 401 })

  const session = await auth.validateSession(sessionToken)
  if (!session || !session.user)
    return json({ error: 'Unauthorized' }, { status: 401 })

  const accounts = session.accounts ?? []

  if (accounts.length <= 1)
    return json({ error: 'Cannot unlink the last account' }, { status: 400 })

  const accountToUnlink = accounts.find(a => a.provider === providerId)
  if (!accountToUnlink)
    return json({ error: `Provider "${providerId}" not linked to this account` }, { status: 400 })

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
