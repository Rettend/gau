import { authMiddleware, refreshMiddleware } from '@rttnd/gau/solid2'
import { createAPIHandler } from 'filesystem-routing/api'
import routes from 'virtual:file-routes'
import { auth } from './server/auth'

export default [
  authMiddleware(auth),
  refreshMiddleware(auth, { threshold: 0.5 }),
  createAPIHandler(routes),
]
