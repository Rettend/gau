import type { Accessor, JSXElement, VoidComponent } from 'solid-js'
import type { GauSession, ProviderIds } from '../../core'
import { useNavigate } from '@solidjs/router'
import { onMount, Show } from 'solid-js'
import { isServer } from 'solid-js/web'
import { useAuth } from './index'

export function Protected<const TAuth = unknown>(
  page: (session: Accessor<GauSession<ProviderIds<TAuth>>>) => JSXElement,
  fallbackOrRedirect?: (() => JSXElement) | string,
): VoidComponent {
  return () => {
    const auth = useAuth<TAuth>()
    const navigate = useNavigate()

    const isRedirectMode = typeof fallbackOrRedirect === 'string' || fallbackOrRedirect === undefined
    const redirectTo = isRedirectMode ? (fallbackOrRedirect ?? '/') : undefined
    const Fallback = !isRedirectMode ? (fallbackOrRedirect as (() => JSXElement)) : undefined

    const Redirect: VoidComponent = () => {
      onMount(() => {
        if (!isServer && redirectTo)
          navigate(redirectTo, { replace: true })
      })
      return null
    }

    return (
      <Show
        when={auth.session().user}
        fallback={isRedirectMode ? <Redirect /> : (Fallback ? <Fallback /> : null)}
      >
        {page(auth.session)}
      </Show>
    )
  }
}
