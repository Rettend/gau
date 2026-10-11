import type { Auth } from '../createAuth'
import { generateState } from 'arctic'
import { ErrorCodes, GauError } from '../errors'
import { json } from '../index'
import { getSessionTokenFromRequest } from '../utils'
import { prepareOAuthRedirect } from './utils'

export async function handleLink(request: Request, auth: Auth, providerId: string): Promise<Response> {
  let url = new URL(request.url)
  let sessionToken = getSessionTokenFromRequest(request).token
  const linkCode = url.searchParams.get('link_code')

  if (linkCode) {
    const store = auth.verification
    const record = await store?.get(`oauth-link:${providerId}:${linkCode}`)
    if (!store || !record || record.expiresAt <= Date.now() || !record.value ||
      !await store.set({ ...record, value: '', version: record.version + 1 }, record.version))
      throw new GauError(ErrorCodes.UNAUTHORIZED)
    const saved = JSON.parse(record.value) as { url: string, token: string }
    url = new URL(saved.url)
    sessionToken = saved.token
  }

  if (!sessionToken)
    sessionToken = url.searchParams.get('token') ?? undefined

  if (!sessionToken)
    throw new GauError(ErrorCodes.UNAUTHORIZED)

  const session = await auth.validateSession(sessionToken)
  if (!session)
    throw new GauError(ErrorCodes.UNAUTHORIZED)

  url.searchParams.delete('token')

  // Set OAuth cookies during top-level navigation, not a cross-site bearer fetch.
  if (url.searchParams.get('redirect') === 'false' && request.headers.has('Authorization')) {
    const store = auth.verification
    if (!store)
      throw new GauError(ErrorCodes.INVALID_REQUEST, 'Bearer account linking requires atomic verification storage.')
    url.searchParams.delete('redirect')
    const code = generateState()
    await store.deleteExpired(Date.now())
    if (!await store.set({
      id: `oauth-link:${providerId}:${code}`,
      value: JSON.stringify({ url: url.href, token: sessionToken }),
      expiresAt: Date.now() + 60_000,
      version: 0,
    }, null))
      throw new GauError(ErrorCodes.INTERNAL_ERROR)
    return json({ url: `${url.origin}${url.pathname}?link_code=${code}` }, { headers: { 'Cache-Control': 'no-store' } })
  }

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
