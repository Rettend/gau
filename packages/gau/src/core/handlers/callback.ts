import type { Auth } from '../createAuth'
import type { User } from '../index'
import {
  CALLBACK_URI_COOKIE_NAME,
  CLIENT_CHALLENGE_COOKIE_NAME,
  Cookies,
  CSRF_COOKIE_NAME,
  LINKING_TOKEN_COOKIE_NAME,
  parseCookies,
  PKCE_COOKIE_NAME,
  PROVIDER_OPTIONS_COOKIE_NAME,
  SESSION_COOKIE_NAME,
} from '../cookies'
import { ErrorCodes, GauError } from '../errors'
import { maybeMapExternalProfile, runOnAfterLinkAccount, runOnBeforeLinkAccount, runOnOAuthExchange } from '../hooks'
import { json, redirect } from '../index'
import { htmlResponse, renderCancelledPage, renderSuccessPage } from '../templates'

type Session = Awaited<ReturnType<Auth['validateSession']>>
type TokenSnapshot = {
  accessToken: string | null
  refreshToken: string | null
  expiresAt: number | undefined
  tokenType: string | null
  scope: string | null
  idToken: string | null
}

function appendCookieHeaders(response: Response, cookies: Cookies): Response {
  cookies.toHeaders().forEach((value, key) => response.headers.append(key, value))
  return response
}

function clearTemporaryCookies(cookies: Cookies, callbackUri?: string | null, options: { clientChallenge?: boolean } = {}): void {
  cookies.delete(CSRF_COOKIE_NAME)
  cookies.delete(PKCE_COOKIE_NAME)
  if (callbackUri)
    cookies.delete(CALLBACK_URI_COOKIE_NAME)
  cookies.delete(PROVIDER_OPTIONS_COOKIE_NAME)
  if (options.clientChallenge)
    cookies.delete(CLIENT_CHALLENGE_COOKIE_NAME)
}

function parseRedirectTarget(encodedRedirect?: string): string {
  try {
    return atob(encodedRedirect ?? '') || '/'
  }
  catch {
    return '/'
  }
}

function parseCallbackState(state: string): { savedState: string, redirectTo: string } {
  if (!state.includes('.'))
    return { savedState: state, redirectTo: '/' }

  const [savedState = state, encodedRedirect] = state.split('.')
  return {
    savedState,
    redirectTo: parseRedirectTarget(encodedRedirect),
  }
}

function resolveCancelledRedirectTarget(state: string | null): string {
  if (!state || !state.includes('.'))
    return '/'

  return parseRedirectTarget(state.split('.')[1])
}

async function resolveLinkingSession(auth: Auth, linkingToken: string | undefined): Promise<{ isLinking: boolean, session: Session }> {
  if (!linkingToken)
    return { isLinking: false, session: null }

  return {
    isLinking: true,
    session: await auth.validateSession(linkingToken),
  }
}

function readOptionalToken<T>(read: () => T, fallback: T): T {
  try {
    return read()
  }
  catch {
    return fallback
  }
}

function normalizeTokens(tokens: any, fallback?: Partial<TokenSnapshot>, options: { requireAccessToken?: boolean } = {}): TokenSnapshot {
  return {
    accessToken: options.requireAccessToken
      ? tokens.accessToken()
      : readOptionalToken(() => tokens.accessToken() ?? fallback?.accessToken ?? null, fallback?.accessToken ?? null),
    refreshToken: readOptionalToken(() => tokens.refreshToken(), fallback?.refreshToken ?? null),
    expiresAt: readOptionalToken(() => {
      const expiresAtDate = tokens.accessTokenExpiresAt()
      return expiresAtDate ? Math.floor(expiresAtDate.getTime() / 1000) : fallback?.expiresAt ?? undefined
    }, fallback?.expiresAt ?? undefined),
    tokenType: readOptionalToken(() => tokens.tokenType?.() ?? fallback?.tokenType ?? null, fallback?.tokenType ?? null),
    scope: readOptionalToken(() => tokens.scopes()?.join(' ') ?? fallback?.scope ?? null, fallback?.scope ?? null),
    idToken: readOptionalToken(() => tokens.idToken(), fallback?.idToken ?? null),
  }
}

