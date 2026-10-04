<script lang="ts">
  import AppAuth from '$lib/AppAuth.svelte'
  import AuthPanel from '$lib/AuthPanel.svelte'

  let showAppAuth = $state(false)
</script>

<h1 class="example-title">Authentication</h1>
<p class="mb-6"><a class="example-button" href="/chatgpt">Connect ChatGPT</a></p>
{#if showAppAuth}
  <AppAuth><AuthPanel /></AppAuth>
{:else}
  <div class="example-stack">
    <p class="example-muted">App authentication requires the hosted auth backend. ChatGPT does not.</p>
    <div><button class="example-button" onclick={() => showAppAuth = true}>Try app authentication</button></div>
  </div>
{/if}
