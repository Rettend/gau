<script lang='ts'>
  import type { Provider } from '$lib/auth'
  import { useAuth } from '$lib/auth'

  const auth = useAuth()

  $inspect(auth.session)
  
  type ProvidersMeta = Record<Provider, { label: string, icon: string }>
  const providers: ProvidersMeta = {
    github: { label: 'GitHub', icon: 'i-ph:github-logo' },
    google: { label: 'Google', icon: 'i-ph:google-logo-bold' },
    microsoft: { label: 'Microsoft', icon: 'i-mdi:microsoft' },
    facebook: { label: 'Facebook', icon: 'i-ph:facebook-logo-bold' },
    discord: { label: 'Discord', icon: 'i-ph:discord-logo-bold' },
  }

  const { linkedProviders, unlinkedProviders } = $derived.by(() => {
    if (auth.session?.user) {
      const linkedProviders = (auth.session.accounts?.map(a => a.provider) ?? []) as Provider[]
      const all = auth.session.providers ?? []
      const unlinkedProviders = all.filter(p => !linkedProviders.includes(p))

      return {
        linkedProviders,
        unlinkedProviders,
      }
    }
    return {
      linkedProviders: [] as Provider[],
      unlinkedProviders: auth.session?.providers ?? [],
    }
  })
</script>

<main class='text-emerald-100 font-mono p-6 bg-zinc-900 min-h-screen relative'>
  <div
    class='bg-[linear-gradient(transparent_1px,#18181b_1px),linear-gradient(90deg,transparent_1px,#18181b_1px)] bg-[size:32px_32px] opacity-20 pointer-events-none inset-0 absolute'
  ></div>
  <div class='mx-auto max-w-3xl relative space-y-6'>
    {#if auth.session?.user}
      <div
        class='p-4 border border-emerald-900/30 rounded bg-zinc-800/50 flex items-center justify-between backdrop-blur'
      >
        <h2 class='text-xl tracking-tight'>> {auth.session.user.name}</h2>
        <button
          class='text-sm tracking-wider px-4 py-2 border border-red-900/30 rounded bg-red-900/20 transition-all duration-200 hover:border-red-800/50 hover:bg-red-900/40'
          onclick={() => auth.signOut()}
        >
          /logout
        </button>
      </div>
      <div class='space-y-4'>
        <div>
          <h3 class='text-lg tracking-wider mb-2'>Linked Accounts</h3>
          <div class='flex gap-4'>
            {#each linkedProviders as provider}
              <div class='px-4 py-2 border border-emerald-900/30 rounded bg-zinc-800 flex gap-2 items-center justify-center'>
                <div class={`${providers[provider]?.icon} size-5`}></div>
                <p>{providers[provider]?.label ?? provider}</p>
                <button
                  class='i-ph:x-bold transition-colors hover:text-red-500'
                  aria-label='Unlink account'
                  onclick={() => auth.unlinkAccount(provider)}
                >
                </button>
              </div>
            {/each}
          </div>
        </div>
        {#if unlinkedProviders.length > 0}
          <div>
            <h3 class='text-lg tracking-wider mb-2'>Link More Accounts</h3>
            <div class='flex gap-4'>
              {#each unlinkedProviders as provider}
                <button
                  class='px-4 py-2 border border-emerald-900/30 rounded bg-zinc-800 flex gap-2 transition-all duration-200 items-center justify-center hover:border-emerald-800/50 hover:bg-zinc-700'
                  onclick={() => auth.linkAccount(provider)}
                >
                  <div class={`${providers[provider]?.icon} size-5`}></div>
                  <p>{providers[provider]?.label ?? provider}</p>
                </button>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    {:else}
      <div class='flex flex-col gap-4 items-center'>
        <span class='text-lg tracking-wider'>Sign In</span>
        <div class='flex gap-4 justify-center'>
          {#each unlinkedProviders as provider}
            <button
              class='px-4 py-2 border border-emerald-900/30 rounded bg-zinc-800 flex gap-2 transition-all duration-200 items-center justify-center hover:border-emerald-800/50 hover:bg-zinc-700'
              onclick={() => auth.signIn(provider)}
            >
              <div class={`${providers[provider]?.icon} size-5`}></div>
              <p>{providers[provider]?.label ?? provider}</p>
            </button>
          {/each}
        </div>
      </div>
    {/if}
  </div>
</main>
