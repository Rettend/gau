import type { ErrorCode } from '@rttnd/gau'
import { useSearchParams } from '@solidjs/router'
import { Show } from 'solid-js'

export default function AuthErrorPage() {
  const [params] = useSearchParams<{ code?: string, message?: string, redirect?: string }>()

  const code = () => params.code as ErrorCode | undefined
  const message = () => params.message
  const redirect = () => params.redirect || '/'

  return (
    <main class="text-emerald-100 font-mono p-6 bg-zinc-900 min-h-screen relative">
      <div class="bg-[linear-gradient(transparent_1px,#18181b_1px),linear-gradient(90deg,transparent_1px,#18181b_1px)] bg-[size:32px_32px] opacity-20 pointer-events-none inset-0 absolute" />
      <div class="mx-auto max-w-md relative">
        <div class="p-6 border border-red-900/30 rounded bg-zinc-800/50 backdrop-blur space-y-4">
          <h1 class="text-xl text-red-400 tracking-tight">Authentication Error</h1>
          <p class="text-zinc-300">{message() ?? 'An error occurred during authentication.'}</p>
          <Show when={code()}>
            <p class="text-sm text-zinc-500 font-mono">{code()}</p>
          </Show>
          <a
            href={redirect()}
            class="px-4 py-2 border border-emerald-900/30 rounded bg-zinc-800 inline-block transition-all duration-200 hover:border-emerald-800/50 hover:bg-zinc-700"
          >
            Go back
          </a>
        </div>
      </div>
    </main>
  )
}
