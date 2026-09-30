<script lang="ts">
  let { message, code }: { message: string | null, code: string | null } = $props()
</script>

<div class="example-panel example-stack">
  <h1 class="example-title example-error">Authentication error</h1>
  <p>{message ?? 'Could not complete authentication. Try again.'}</p>
  {#if code}<p class="example-muted">{code}</p>{/if}
  <div><a class="example-button" href="/">Go back</a></div>
</div>
