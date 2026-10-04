<script lang="ts">
  import AppAuth from '$lib/AppAuth.svelte'
  import AuthPanel from '$lib/AuthPanel.svelte'
  import Protected from '@rttnd/gau/client/svelte/Protected.svelte'
</script>

<AppAuth>
  <Protected redirectTo="/">
    <h1 class="example-title">Your account</h1>
    <AuthPanel />
  </Protected>
</AppAuth>
