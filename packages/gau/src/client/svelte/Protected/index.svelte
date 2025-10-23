<script lang='ts'>
  import type { Snippet } from 'svelte'
  // @ts-expect-error svelte-kit
  import { goto } from '$app/navigation'
  import { BROWSER } from 'esm-env'
  import { useAuth } from '../index.svelte'

  type Props = {
    redirectTo?: string
    fallback?: Snippet
    children: Snippet
  }

  const { redirectTo = '/', fallback, children }: Props = $props()

  const auth = useAuth()

  $effect(() => {
    if (BROWSER && !auth.isLoading && !auth.session?.user)
      goto(redirectTo)
  })
</script>

{#if auth.isLoading}
  {#if fallback}
    {@render fallback()}
  {/if}
{:else if auth.session?.user}
  {@render children()}
{:else if fallback}
  {@render fallback()}
{/if}
