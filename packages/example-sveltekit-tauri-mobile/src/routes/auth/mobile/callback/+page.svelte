<script lang='ts'>
  import { browser } from '$app/environment'
  import { onMount } from 'svelte'

  onMount(() => {
    if (!browser)
      return

    // Extract token from hash
    const hash = window.location.hash.substring(1)
    const params = new URLSearchParams(hash)
    const token = params.get('token')

    if (token) {
      // Token will be handled by deep link in the Tauri app
      // This page is just for when viewed in browser
      // eslint-disable-next-line no-console
      console.log('Token received, redirect handled by app')
    }
  })
</script>

<div class='text-emerald-100 bg-zinc-900 flex min-h-screen items-center justify-center'>
  <div class='p-8 text-center border border-emerald-900/30 rounded bg-zinc-800/50 backdrop-blur'>
    <h1 class='text-2xl tracking-tight font-mono mb-4'>Authentication Complete</h1>
    <p class='text-zinc-400 font-mono'>You can close this page and return to the app.</p>
  </div>
</div>
