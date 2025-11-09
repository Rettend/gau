<script lang='ts'>
  import { clientEnv } from '$lib/env/client'
  import AuthProvider from '@rttnd/gau/client/svelte/AuthProvider.svelte'

  const { children } = $props()
</script>

<AuthProvider baseUrl={clientEnv.PUBLIC_API_URL} scheme='gau'>
  {@render children()}
</AuthProvider>
