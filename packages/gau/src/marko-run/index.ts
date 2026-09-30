import type { CreateAuthOptions } from '../core'
import type { AuthInstance } from '../core/serverSession'
import type { AuthProvider } from '../core/providers'
import { DEV } from 'esm-env'
import { createWebAuth } from '../core/webAuth'

/** Use handle in Run.GET/POST/OPTIONS and pass session promises through next(data). */
export function MarkoRunAuth<const TProviders extends AuthProvider[]>(
  auth: CreateAuthOptions<TProviders> | AuthInstance<TProviders>,
) {
  return createWebAuth(auth, { development: DEV })
}
