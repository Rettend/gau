import { gau } from '../server/auth'

export default Run.ALL((ctx, next) => gau.refresh(ctx.request, () => next()))
