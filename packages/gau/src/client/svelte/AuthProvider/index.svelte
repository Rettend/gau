<script lang='ts'>
  import type { Snippet } from 'svelte'
  import type { GauSession, ProviderIds } from '../../../core'
  import { createSvelteAuth } from '../index.svelte'

  type Props<TAuth = unknown> = {
    baseUrl?: string
    scheme?: string
    redirectTo?: string
    session?: GauSession<ProviderIds<TAuth>>
    children: Snippet
  }

  const { baseUrl, scheme, redirectTo, session, children }: Props = $props()
  createSvelteAuth({ baseUrl, scheme, redirectTo, session })
</script>

{@render children()}
