import type { EmailProvider } from '../../email'
import type { Auth } from '../createAuth'
import type { User } from '../index'
import type { VerificationRecord } from '../verification'
import { renderEmail } from '../../email'
import { randomCode, randomSecret, sha256 } from '../../email/crypto'
import { Cookies, parseCookies, SESSION_COOKIE_NAME } from '../cookies'
import { ErrorCodes, GauError } from '../errors'
import { json, redirect } from '../index'
import { isEmailProvider } from '../providers'
import { htmlResponse, renderEmailConfirmation } from '../templates'
import { getSessionTokenFromRequest } from '../utils'

interface Challenge {
  email: string
  purpose: 'signin' | 'link'
  userId?: string
  codeHash?: string
  linkHash?: string
  clientChallenge: string
  browserHash: string
  attempts: number
  used: boolean
  tokenSession: boolean
  redirectTo: string
}

const invalid = () => new GauError(ErrorCodes.EMAIL_VERIFICATION_INVALID)
const cookieName = (id: string) => `__gau-email-${id}`

function emailProvider(auth: Auth): EmailProvider {
  const provider = auth.providerMap.get('email')
  if (!provider || !isEmailProvider(provider)) throw new GauError(ErrorCodes.PROVIDER_NOT_FOUND)
  return provider
}

/** Retrying compare-and-set keeps attempts and redemption atomic across workers. */
async function change(
  auth: Auth,
  id: string,
  update: (record: VerificationRecord | null) => VerificationRecord,
): Promise<VerificationRecord> {
  const store = auth.verification!
  for (let retry = 0; retry < 20; retry++) {
    const previous = await store.get(id)
    const next = update(previous)
    if (await store.set(next, previous?.version ?? null)) return next
  }
  throw new GauError(ErrorCodes.EMAIL_RATE_LIMITED)
}

async function limit(auth: Auth, key: string, maximum: number, window: number): Promise<void> {
  const id = `limit:${await auth.hashVerification(key)}`
  await change(auth, id, (record) => {
    const now = Date.now()
    const active = record && record.expiresAt > now
    const count = active ? Number(record.value) : 0
    if (count >= maximum) throw new GauError(ErrorCodes.EMAIL_RATE_LIMITED)
    return {
      id,
      value: String(count + 1),
      expiresAt: active ? record.expiresAt : now + window,
      version: (record?.version ?? -1) + 1,
    }
  })
}

async function sessionUser(request: Request, auth: Auth): Promise<User> {
  const token = getSessionTokenFromRequest(request).token
  const session = token ? await auth.validateSession(token) : null
  if (!session?.user) throw new GauError(ErrorCodes.UNAUTHORIZED)
  return session.user
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text()
  if (text.length > 4096) throw new GauError(ErrorCodes.INVALID_REQUEST)
  try {
    const value = request.headers.get('content-type')?.includes('application/x-www-form-urlencoded')
      ? Object.fromEntries(new URLSearchParams(text))
      : JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid body')
    return value
  } catch {
    throw new GauError(ErrorCodes.INVALID_REQUEST)
  }
}

