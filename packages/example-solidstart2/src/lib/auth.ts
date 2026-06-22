import type { ProviderIds } from '@rttnd/gau'
import type { Auth } from '~/server/auth'
import { useAuth as useAuthCore } from '@rttnd/gau/client/solid2'

export const useAuth = () => useAuthCore<Auth>()
export type Provider = ProviderIds<Auth>
