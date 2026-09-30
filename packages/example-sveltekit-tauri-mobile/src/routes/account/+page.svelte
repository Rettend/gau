<script lang="ts">
  import AuthPanel from '$lib/AuthPanel.svelte'
  import Protected from '@rttnd/gau/client/svelte/Protected.svelte'
</script>

<Protected redirectTo="/">
  <h1 class="example-title">Your account</h1>
  <AuthPanel />
</Protected>
