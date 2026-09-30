import type { GauSession, ProviderIds } from '../../core'
import type { AuthClient } from '../vanilla'
import { createAuthClient } from '../vanilla'
import { createClientAuth } from '../shared/clientAuth'
import type { ClientAuthControls } from '../shared/clientAuth'

export interface MarkoAuthValue<TAuth = unknown> extends ClientAuthControls<TAuth> {
  session: GauSession<ProviderIds<TAuth>>
  isLoading: boolean
}

/** Create inside a browser lifecycle. Pass the result explicitly to child tags. */
export function createMarkoAuth<TAuth = unknown>(options: {
  session?: GauSession<ProviderIds<TAuth>>
  client?: AuthClient<TAuth>
  baseUrl?: string
  onSession: (session: GauSession<ProviderIds<TAuth>>) => void
  onLoading?: (loading: boolean) => void
}) {
  const client =
    options.client ?? createAuthClient<TAuth>({ baseUrl: options.baseUrl ?? '/api/auth', session: options.session })
  if (options.client && options.session) client.setSession(options.session)
  const auth = createClientAuth({
    client,
    setSession: options.onSession,
    refreshOnMount: !options.session && !options.client,
    onReady: () => options.onLoading?.(false),
    onRefreshing: options.onLoading,
  })
  options.onSession(client.session)
  const dispose = auth.mount()
  return { ...auth.controls, setSession: client.setSession, dispose }
}
