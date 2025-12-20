import type { Provider } from '~/lib/auth'
import { createEffect, createMemo, For, Show } from 'solid-js'
import { useAuth } from '~/lib/auth'

export default function Home() {
  const auth = useAuth()

  createEffect(() => {
    // eslint-disable-next-line no-console
    console.log(auth.session())
  })

  const providerMeta: Partial<Record<Provider, { label: string, icon: string }>> = {
    github: { label: 'GitHub', icon: 'i-ph:github-logo' },
    google: { label: 'Google', icon: 'i-ph:google-logo-bold' },
    microsoft: { label: 'Microsoft', icon: 'i-mdi:microsoft' },
  }

  const availableProviders = createMemo<Provider[]>(() => {
    const fromSession = (auth.session().providers ?? []) as Provider[]
    return fromSession.filter(provider => providerMeta[provider])
  })

  const linkedProviders = createMemo<Provider[]>(() => {
    if (!auth.session().user)
      return []
    const providers = (auth.session().accounts?.map(a => a.provider) ?? []) as Provider[]
    return providers.filter(provider => providerMeta[provider])
  })

  const unlinkedProviders = createMemo<Provider[]>(() => {
    const linked = new Set(linkedProviders())
    return availableProviders().filter(provider => !linked.has(provider))
  })

  return (
    <main class="text-emerald-100 font-mono p-6 bg-zinc-900 min-h-screen relative">
      <div class="bg-[linear-gradient(transparent_1px,#18181b_1px),linear-gradient(90deg,transparent_1px,#18181b_1px)] bg-[size:32px_32px] opacity-20 pointer-events-none inset-0 absolute" />
      <div class="mx-auto max-w-3xl relative space-y-6">
        <Show
          when={auth.session().user}
          fallback={(
            <div class="flex flex-col gap-4 items-center">
              <span class="text-lg tracking-wider">Sign In</span>
              <div class="flex gap-4 justify-center">
                <For each={unlinkedProviders()}>
                  {provider => (
                    <button
                      class="px-4 py-2 border border-emerald-900/30 rounded bg-zinc-800 flex gap-2 transition-all duration-200 items-center justify-center hover:border-emerald-800/50 hover:bg-zinc-700"
                      onClick={() => auth.signIn(provider)}
                    >
                      <div class={`${providerMeta[provider]?.icon ?? ''} size-5`} />
                      <p>{providerMeta[provider]?.label ?? provider}</p>
                    </button>
                  )}
                </For>
              </div>
            </div>
          )}
        >
          <div class="p-4 border border-emerald-900/30 rounded bg-zinc-800/50 flex items-center justify-between backdrop-blur">
            <h2 class="text-xl tracking-tight">
              &gt;
              {auth.session().user?.name}
            </h2>
            <button
              class="text-sm tracking-wider px-4 py-2 border border-red-900/30 rounded bg-red-900/20 transition-all duration-200 hover:border-red-800/50 hover:bg-red-900/40"
              onClick={() => auth.signOut()}
            >
              /logout
            </button>
          </div>
          <div class="space-y-4">
            <div>
              <h3 class="text-lg tracking-wider mb-2">Linked Accounts</h3>
              <div class="flex gap-4">
                <For each={linkedProviders()}>
                  {provider => (
                    <div class="px-4 py-2 border border-emerald-900/30 rounded bg-zinc-800 flex gap-2 items-center justify-center">
                      <div class={`${providerMeta[provider]?.icon ?? ''} size-5`} />
                      <p>{providerMeta[provider]?.label ?? provider}</p>
                      <button
                        class="i-ph:x-bold transition-colors hover:text-red-500"
                        aria-label="Unlink account"
                        onClick={() => auth.unlinkAccount(provider)}
                      />
                    </div>
                  )}
                </For>
              </div>
            </div>
            <Show when={unlinkedProviders().length > 0}>
              <div>
                <h3 class="text-lg tracking-wider mb-2">Link More Accounts</h3>
                <div class="flex gap-4">
                  <For each={unlinkedProviders()}>
                    {provider => (
                      <button
                        class="px-4 py-2 border border-emerald-900/30 rounded bg-zinc-800 flex gap-2 transition-all duration-200 items-center justify-center hover:border-emerald-800/50 hover:bg-zinc-700"
                        onClick={() => auth.linkAccount(provider)}
                      >
                        <div class={`${providerMeta[provider]?.icon ?? ''} size-5`} />
                        <p>{providerMeta[provider]?.label ?? provider}</p>
                      </button>
                    )}
                  </For>
                </div>
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </main>
  )
}