function validateRedirect(value: unknown, request: Request): string {
  if (value === undefined) return '/'
  if (typeof value !== 'string') throw new GauError(ErrorCodes.INVALID_REDIRECT_URL)
  const base = new URL(request.url)
  let url: URL
  try {
    url = new URL(value, base.origin)
  } catch {
    throw new GauError(ErrorCodes.INVALID_REDIRECT_URL)
  }
  if (url.origin !== base.origin || !['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new GauError(ErrorCodes.INVALID_REDIRECT_URL)
  return url.pathname + url.search + url.hash
}

async function start(
  request: Request,
  auth: Auth,
  provider: EmailProvider,
  body: Record<string, unknown>,
  purpose: Challenge['purpose'],
): Promise<Response> {
  if (
    typeof body.email !== 'string' ||
    body.email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())
  )
    throw new GauError(ErrorCodes.INVALID_REQUEST, 'Enter a valid email address.')
  if (typeof body.clientChallenge !== 'string' || !/^[a-f0-9]{64}$/.test(body.clientChallenge))
    throw new GauError(ErrorCodes.INVALID_REQUEST)
  const email = body.email.trim().toLowerCase()
  const user = purpose === 'link' ? await sessionUser(request, auth) : undefined
  if (!user && provider.linkOnly) throw new GauError(ErrorCodes.LINK_ONLY_PROVIDER)
  const redirectTo = validateRedirect(body.redirectTo, request)
  const tokenSession = auth.sessionStrategy === 'token' || (auth.sessionStrategy === 'auto' && body.session === 'token')
  if (tokenSession && provider.config.mode === 'link')
    throw new GauError(ErrorCodes.INVALID_REQUEST, 'Token sessions require email codes. Use code or both mode.')

  await auth.verification!.deleteExpired(Date.now())
  const limits = provider.config.rateLimit
  const address = await limits?.getClientAddress?.(request)
  await limit(auth, 'total', limits?.total ?? 100, 3600000)
  if (address) await limit(auth, `ip:${address}`, limits?.perIp ?? 20, 3600000)
  await limit(auth, `cooldown:${email}`, 1, (limits?.resendAfter ?? 60) * 1000)
  await limit(auth, `address:${email}`, limits?.perAddress ?? 5, 3600000)

  const id = randomSecret()
  const browserSecret = randomSecret()
  const code = provider.config.mode !== 'link' ? randomCode() : undefined
  const linkToken = provider.config.mode !== 'code' && !tokenSession ? randomSecret() : undefined
  const expiresAt = Date.now() + provider.config.expiresIn * 1000
  const challenge: Challenge = {
    email,
    purpose,
    userId: user?.id,
    redirectTo,
    tokenSession,
    codeHash: code && (await auth.hashVerification(`${id}:code:${code}`)),
    linkHash: linkToken && (await auth.hashVerification(`${id}:link:${linkToken}`)),
    clientChallenge: body.clientChallenge,
    browserHash: await auth.hashVerification(browserSecret),
    attempts: 0,
    used: false,
  }
  const record = { id, value: JSON.stringify(challenge), expiresAt, version: 0 }
  if (!(await auth.verification!.set(record, null))) throw new GauError(ErrorCodes.INTERNAL_ERROR)
  const url = new URL(`${auth.basePath}/callback/email`, request.url)
  url.searchParams.set('challengeId', id)
  if (linkToken) url.searchParams.set('token', linkToken)
  try {
    const content = await (provider.config.render ?? renderEmail)({
      email,
      code,
      url: linkToken ? url.href : undefined,
      expiresAt: new Date(expiresAt),
      purpose,
    })
    await provider.config.send({ ...content, from: provider.config.from, to: email })
  } catch {
    await change(auth, id, (current) => ({
      ...current!,
      value: JSON.stringify({ ...challenge, used: true }),
      version: (current?.version ?? 0) + 1,
    }))
    throw new GauError(ErrorCodes.EMAIL_SEND_FAILED)
  }
  const cookies = new Cookies(parseCookies(request.headers.get('cookie')), auth.cookieOptions)
  if (linkToken)
    cookies.set(cookieName(id), browserSecret, {
      httpOnly: true,
      sameSite: 'lax',
      secure: !auth.development,
      maxAge: provider.config.expiresIn,
      path: auth.basePath,
    })
  return json(
    { status: 'verification-required', challengeId: id, expiresAt, retryAfter: limits?.resendAfter ?? 60 },
    { headers: cookies.toHeaders() },
  )
}

async function resolveUser(auth: Auth, challenge: Challenge, request: Request): Promise<User> {
  const accountUser = await auth.getUserByAccount('email', challenge.email)
  let user: User | null = null
  if (challenge.purpose === 'link') {
    user = await sessionUser(request, auth)
    if (user.id !== challenge.userId) throw new GauError(ErrorCodes.UNAUTHORIZED)
    if (accountUser && accountUser.id !== user.id) throw new GauError(ErrorCodes.ACCOUNT_ALREADY_LINKED)
    const emailOwner = await auth.getUserByEmail(challenge.email)
    if (emailOwner && emailOwner.id !== user.id) throw new GauError(ErrorCodes.EMAIL_ALREADY_EXISTS)
    if (!auth.allowDifferentEmails && user.email && user.email !== challenge.email)
      throw new GauError(ErrorCodes.EMAIL_MISMATCH)
    const existing = (await auth.getAccounts(user.id)).find((a) => a.provider === 'email')
    if (existing && existing.providerAccountId !== challenge.email)
      throw new GauError(ErrorCodes.ACCOUNT_ALREADY_LINKED, 'Unlink the current email before linking another.')
  } else {
    user = accountUser
    if (!user) {
      user = await auth.getUserByEmail(challenge.email)
      if (user && auth.autoLink === false) throw new GauError(ErrorCodes.EMAIL_ALREADY_EXISTS)
    }
  }
  if (!user) {
    const role =
      auth.roles.resolveOnCreate?.({
        providerId: 'email',
        profile: { email: challenge.email, emailVerified: true },
        request,
      }) ?? auth.roles.defaultRole
    try {
      user = await auth.createUser({ email: challenge.email, emailVerified: true, role })
    } catch {
      user = await auth.getUserByEmail(challenge.email)
      if (!user || auth.autoLink === false) throw new GauError(ErrorCodes.USER_CREATE_FAILED)
    }
  }
  if (!accountUser) {
    try {
      await auth.linkAccount({ userId: user.id, provider: 'email', providerAccountId: challenge.email, type: 'email' })
    } catch {
      const linked = await auth.getUserByAccount('email', challenge.email)
      if (linked?.id !== user.id) throw new GauError(ErrorCodes.ACCOUNT_LINK_FAILED)
    }
  }
  if (!user.email || (user.email === challenge.email && !user.emailVerified))
    user = await auth.updateUser({ id: user.id, email: challenge.email, emailVerified: true })
  return user
}

async function readChallenge(auth: Auth, id: unknown): Promise<{ record: VerificationRecord; challenge: Challenge }> {
  if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw invalid()
  const record = await auth.verification!.get(id)
  if (!record || record.expiresAt <= Date.now()) throw invalid()
  const challenge = JSON.parse(record.value) as Challenge
  if (challenge.used) throw invalid()
  return { record, challenge }
}

export async function handleEmail(
  request: Request,
  auth: Auth,
  purpose: Challenge['purpose'] = 'signin',
  magicLink = false,
): Promise<Response> {
  const provider = emailProvider(auth)
  const body =
    request.method === 'GET' ? Object.fromEntries(new URL(request.url).searchParams) : await readBody(request)
  if (!magicLink && 'email' in body) {
    if ('challengeId' in body || 'code' in body) throw new GauError(ErrorCodes.INVALID_REQUEST)
    return start(request, auth, provider, body, purpose)
  }
  const { record, challenge } = await readChallenge(auth, body.challengeId)
  if (challenge.attempts >= provider.config.maxAttempts || (!magicLink && challenge.purpose !== purpose))
    throw invalid()
  if (challenge.purpose === 'link' && (await sessionUser(request, auth)).id !== challenge.userId)
    throw new GauError(ErrorCodes.UNAUTHORIZED)
  if (challenge.purpose === 'signin' && provider.linkOnly) throw new GauError(ErrorCodes.LINK_ONLY_PROVIDER)
  const cookies = new Cookies(parseCookies(request.headers.get('cookie')), auth.cookieOptions)
  let matches: boolean
  if (magicLink) {
    const browserSecret = cookies.get(cookieName(record.id))
    if (!browserSecret || (await auth.hashVerification(browserSecret)) !== challenge.browserHash)
      throw new GauError(ErrorCodes.EMAIL_BROWSER_MISMATCH)
    matches =
      typeof body.token === 'string' &&
      !!challenge.linkHash &&
      (await auth.hashVerification(`${record.id}:link:${body.token}`)) === challenge.linkHash
  } else {
    if (
      typeof body.verifier !== 'string' ||
      body.verifier.length > 128 ||
      (await sha256(body.verifier)) !== challenge.clientChallenge
    )
      throw invalid()
    matches =
      typeof body.code === 'string' &&
      /^\d{6}$/.test(body.code) &&
      !!challenge.codeHash &&
      (await auth.hashVerification(`${record.id}:code:${body.code}`)) === challenge.codeHash
  }
  if (request.method === 'GET') {
    if (!matches) throw invalid()
    return htmlResponse(
      renderEmailConfirmation({
        email: challenge.email,
        linking: challenge.purpose === 'link',
        action: `${auth.basePath}/callback/email`,
        challengeId: record.id,
        token: String(body.token),
      }),
    )
  }
  await change(auth, record.id, (current) => {
    if (!current || current.expiresAt <= Date.now()) throw invalid()
    const latest = JSON.parse(current.value) as Challenge
    if (latest.used || latest.attempts >= provider.config.maxAttempts) throw invalid()
    return {
      ...current,
      version: current.version + 1,
      value: JSON.stringify({ ...latest, attempts: latest.attempts + 1, used: matches }),
    }
  })
  if (!matches) throw invalid()
  const user = await resolveUser(auth, challenge, request)
  const response = magicLink ? redirect(challenge.redirectTo, 303) : json({ status: 'authenticated' })
  if (challenge.purpose === 'signin') {
    const session = await auth.issueSession(user.id)
    if (challenge.tokenSession) return json({ status: 'authenticated', token: session.token })
    cookies.set(SESSION_COOKIE_NAME, session.token, {
      maxAge: session.maxAge,
      secure: auth.development ? false : auth.cookieOptions.secure,
    })
  }
  if (challenge.linkHash) {
    cookies.delete(cookieName(record.id), { path: auth.basePath })
  }
  cookies.toHeaders().forEach((value, key) => response.headers.append(key, value))
  return response
}
