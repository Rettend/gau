import { gau } from '../../../../server/auth'

export const GET = Run.GET((ctx) => gau.handle(ctx.request))
export const POST = Run.POST((ctx) => gau.handle(ctx.request))
export const OPTIONS = Run.OPTIONS((ctx) => gau.handle(ctx.request))
