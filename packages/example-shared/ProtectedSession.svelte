<script lang="ts">
  import { useAuth } from '@rttnd/gau/client/svelte'
  import Protected from '@rttnd/gau/client/svelte/Protected.svelte'
  const auth = useAuth()
</script>

<Protected redirectTo="/">
  <h1 class="example-title">Protected page</h1>
  <div class="example-stack">
    <p class="example-muted">Only visible while signed in.</p>
    <div><button class="example-button example-danger" onclick={() => auth.signOut()} aria-label="Sign out">/logout</button></div>
    <pre class="example-panel">{JSON.stringify(auth.session, null, 2)}</pre>
  </div>
</Protected>
