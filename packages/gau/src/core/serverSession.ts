import type { GauServerSession, GauSession } from './index'
import type { CreateAuthOptions, ProviderIds } from './createAuth'
import type { OAuthProvider } from '../oauth'
import { createAuth, NULL_SESSION, toClientSession } from './index'
import { getSessionTokenFromRequest } from './utils'

export type AuthInstance<TProviders extends OAuthProvider<any>[]> = ReturnType<typeof createAuth<TProviders>>

const providerIdsCache = new WeakMap<object, readonly string[]>()

export function resolveAuth<const TProviders extends OAuthProvider<any>[]>(
  optionsOrAuth: CreateAuthOptions<TProviders> | AuthInstance<TProviders>,
): AuthInstance<TProviders> {
  const isInstance = 'providerMap' in optionsOrAuth && 'signJWT' in optionsOrAuth
  return isInstance
    ? optionsOrAuth as AuthInstance<TProviders>
    : createAuth(optionsOrAuth)
}

export function getAuthProviders<const TProviders extends OAuthProvider<any>[]>(
  auth: AuthInstance<TProviders>,
): ProviderIds<AuthInstance<TProviders>>[] {
  let providers = providerIdsCache.get(auth)
  if (!providers) {
    providers = Array.from(auth.providerMap.keys())
    providerIdsCache.set(auth, providers)
  }
  return [...providers] as ProviderIds<AuthInstance<TProviders>>[]
}

export async function resolveServerSession<const TProviders extends OAuthProvider<any>[]>(
  auth: AuthInstance<TProviders>,
  request: Request,
): Promise<GauServerSession<ProviderIds<AuthInstance<TProviders>>>> {
  const { token: sessionToken } = getSessionTokenFromRequest(request)
  const providers = getAuthProviders(auth)

  if (!sessionToken)
    return { ...NULL_SESSION, providers }

  try {
    const validated = await auth.validateSession(sessionToken)
    if (!validated)
      return { ...NULL_SESSION, providers }

    return { ...validated, providers }
  }
  catch {
    return { ...NULL_SESSION, providers }
  }
}

export function createRequestSessionCache<const TProviders extends OAuthProvider<any>[]>(
  auth: AuthInstance<TProviders>,
  request: Request,
  preloadedServerSession?: GauServerSession<ProviderIds<AuthInstance<TProviders>>>,
) {
  let cachedServer: Promise<GauServerSession<ProviderIds<AuthInstance<TProviders>>>> | null = preloadedServerSession
    ? Promise.resolve(preloadedServerSession)
    : null
  let cachedClient: Promise<GauSession<ProviderIds<AuthInstance<TProviders>>>> | null = null

  const getServerSession = (): Promise<GauServerSession<ProviderIds<AuthInstance<TProviders>>>> => {
    return cachedServer ??= resolveServerSession(auth, request)
  }

  const getSession = (): Promise<GauSession<ProviderIds<AuthInstance<TProviders>>>> => {
    return cachedClient ??= getServerSession().then(toClientSession)
  }

  return {
    getServerSession,
    getSession,
  }
}
