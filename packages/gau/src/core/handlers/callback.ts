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

export async function handleCallback(request: Request, auth: Auth, providerId: string): Promise<Response> {
  const provider = auth.providerMap.get(providerId)
  if (!provider)
    throw new GauError(ErrorCodes.PROVIDER_NOT_FOUND)

  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const error = url.searchParams.get('error')

  if (!code || !state || error) {
    // Try to extract redirect URL from state if available
    let redirectTo = '/'
    if (state && state.includes('.')) {
      try {
        const encodedRedirect = state.split('.')[1]
        redirectTo = atob(encodedRedirect ?? '') || '/'
      }
      catch {
        redirectTo = '/'
      }
    }

    // OAuth was cancelled - show a nice page and redirect back
    const html = renderCancelledPage({ redirectUrl: redirectTo })
    return htmlResponse(html)
  }

  const requestCookies = parseCookies(request.headers.get('Cookie'))
  const cookies = new Cookies(requestCookies, auth.cookieOptions)

  let savedState: string | undefined
  let redirectTo = '/'
  if (state.includes('.')) {
    const [originalSavedState, encodedRedirect] = state.split('.')
    savedState = originalSavedState
    try {
      redirectTo = atob(encodedRedirect ?? '') || '/'
    }
    catch {
      redirectTo = '/'
    }
  }
  else {
    savedState = state
  }

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

  const isLinking = !!linkingToken

  if (isLinking) {
    const session = await auth.validateSession(linkingToken!)
    if (!session) {
      cookies.delete(CSRF_COOKIE_NAME)
      cookies.delete(PKCE_COOKIE_NAME)
      if (callbackUri)
        cookies.delete(CALLBACK_URI_COOKIE_NAME)
      cookies.delete(PROVIDER_OPTIONS_COOKIE_NAME)
      const response = redirect(redirectTo)
      cookies.toHeaders().forEach((value, key) => response.headers.append(key, value))
      return response
    }
  }

  const { user: rawProviderUser, tokens } = await provider.validateCallback(code, codeVerifier, callbackUri ?? undefined, providerOverrides)

  {
    const session = isLinking ? await auth.validateSession(linkingToken!) : null
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
      sessionUserId: session?.user?.id,
    })
    if (hookResult.handled) {
      cookies.delete(CSRF_COOKIE_NAME)
      cookies.delete(PKCE_COOKIE_NAME)
      if (callbackUri)
        cookies.delete(CALLBACK_URI_COOKIE_NAME)
      cookies.delete(PROVIDER_OPTIONS_COOKIE_NAME)
      const response = hookResult.response
      cookies.toHeaders().forEach((value, key) => response.headers.append(key, value))
      return response
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
    cookies.delete(CSRF_COOKIE_NAME)
    cookies.delete(PKCE_COOKIE_NAME)
    if (callbackUri)
      cookies.delete(CALLBACK_URI_COOKIE_NAME)
    cookies.delete(PROVIDER_OPTIONS_COOKIE_NAME)
    throw new GauError(ErrorCodes.LINK_ONLY_PROVIDER, { redirectUrl: redirectTo })
  }

  let user: User | null = null

  const userFromAccount = await auth.getUserByAccount(providerId, providerUser.id)

  if (isLinking) {
    const session = await auth.validateSession(linkingToken)
    user = session!.user

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
    // GitHub sometimes doesn't return these which causes arctic to throw an error
    let refreshToken: string | null
    try {
      refreshToken = tokens.refreshToken()
    }
    catch {
      refreshToken = null
    }

    let expiresAt: number | undefined
    try {
      const expiresAtDate = tokens.accessTokenExpiresAt()
      if (expiresAtDate)
        expiresAt = Math.floor(expiresAtDate.getTime() / 1000)
    }
    catch {
    }

    let idToken: string | null
    try {
      idToken = tokens.idToken()
    }
    catch {
      idToken = null
    }

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
        cookies.toHeaders().forEach((value, key) => response.headers.append(key, value))
        return response
      }
    }

    try {
      let scope: string | null
      try {
        scope = tokens.scopes()?.join(' ') ?? null
      }
      catch {
        scope = null
      }

      await auth.linkAccount({
        userId: user.id,
        provider: providerId,
        providerAccountId: providerUser.id,
        accessToken: tokens.accessToken(),
        refreshToken,
        expiresAt,
        tokenType: tokens.tokenType?.() ?? null,
        scope,
        idToken,
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
        let refreshToken: string | null
        try {
          refreshToken = tokens.refreshToken()
        }
        catch {
          refreshToken = existing.refreshToken ?? null
        }

        let expiresAt: number | undefined
        try {
          const expiresAtDate = tokens.accessTokenExpiresAt()
          if (expiresAtDate)
            expiresAt = Math.floor(expiresAtDate.getTime() / 1000)
        }
        catch {
          expiresAt = existing.expiresAt ?? undefined
        }

        let idToken: string | null
        try {
          idToken = tokens.idToken()
        }
        catch {
          idToken = existing.idToken ?? null
        }

        let scope: string | null
        try {
          scope = tokens.scopes()?.join(' ') ?? existing.scope ?? null
        }
        catch {
          scope = existing.scope ?? null
        }

        await auth.updateAccount({
          userId: user!.id,
          provider: providerId,
          providerAccountId: providerUser.id,
          accessToken: tokens.accessToken() ?? existing.accessToken ?? undefined,
          refreshToken,
          expiresAt: expiresAt ?? existing.expiresAt ?? undefined,
          tokenType: tokens.tokenType?.() ?? existing.tokenType ?? null,
          scope,
          idToken,
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

  const requestUrl = new URL(request.url)
  const redirectUrl = new URL(redirectTo, request.url)

  const forceToken = auth.sessionStrategy === 'token'
  const forceCookie = auth.sessionStrategy === 'cookie'

  const isCustomScheme = redirectUrl.protocol !== 'http:' && redirectUrl.protocol !== 'https:'
  const isCrossHost = requestUrl.host !== redirectUrl.host

  // For Tauri, we can't set a cookie on a custom protocol or a different host,
  // so we pass the token in the URL. Additionally, return a small HTML page
  // that immediately navigates to the deep-link and attempts to close the window,
  // so the external OAuth tab does not stay open.
  if (forceToken || (!forceCookie && (isCustomScheme || isCrossHost))) {
    const destination = new URL(redirectUrl)
    const clientChallenge = cookies.get(CLIENT_CHALLENGE_COOKIE_NAME)

    if (clientChallenge) {
      // PKCE
      const authCode = await auth.signJWT({
        sub: user.id,
        challenge: clientChallenge,
      }, { ttl: 60 })

      destination.searchParams.set('code', authCode)
    }
    else {
      throw new GauError(ErrorCodes.PKCE_CHALLENGE_MISSING, { redirectUrl: redirectTo })
    }

    // Use success page template instead of inline HTML
    const html = renderSuccessPage({ redirectUrl: destination.toString() })

    // Clear temporary cookies (CSRF/PKCE/Callback URI) so they don't linger
    cookies.delete(CSRF_COOKIE_NAME)
    cookies.delete(PKCE_COOKIE_NAME)
    if (callbackUri)
      cookies.delete(CALLBACK_URI_COOKIE_NAME)
    cookies.delete(PROVIDER_OPTIONS_COOKIE_NAME)
    cookies.delete(CLIENT_CHALLENGE_COOKIE_NAME)

    const response = htmlResponse(html)
    cookies.toHeaders().forEach((value, key) => {
      response.headers.append(key, value)
    })
    return response
  }

  cookies.set(SESSION_COOKIE_NAME, sessionToken, {
    maxAge: auth.jwt.ttl,
    sameSite: auth.development ? 'lax' : 'none',
    secure: !auth.development,
  })
  cookies.delete(CSRF_COOKIE_NAME)
  cookies.delete(PKCE_COOKIE_NAME)
  if (callbackUri)
    cookies.delete(CALLBACK_URI_COOKIE_NAME)
  cookies.delete(PROVIDER_OPTIONS_COOKIE_NAME)

  const redirectParam = url.searchParams.get('redirect')

  let response: Response
  if (redirectParam === 'false') {
    const accounts = await auth.getAccounts(user.id)
    const isAdmin = Boolean(
      (user.role && auth.roles.adminRoles.includes(user.role))
      || auth.roles.adminUserIds.includes(user.id),
    )
    response = json({ user: { ...user, isAdmin, accounts } })
  }
  else {
    response = redirect(redirectTo)
  }

  cookies.toHeaders().forEach((value, key) => {
    response.headers.append(key, value)
  })

  return response
}
