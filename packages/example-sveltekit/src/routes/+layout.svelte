<script lang='ts'>
  import { PUBLIC_API_URL } from '$env/static/public'
  import AuthProvider from '@rttnd/gau/client/svelte/AuthProvider.svelte'
  import { page } from '$app/state'
  import Shell from '../../../example-shared/Shell.svelte'
  import '@unocss/reset/tailwind.css'
  import 'virtual:uno.css'

  const { children } = $props()
</script>

<AuthProvider baseUrl={PUBLIC_API_URL}>
  <Shell framework="sveltekit" path={page.url.pathname}>{@render children()}</Shell>
</AuthProvider>
