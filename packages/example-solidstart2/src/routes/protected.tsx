import { Protected } from '@rttnd/gau/client/solid2'
import { useAuth } from '~/lib/auth'

export default Protected(Page, '/')

function Page() {
  const auth = useAuth()

  return (
    <main class="text-emerald-100 font-mono p-6 bg-zinc-900 min-h-screen w-full">
      <div class="mx-auto max-w-3xl">
        <h1 class="text-2xl mb-4">Protected Page</h1>
        <p class="mb-4">Only visible to authenticated users.</p>
        <button
          class="text-sm tracking-wider mb-4 px-4 py-2 border border-red-900/30 rounded bg-red-900/20 transition-all duration-200 hover:border-red-800/50 hover:bg-red-900/40"
          type="button"
          onClick={() => auth.signOut()}
        >
          /logout
        </button>
        <pre class="text-sm p-4 rounded bg-zinc-800 overflow-x-auto">{JSON.stringify(auth.session(), null, 2)}</pre>
      </div>
    </main>
  )
}