async function buildFinalResponse(
  request: Request,
  auth: Auth,
  user: User,
  redirectTo: string,
  sessionToken: string,
  url: URL,
  cookies: Cookies,
  callbackUri?: string | null,
): Promise<Response> {
  const requestUrl = new URL(request.url)
  const redirectUrl = new URL(redirectTo, request.url)

  const forceToken = auth.sessionStrategy === 'token'
  const forceCookie = auth.sessionStrategy === 'cookie'

  const isCustomScheme = redirectUrl.protocol !== 'http:' && redirectUrl.protocol !== 'https:'
  const isCrossHost = requestUrl.host !== redirectUrl.host

  if (forceToken || (!forceCookie && (isCustomScheme || isCrossHost))) {
    const destination = new URL(redirectUrl)
    const clientChallenge = cookies.get(CLIENT_CHALLENGE_COOKIE_NAME)

    if (!clientChallenge)
      throw new GauError(ErrorCodes.PKCE_CHALLENGE_MISSING, { redirectUrl: redirectTo })

    const authCode = await auth.signJWT({
      sub: user.id,
      challenge: clientChallenge,
    }, { ttl: 60 })

    destination.searchParams.set('code', authCode)

    clearTemporaryCookies(cookies, callbackUri, { clientChallenge: true })
    return appendCookieHeaders(htmlResponse(renderSuccessPage({ redirectUrl: destination.toString() })), cookies)
  }

  cookies.set(SESSION_COOKIE_NAME, sessionToken, {
    maxAge: auth.jwt.ttl,
    sameSite: auth.development ? 'lax' : 'none',
    secure: !auth.development,
  })
  clearTemporaryCookies(cookies, callbackUri)

  const response = url.searchParams.get('redirect') === 'false'
    ? json({
        user: {
          ...user,
          isAdmin: Boolean(
            (user.role && auth.roles.adminRoles.includes(user.role))
            || auth.roles.adminUserIds.includes(user.id),
          ),
          accounts: await auth.getAccounts(user.id),
        },
      })
    : redirect(redirectTo)

  return appendCookieHeaders(response, cookies)
}

