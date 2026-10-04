<script lang="ts">
  import type { Snippet } from 'svelte'
  import * as rawEnv from '$env/static/public'
  import { clientScheme, parseEnv } from '$lib/env/schema'
  import AuthProvider from '@rttnd/gau/client/svelte/AuthProvider.svelte'

  const { children }: { children: Snippet } = $props()
  // Validate the hosted backend only when this demo is opened.
  const clientEnv = parseEnv(clientScheme, rawEnv, 'client')
</script>

<AuthProvider baseUrl={clientEnv.PUBLIC_API_URL}>
  {@render children()}
</AuthProvider>
