<script lang="ts">
  import type { GauSession } from '@rttnd/gau'
  import AuthProvider from '@rttnd/gau/client/svelte/AuthProvider.svelte'
  import { getBrowserClient } from '../client/auth'
  import SessionStatus from './SessionStatus.svelte'

  let { session, controls = false }: { session: GauSession, controls?: boolean } = $props()
  // svelte-ignore state_referenced_locally -- the browser client is shared for its lifetime
  const client = getBrowserClient(session)
</script>

<AuthProvider {session} {client}>
  <SessionStatus {controls} />
</AuthProvider>
