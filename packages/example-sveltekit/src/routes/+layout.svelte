<script lang='ts'>
  import { PUBLIC_API_URL } from '$env/static/public'
  import AuthProvider from '@rttnd/gau/client/svelte/AuthProvider.svelte'
  import '@unocss/reset/tailwind.css'
  import 'virtual:uno.css'

  const { children } = $props()
</script>

<AuthProvider baseUrl={PUBLIC_API_URL}>
  {@render children()}
</AuthProvider>
