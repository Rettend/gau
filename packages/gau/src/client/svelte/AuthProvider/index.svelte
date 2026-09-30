<script lang='ts'>
  import type { Snippet } from 'svelte'
  import type { GauSession, ProviderIds } from '../../../core'
  import { createSvelteAuth } from '../index.svelte'
  import type { AuthClient } from '../../vanilla'

  type Props<TAuth = unknown> = {
    baseUrl?: string
    scheme?: string
    redirectTo?: string
    session?: GauSession<ProviderIds<TAuth>>
    client?: AuthClient<TAuth>
    replaceUrl?: (url: string) => void | Promise<void>
    children: Snippet
  }

  const { baseUrl, scheme, redirectTo, session, client, replaceUrl, children }: Props = $props()
  // svelte-ignore state_referenced_locally -- init only
  const auth = createSvelteAuth({ baseUrl, scheme, redirectTo, session, client, replaceUrl })
  $effect(() => {
    if (session !== undefined)
      auth.setSession(session)
  })
</script>

{@render children()}
