<script lang='ts'>
  import { page } from '$app/state'
  import Shell from '../../../example-shared/Shell.svelte'
  import '@unocss/reset/tailwind.css'
  import 'virtual:uno.css'

  const { children } = $props()
</script>

<Shell framework="tauri" label="sveltekit + tauri" path={page.url.pathname}>{@render children()}</Shell>
