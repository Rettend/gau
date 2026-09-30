import { gau } from '../server/auth'

export const GET = Run.GET((ctx, next) => next({ session: gau.getSession(ctx.request) }))
