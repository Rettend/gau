import type { Auth } from '../createAuth'
import type { Cookies } from '../cookies'
import { generateState } from 'arctic'
import { CSRF_MAX_AGE, OAUTH_TRANSACTION_COOKIE_NAME } from '../cookies'
import { ErrorCodes, GauError } from '../errors'

export interface OAuthTransaction {
  providerId: string
  state: string
  codeVerifier: string
  nonce: string
  redirectTo: string
  callbackUri?: string
  overrides?: Record<string, unknown>
  linkingToken?: string
  clientChallenge?: string
}

export function clearOAuthTransactionCookie(cookies: Cookies, auth: Auth): void {
  cookies.delete(OAUTH_TRANSACTION_COOKIE_NAME, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: !auth.development,
  })
}

export async function storeOAuthTransaction(
  auth: Auth,
  cookies: Cookies,
  transaction: OAuthTransaction,
): Promise<void> {
  const secret = generateState()
  const store = auth.verification!
  await store.deleteExpired(Date.now())
  if (
    !(await store.set(
      {
        id: `oauth:${secret}`,
        value: JSON.stringify(transaction),
        expiresAt: Date.now() + CSRF_MAX_AGE * 1000,
        version: 0,
      },
      null,
    ))
  )
    throw new GauError(ErrorCodes.INTERNAL_ERROR)
  cookies.set(OAUTH_TRANSACTION_COOKIE_NAME, secret, {
    path: '/',
    maxAge: CSRF_MAX_AGE,
    httpOnly: true,
    sameSite: 'lax',
    secure: !auth.development,
  })
}

/** Consume before checking callback fields, including errors. CAS rejects concurrent redemptions. */
export async function consumeOAuthTransaction(
  auth: Auth,
  cookies: Cookies,
  providerId: string,
  state: string | null,
): Promise<OAuthTransaction> {
  const secret = cookies.get(OAUTH_TRANSACTION_COOKIE_NAME)
  if (!secret) throw new GauError(ErrorCodes.CSRF_INVALID)
  const store = auth.verification!
  const record = await store.get(`oauth:${secret}`)
  if (!record || record.expiresAt <= Date.now()) throw new GauError(ErrorCodes.CSRF_INVALID)
  const transaction = JSON.parse(record.value) as OAuthTransaction & { used?: boolean }
  if (transaction.used) throw new GauError(ErrorCodes.CSRF_INVALID)
  if (!(await store.set({ ...record, value: '{"used":true}', version: record.version + 1 }, record.version)))
    throw new GauError(ErrorCodes.CSRF_INVALID)
  if (
    transaction.providerId !== providerId ||
    transaction.state !== state ||
    !transaction.nonce ||
    !transaction.codeVerifier
  )
    throw new GauError(ErrorCodes.CSRF_INVALID)
  return transaction
}
