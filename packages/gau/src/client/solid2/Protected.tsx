import type { Accessor } from 'solid-js'
import type { JSX } from '@solidjs/web'
import type { GauSession, ProviderIds } from '../../core'
import { useNavigate } from '@solidjs/router'
import { onSettled, Show } from 'solid-js'
import { isServer } from '@solidjs/web'
import { useAuth } from './index'

function onClientReady(fn: () => void | (() => void)) {
  if (isServer)
    return

  onSettled(fn)
}

export function Protected<const TAuth = unknown>(
  page: (session: Accessor<GauSession<ProviderIds<TAuth>>>) => JSX.Element,
  fallbackOrRedirect?: (() => JSX.Element) | string,
): () => JSX.Element {
  return () => {
    const auth = useAuth<TAuth>()
    const navigate = useNavigate()

    const isRedirectMode = typeof fallbackOrRedirect === 'string' || fallbackOrRedirect === undefined
    const redirectTo = isRedirectMode ? (fallbackOrRedirect ?? '/') : undefined
    const Fallback = !isRedirectMode ? (fallbackOrRedirect as (() => JSX.Element)) : undefined

    const Redirect = () => {
      onClientReady(() => {
        if (!isServer && redirectTo)
          navigate(redirectTo, { replace: true })
      })
      return null
    }

    return (
      <Show when={!auth.isLoading()} fallback={null}>
        <Show
          when={auth.session().user}
          fallback={isRedirectMode ? <Redirect /> : (Fallback ? <Fallback /> : null)}
        >
          {page(auth.session)}
        </Show>
      </Show>
    )
  }
}
