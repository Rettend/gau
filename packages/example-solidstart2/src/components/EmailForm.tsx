import { createSignal, onSettled, Show } from 'solid-js'
import { useAuth } from '~/lib/auth'

export default function EmailForm(props: { link?: boolean }) {
  const auth = useAuth()
  const [email, setEmail] = createSignal('')
  const [code, setCode] = createSignal('')
  const [challengeId, setChallengeId] = createSignal('')
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal('')
  const [notice, setNotice] = createSignal('')
  const [retryAt, setRetryAt] = createSignal(0)
  const [now, setNow] = createSignal(0)

  onSettled(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  })

  async function send() {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const options = { email: email() }
      const result = props.link ? await auth.linkAccount('email', options) : await auth.signIn('email', options)
      setChallengeId(result.challengeId)
      setCode('')
      setNow(Date.now())
      setRetryAt(Date.now() + result.retryAfter * 1000)
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not send the email.')
    } finally {
      setBusy(false)
    }
  }

  async function verify() {
    setBusy(true)
    setError('')
    try {
      const options = { challengeId: challengeId(), code: code() }
      if (props.link) await auth.linkAccount('email', options)
      else await auth.signIn('email', options)
      setChallengeId('')
      setNotice('Email linked.')
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not verify the code.')
    } finally {
      setBusy(false)
    }
  }

  const inputClass = 'w-full px-3 py-2 border border-emerald-900/30 rounded bg-zinc-800 focus:outline-emerald-500'
  const buttonClass =
    'px-4 py-2 border border-emerald-900/30 rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed'

  return (
    <form
      class="w-full max-w-sm space-y-3"
      onSubmit={(event) => {
        event.preventDefault()
        void (challengeId() ? verify() : send())
      }}
    >
      <Show
        when={challengeId()}
        fallback={
          <label class="flex flex-col gap-2">
            Email
            <input
              class={inputClass}
              type="email"
              autocomplete="email"
              required
              value={email()}
              disabled={busy()}
              onInput={(event) => setEmail(event.currentTarget.value)}
            />
          </label>
        }
      >
        <p class="text-sm text-zinc-400">Enter the code sent to {email()}, or open the link in this browser.</p>
        <label class="flex flex-col gap-2">
          Verification code
          <input
            class={inputClass}
            type="text"
            inputmode="numeric"
            autocomplete="one-time-code"
            pattern="[0-9]{6}"
            maxlength={6}
            required
            value={code()}
            disabled={busy()}
            onInput={(event) => setCode(event.currentTarget.value)}
          />
        </label>
      </Show>
      <Show when={error()}>
        <p role="alert" class="text-sm text-red-400">
          {error()}
        </p>
      </Show>
      <Show when={notice()}>
        <p role="status" class="text-sm">
          {notice()}
        </p>
      </Show>
      <button class={`${buttonClass} w-full`} type="submit" disabled={busy()}>
        {busy() ? 'Please wait…' : challengeId() ? 'Verify code' : props.link ? 'Link email' : 'Continue with email'}
      </button>
      <Show when={challengeId()}>
        <div class="text-sm flex gap-3 justify-between">
          <button class={buttonClass} type="button" disabled={busy() || now() < retryAt()} onClick={() => void send()}>
            {now() < retryAt() ? `Resend in ${Math.ceil((retryAt() - now()) / 1000)}s` : 'Resend email'}
          </button>
          <button
            class={buttonClass}
            type="button"
            disabled={busy()}
            onClick={() => {
              setChallengeId('')
              setError('')
            }}
          >
            Change email
          </button>
        </div>
      </Show>
    </form>
  )
}
