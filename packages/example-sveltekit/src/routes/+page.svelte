<script lang='ts'>
  import type { Provider } from '$lib/auth'
  import { endImpersonation, getUsers, startImpersonation, toggleRole } from '$lib/admin.remote'
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

  let impersonating = $state(false)

  const users = $derived(auth.session?.user?.isAdmin ? getUsers() : null)

  const isImpersonating = $derived(auth.session?.session?.impersonatedBy != null)
  const impersonatedBy = $derived(auth.session?.session?.impersonatedBy as string | undefined)

  async function handleToggleRole() {
    await toggleRole()
    await auth.refresh()
  }

  async function impersonateUser(targetUserId: string) {
    impersonating = true
    try {
      await startImpersonation({ targetUserId, reason: 'Testing from example app' })
      await auth.refresh()
    }
    catch (err) {
      console.error('Impersonation failed:', err)
    }
    impersonating = false
  }

  async function stopImpersonating() {
    try {
      await endImpersonation()
      await auth.refresh()
    }
    catch (err) {
      console.error('End impersonation failed:', err)
    }
  }
</script>

<main class='text-emerald-100 font-mono p-6 bg-zinc-900 min-h-screen relative'>
  <div
    class='bg-[linear-gradient(transparent_1px,#18181b_1px),linear-gradient(90deg,transparent_1px,#18181b_1px)] bg-[size:32px_32px] opacity-20 pointer-events-none inset-0 absolute'
  ></div>

  <!-- Impersonation Banner -->
  {#if isImpersonating}
    <div class='text-black px-4 py-2 bg-amber-600 flex items-center left-0 right-0 top-0 justify-between fixed z-50'>
      <span class='font-semibold'>
        ⚠️ Impersonating user (admin: {impersonatedBy})
      </span>
      <button
        class='text-amber-400 px-3 py-1 rounded bg-black transition-colors hover:bg-zinc-800'
        onclick={stopImpersonating}
      >
        Stop Impersonating
      </button>
    </div>
  {/if}

  <div class='mx-auto max-w-3xl relative space-y-6' class:pt-12={isImpersonating}>
    {#if auth.session?.user}
      <div
        class='p-4 border border-emerald-900/30 rounded bg-zinc-800/50 flex items-center justify-between backdrop-blur'
      >
        <div>
          <h2 class='text-xl tracking-tight'>> {auth.session.user.name}</h2>
          <p class='text-sm text-zinc-400'>
            Role: <span class:text-amber-400={auth.session.user.role === 'admin'}>{auth.session.user.role ?? 'user'}</span>
            {#if auth.session.user.isAdmin}
              <span class='text-amber-400 ml-2'>(isAdmin ✓)</span>
            {/if}
          </p>
        </div>
        <button
          class='text-sm tracking-wider px-4 py-2 border border-red-900/30 rounded bg-red-900/20 transition-all duration-200 hover:border-red-800/50 hover:bg-red-900/40'
          onclick={() => auth.signOut()}
        >
          /logout
        </button>
      </div>

      <!-- Admin Controls -->
      {#if !isImpersonating}
        <div class='p-4 border border-zinc-700 rounded bg-zinc-800/30 space-y-4'>
          <h3 class='text-lg text-zinc-300 tracking-wider'>Impersonation Testing</h3>

          <div class='flex gap-4 items-center'>
            <button
              class='text-amber-200 px-4 py-2 border border-amber-900/30 rounded bg-amber-900/20 transition-all duration-200 hover:border-amber-800/50 hover:bg-amber-900/40'
              onclick={handleToggleRole}
            >
              Toggle Role ({auth.session.user.role === 'admin' ? 'admin → user' : 'user → admin'})
            </button>
          </div>

          {#if auth.session.user.isAdmin && users}
            <div class='space-y-2'>
              <p class='text-sm text-zinc-400'>Select a user to impersonate:</p>
              {#await users}
                <p class='text-sm text-zinc-500'>Loading users...</p>
              {:then userList}
                {#if userList.length > 0}
                  <div class='mt-2 space-y-2'>
                    {#each userList as user}
                      <div class='p-2 rounded bg-zinc-700/50 flex items-center justify-between'>
                        <div>
                          <span class='text-emerald-200'>{user.name ?? 'No name'}</span>
                          <span class='text-sm text-zinc-400 ml-2'>({user.email})</span>
                          <span class='text-xs ml-2' class:text-amber-400={user.role === 'admin'}>[{user.role ?? 'user'}]</span>
                        </div>
                        <button
                          class='text-sm text-purple-200 px-3 py-1 border border-purple-900/30 rounded bg-purple-900/20 transition-all duration-200 hover:border-purple-800/50 hover:bg-purple-900/40 disabled:opacity-50'
                          onclick={() => impersonateUser(user.id)}
                          disabled={impersonating || user.role === 'admin'}
                          title={user.role === 'admin' ? 'Cannot impersonate admins' : 'Impersonate this user'}
                        >
                          {user.role === 'admin' ? 'Protected' : 'Impersonate'}
                        </button>
                      </div>
                    {/each}
                  </div>
                {:else}
                  <p class='text-sm text-zinc-500'>No other users found. Sign in with another provider or in incognito to create another user.</p>
                {/if}
              {:catch err}
                <p class='text-sm text-red-400'>Error loading users: {err.message}</p>
              {/await}
            </div>
          {:else if !auth.session.user.isAdmin}
            <p class='text-sm text-zinc-500'>Toggle your role to admin to access impersonation controls.</p>
          {/if}
        </div>
      {/if}

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
