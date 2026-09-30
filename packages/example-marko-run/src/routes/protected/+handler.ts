import { gau } from '../../server/auth'

export const GET = Run.GET(async (ctx, next) => {
  const session = await gau.getSession(ctx.request)
  if (!session.user) return ctx.redirect('/')
  return next({ session })
})
