import { authMiddleware } from '@rttnd/gau/solidstart'
import { createMiddleware } from '@solidjs/start/middleware'
import { auth } from './server/auth'

export default createMiddleware({
  onRequest: [authMiddleware(true, auth)],
})
