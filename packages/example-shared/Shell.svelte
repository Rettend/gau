<script lang="ts">
  import type { Snippet } from 'svelte'
  import './styles.css'

  let { framework, label = framework, path, children }: {
    framework: string
    label?: string
    path: string
    children: Snippet
  } = $props()
</script>

<svelte:head><title>Gau · {label}</title></svelte:head>

<div class="example-shell" data-framework={framework}>
  <div class="example-content">
    <header class="example-header">
      <a href="/" class="example-brand">gau <span>/ {label}</span></a>
      <nav aria-label="Main" class="example-nav">
        <a href="/" aria-current={path === '/' ? 'page' : undefined}>Home</a>
        <a href="/account" aria-current={path === '/account' ? 'page' : undefined}>Account</a>
        <a href="/protected" aria-current={path === '/protected' ? 'page' : undefined}>Protected page</a>
      </nav>
    </header>
    <main>{@render children()}</main>
  </div>
</div>
