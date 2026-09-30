import type { APIRoute, MiddlewareHandler } from 'astro'
import type { CreateAuthOptions, GauSession, GauServerSession, ProviderIds, RefreshSessionOptions } from '../core'
import type { AuthInstance } from '../core/serverSession'
import type { AuthProvider } from '../core/providers'
import { DEV } from 'esm-env'
import { createWebAuth } from '../core/webAuth'

export interface GauAstroLocals<TAuth = unknown> {
  getSession: () => Promise<GauSession<ProviderIds<TAuth>>>
  getServerSession: () => Promise<GauServerSession<ProviderIds<TAuth>>>
}

export function AstroAuth<const TProviders extends AuthProvider[]>(
  auth: CreateAuthOptions<TProviders> | AuthInstance<TProviders>,
  options: { refresh?: false | RefreshSessionOptions } = {},
) {
  const web = createWebAuth(auth, { development: DEV })
  const handler: APIRoute = (ctx) => web.handle(ctx.request)
  const onRequest: MiddlewareHandler = (ctx, next) => {
    Object.assign(ctx.locals, {
      getSession: () => web.getSession(ctx.request),
      getServerSession: () => web.getServerSession(ctx.request),
    })
    return options.refresh === false ? next() : web.refresh(ctx.request, next, options.refresh)
  }
  return { ...web, GET: handler, POST: handler, OPTIONS: handler, onRequest }
}
