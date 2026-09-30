import { createSignal, Show } from 'solid-js'
import { useAuth } from '~/lib/auth'

export default function SessionDetails() {
  const auth = useAuth()
  const [pending, setPending] = createSignal(false)
  const [error, setError] = createSignal('')
  async function refresh() {
    setPending(true)
    setError('')
    try {
      await auth.refresh()
    } catch {
      setError('Could not refresh the session. Try again.')
    } finally {
      setPending(false)
    }
  }
  return (
    <div class="example-session example-stack">
      <div class="example-row">
        <button type="button" class="example-button" disabled={pending() || auth.isLoading()} onClick={refresh}>
          {pending() ? 'Updating…' : 'Refresh session'}
        </button>
        <a href="/protected" class="example-muted">
          View protected page →
        </a>
      </div>
      <Show when={error()}>
        <p role="alert" class="example-error">
          {error()}
        </p>
      </Show>
      <details class="example-panel">
        <summary class="example-muted">Session data</summary>
        <pre>{JSON.stringify(auth.session(), null, 2)}</pre>
      </details>
    </div>
  )
}
