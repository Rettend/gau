import type { GauSession } from '@rttnd/gau'
import type { AuthClient } from '@rttnd/gau/client/vanilla'
import { createAuthClient } from '@rttnd/gau/client/vanilla'

let client: AuthClient | undefined

export function getBrowserClient(session: GauSession) {
  if (import.meta.env.SSR) return undefined
  return (client ??= createAuthClient({ baseUrl: '/api/auth', session }))
}
