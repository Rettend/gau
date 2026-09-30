<script lang="ts">
  import { useAuth } from '@rttnd/gau/client/svelte'
  const auth = useAuth()
  let pending = $state(false)
  let error = $state('')

  async function refresh() {
    pending = true
    error = ''
    try { await auth.refresh() }
    catch { error = 'Could not refresh the session. Try again.' }
    finally { pending = false }
  }
</script>

<div class="example-session example-stack">
  <div class="example-row">
    <button class="example-button" disabled={pending || auth.isLoading} onclick={refresh}>{pending ? 'Updating…' : 'Refresh session'}</button>
    <a href="/protected" class="example-muted">View protected page →</a>
  </div>
  {#if error}<p role="alert" class="example-error">{error}</p>{/if}
  <details class="example-panel">
    <summary class="example-muted">Session data</summary>
    <pre>{JSON.stringify(auth.session, null, 2)}</pre>
  </details>
</div>