export async function handleCallback(request: Request, auth: Auth, providerId: string): Promise<Response> {
  const provider = auth.providerMap.get(providerId)
  if (!provider)
    throw new GauError(ErrorCodes.PROVIDER_NOT_FOUND)

  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const error = url.searchParams.get('error')

  if (!code || !state || error) {
    return htmlResponse(renderCancelledPage({ redirectUrl: resolveCancelledRedirectTarget(state) }))
  }

  const requestCookies = parseCookies(request.headers.get('Cookie'))
  const cookies = new Cookies(requestCookies, auth.cookieOptions)

  const { savedState, redirectTo } = parseCallbackState(state)

  const csrfToken = cookies.get(CSRF_COOKIE_NAME)

  if (!csrfToken || csrfToken !== savedState)
    throw new GauError(ErrorCodes.CSRF_INVALID, { redirectUrl: redirectTo })

  const codeVerifier = cookies.get(PKCE_COOKIE_NAME)
  if (!codeVerifier)
    throw new GauError(ErrorCodes.PKCE_MISSING, { redirectUrl: redirectTo })

  const callbackUri = cookies.get(CALLBACK_URI_COOKIE_NAME)
  const providerOptionsRaw = cookies.get(PROVIDER_OPTIONS_COOKIE_NAME)
  let providerOverrides: any | undefined
  if (providerOptionsRaw) {
    try {
      const decoded = atob(providerOptionsRaw)
      const parsed = JSON.parse(decoded)
      providerOverrides = parsed?.overrides
    }
    catch {}
  }
  const linkingToken = cookies.get(LINKING_TOKEN_COOKIE_NAME)

  if (linkingToken)
    cookies.delete(LINKING_TOKEN_COOKIE_NAME)

  const { isLinking, session: linkingSession } = await resolveLinkingSession(auth, linkingToken ?? undefined)

  if (isLinking && !linkingSession) {
    clearTemporaryCookies(cookies, callbackUri, { clientChallenge: true })
    return appendCookieHeaders(redirect(redirectTo), cookies)
  }

  const { user: rawProviderUser, tokens } = await provider.validateCallback(code, codeVerifier, callbackUri ?? undefined, providerOverrides)

  {
    const hookResult = await runOnOAuthExchange(auth, {
      request,
      providerId,
      state,
      code,
      codeVerifier,
      callbackUri,
      redirectTo,
      cookies,
      providerUser: rawProviderUser,
      tokens,
      isLinking,
      sessionUserId: linkingSession?.user?.id,
    })
    if (hookResult.handled) {
      clearTemporaryCookies(cookies, callbackUri, { clientChallenge: true })
      return appendCookieHeaders(hookResult.response, cookies)
    }
  }

  const providerUser = await maybeMapExternalProfile(auth, {
    request,
    providerId,
    providerUser: rawProviderUser,
    tokens,
    isLinking,
  })

  // Enforce provider-level link-only when not linking (profile-level enforced at redirect time)
  if (!isLinking && (auth.providerMap.get(providerId)?.linkOnly === true)) {
    clearTemporaryCookies(cookies, callbackUri)
    throw new GauError(ErrorCodes.LINK_ONLY_PROVIDER, { redirectUrl: redirectTo })
  }

  let user: User | null = null

  const userFromAccount = await auth.getUserByAccount(providerId, providerUser.id)

  if (isLinking) {
    user = linkingSession!.user

    if (!user)
      throw new GauError(ErrorCodes.USER_NOT_FOUND, { redirectUrl: redirectTo })

    if (userFromAccount && userFromAccount.id !== user.id)
      throw new GauError(ErrorCodes.ACCOUNT_ALREADY_LINKED, { redirectUrl: redirectTo })

    if (auth.allowDifferentEmails === false) {
      const currentEmail = user.email
      const providerEmail = providerUser.email
      if (currentEmail && providerEmail && currentEmail !== providerEmail)
        throw new GauError(ErrorCodes.EMAIL_MISMATCH, { redirectUrl: redirectTo })
    }

    if (user) {
      const update: Partial<User> & { id: string } = { id: user.id }
      let needsUpdate = false

      if (auth.updateUserInfoOnLink) {
        if (providerUser.name && providerUser.name !== user.name) {
          update.name = providerUser.name
          needsUpdate = true
        }
        if (providerUser.avatar && providerUser.avatar !== user.image) {
          update.image = providerUser.avatar
          needsUpdate = true
        }
      }
      else {
        if (!user.name && providerUser.name) {
          update.name = providerUser.name
          needsUpdate = true
        }
        if (!user.image && providerUser.avatar) {
          update.image = providerUser.avatar
          needsUpdate = true
        }
      }

      if (
        user.email
        && providerUser.email
        && user.email === providerUser.email
        && providerUser.emailVerified === true
        && (!user.emailVerified || auth.updateUserInfoOnLink)
      ) {
        update.emailVerified = true
        needsUpdate = true
      }

      if (needsUpdate) {
        try {
          user = await auth.updateUser(update)
        }
        catch (e) {
          console.error('Failed to update user info on link:', e)
        }
      }
    }
  }
  else {
    user = userFromAccount
  }

  if (!user) {
    const autoLink = auth.autoLink ?? 'verifiedEmail'
    const shouldLinkByEmail = providerUser.email && (
      (autoLink === 'always')
      || (autoLink === 'verifiedEmail' && providerUser.emailVerified === true)
    )
    if (shouldLinkByEmail) {
      const existingUser = await auth.getUserByEmail(providerUser.email!)
      if (existingUser) {
        // If the email is verified by the new provider, and the existing user's email is not,
        // update the user's email verification status.
        if (providerUser.emailVerified && !existingUser.emailVerified) {
          user = await auth.updateUser({
            id: existingUser.id,
            emailVerified: true,
          })
        }
        else {
          user = existingUser
        }
      }
    }
    if (!user) {
      try {
        if (providerUser.email && providerUser.emailVerified === true && auth.autoLink === false) {
          const existingWithSameEmail = await auth.getUserByEmail(providerUser.email)
          if (existingWithSameEmail)
            throw new GauError(ErrorCodes.EMAIL_ALREADY_EXISTS, { redirectUrl: redirectTo })
        }

        let resolvedRole: string | undefined
        try {
          resolvedRole = auth.roles.resolveOnCreate?.({ providerId, profile: providerUser, request: request as unknown as Request })
        }
        catch (e) {
          console.error('roles.resolveOnCreate threw:', e)
        }

        const emailToStore = providerUser.emailVerified === true ? providerUser.email : null

        user = await auth.createUser({
          name: providerUser.name,
          email: emailToStore,
          image: providerUser.avatar,
          emailVerified: providerUser.emailVerified,
          role: resolvedRole ?? auth.roles.defaultRole,
        })
      }
      catch (error) {
        if (error instanceof GauError)
          throw error
        console.error('Failed to create user:', error)
        throw new GauError(ErrorCodes.USER_CREATE_FAILED, { cause: error, redirectUrl: redirectTo })
      }
    }
  }

  // self-healing: update user's email if it's missing or unverified and the provider returns a verified email
  if (user && providerUser.email) {
    const { email: currentEmail, emailVerified: currentEmailVerified } = user
    const { email: providerEmail, emailVerified: providerEmailVerified } = providerUser

    const update: Partial<User> & { id: string } = { id: user.id }
    let needsUpdate = false

    // user has no primary email. promote the provider's email but only if it's verified.
    if (!currentEmail && providerEmailVerified === true) {
      update.email = providerEmail
      update.emailVerified = true
      needsUpdate = true
    }
    // user has an unverified primary email, and the provider confirms this same email is verified.
    else if (
      currentEmail === providerEmail
      && providerEmailVerified === true
      && !currentEmailVerified
    ) {
      update.emailVerified = true
      needsUpdate = true
    }

    if (needsUpdate) {
      try {
        user = await auth.updateUser(update)
      }
      catch (error) {
        console.error('Failed to update user after sign-in:', error)
      }
    }
  }

  if (!userFromAccount) {
    {
      const pre = await runOnBeforeLinkAccount(auth, {
        request,
        providerId,
        userId: user.id,
        providerUser,
        tokens,
      })
      if (pre.allow === false) {
        const response = pre.response ?? (() => {
          throw new GauError(ErrorCodes.LINKING_NOT_ALLOWED, { redirectUrl: redirectTo })
        })()
        clearTemporaryCookies(cookies, callbackUri, { clientChallenge: true })
        return appendCookieHeaders(response, cookies)
      }
    }

    try {
      const normalizedTokens = normalizeTokens(tokens, undefined, { requireAccessToken: true })

      await auth.linkAccount({
        userId: user.id,
        provider: providerId,
        providerAccountId: providerUser.id,
        accessToken: normalizedTokens.accessToken,
        refreshToken: normalizedTokens.refreshToken,
        expiresAt: normalizedTokens.expiresAt,
        tokenType: normalizedTokens.tokenType,
        scope: normalizedTokens.scope,
        idToken: normalizedTokens.idToken,
      })
      await runOnAfterLinkAccount(auth, {
        request,
        providerId,
        userId: user.id,
        providerUser,
        tokens,
        action: 'link',
      })
    }
    catch (error) {
      console.error('Error linking account:', error)
      throw new GauError(ErrorCodes.ACCOUNT_LINK_FAILED, { cause: error, redirectUrl: redirectTo })
    }
  }
  else {
    // Existing account: update stored tokens on sign-in (access/refresh/expires/idToken/etc.)
    try {
      const accounts = await auth.getAccounts(user!.id)
      const existing = accounts.find(a => a.provider === providerId && a.providerAccountId === providerUser.id)

      if (existing && auth.updateAccount) {
        const normalizedTokens = normalizeTokens(tokens, {
          accessToken: existing.accessToken ?? null,
          refreshToken: existing.refreshToken ?? null,
          expiresAt: existing.expiresAt ?? undefined,
          tokenType: existing.tokenType ?? null,
          scope: existing.scope ?? null,
          idToken: existing.idToken ?? null,
        })

        await auth.updateAccount({
          userId: user!.id,
          provider: providerId,
          providerAccountId: providerUser.id,
          accessToken: normalizedTokens.accessToken ?? undefined,
          refreshToken: normalizedTokens.refreshToken,
          expiresAt: normalizedTokens.expiresAt,
          tokenType: normalizedTokens.tokenType,
          scope: normalizedTokens.scope,
          idToken: normalizedTokens.idToken,
        })
        await runOnAfterLinkAccount(auth, {
          request,
          providerId,
          userId: user!.id,
          providerUser,
          tokens,
          action: 'update',
        })
      }
    }
    catch (error) {
      console.error('Failed to update account tokens on sign-in:', error)
    }
  }

  const sessionToken = await auth.createSession(user.id)
  return buildFinalResponse(request, auth, user, redirectTo, sessionToken, url, cookies, callbackUri)
}
