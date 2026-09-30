<script lang='ts'>
  import { clientEnv } from '$lib/env/client'
  import AuthProvider from '@rttnd/gau/client/svelte/AuthProvider.svelte'
  import { page } from '$app/state'
  import Shell from '../../../example-shared/Shell.svelte'
  import '@unocss/reset/tailwind.css'
  import 'virtual:uno.css'

  const { children } = $props()
</script>

<AuthProvider baseUrl={clientEnv.PUBLIC_API_URL}>
  <Shell framework="tauri" label="sveltekit + tauri" path={page.url.pathname}>{@render children()}</Shell>
</AuthProvider>
