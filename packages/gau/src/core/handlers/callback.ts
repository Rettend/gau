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
import { maybeMapExternalProfile, runOnAfterLinkAccount, runOnBeforeLinkAccount, runOnOAuthExchange } from '../hooks'
import { json, redirect } from '../index'

export async function handleCallback(request: Request, auth: Auth, providerId: string): Promise<Response> {
  const provider = auth.providerMap.get(providerId)
  if (!provider)
    return json({ error: 'Provider not found' }, { status: 400 })

  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')

  if (!code || !state)
    return json({ error: 'Missing code or state' }, { status: 400 })

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
    return json({ error: 'Invalid CSRF token' }, { status: 403 })

  const codeVerifier = cookies.get(PKCE_COOKIE_NAME)
  if (!codeVerifier)
    return json({ error: 'Missing PKCE code verifier' }, { status: 400 })

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
    const response = json({ error: 'Sign-in with this provider is disabled. Please link it to an existing account.' }, { status: 400 })
    cookies.toHeaders().forEach((value, key) => response.headers.append(key, value))
    return response
  }

  let user: User | null = null

  const userFromAccount = await auth.getUserByAccount(providerId, providerUser.id)

  if (isLinking) {
    const session = await auth.validateSession(linkingToken)
    user = session!.user

    if (!user)
      return json({ error: 'User not found' }, { status: 404 })

    if (userFromAccount && userFromAccount.id !== user.id)
      return json({ error: 'Account already linked to another user' }, { status: 409 })

    if (auth.allowDifferentEmails === false) {
      const currentEmail = user.email
      const providerEmail = providerUser.email
      if (currentEmail && providerEmail && currentEmail !== providerEmail)
        return json({ error: 'Email mismatch between existing account and provider' }, { status: 400 })
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
            return json({ error: 'An account with this email already exists. Sign in with the existing method or link the provider.' }, { status: 409 })
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
        console.error('Failed to create user:', error)
        return json({ error: 'Failed to create user' }, { status: 500 })
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
        const response = pre.response ?? json({ error: 'Linking not allowed' }, { status: 403 })
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
      return json({ error: 'Failed to link account' }, { status: 500 })
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
      return json({ error: 'Missing PKCE challenge' }, { status: 400 })
    }

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Authentication Complete</title>
  <style>
    body {
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";
      background-color: #09090b;
      color: #fafafa;
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100vh;
      margin: 0;
      text-align: center;
    }
    .card {
      background-color: #18181b;
      border: 1px solid #27272a;
      border-radius: 0.75rem;
      padding: 2rem;
      max-width: 320px;
    }
    h1 {
      font-size: 1.25rem;
      font-weight: 600;
      margin: 0 0 0.5rem;
    }
    p {
      margin: 0;
      color: #a1a1aa;
    }
  </style>
  <script>
    window.onload = function() {
      const url = ${JSON.stringify(destination.toString())};
      window.location.href = url;
      setTimeout(window.close, 500);
    };
  </script>
</head>
<body>
  <div class="card">
    <h1>Authentication Successful</h1>
    <p>You can now close this window.</p>
  </div>
</body>
</html>`

    // Clear temporary cookies (CSRF/PKCE/Callback URI) so they don't linger
    cookies.delete(CSRF_COOKIE_NAME)
    cookies.delete(PKCE_COOKIE_NAME)
    if (callbackUri)
      cookies.delete(CALLBACK_URI_COOKIE_NAME)
    cookies.delete(PROVIDER_OPTIONS_COOKIE_NAME)
    cookies.delete(CLIENT_CHALLENGE_COOKIE_NAME)

    const response = new Response(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
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
