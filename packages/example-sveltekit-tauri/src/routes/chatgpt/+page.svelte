<script lang="ts">
  import { createChatGPT, isTauri } from '@rttnd/gau/runtimes/tauri'
  import { onDestroy, onMount } from 'svelte'

  type Client = ReturnType<typeof createChatGPT>
  type Account = Awaited<ReturnType<Client['listAccounts']>>[number]
  type Model = { slug: string; display_name: string; visibility: string }

  let client: Client | undefined
  let pending: AbortController | undefined
  let destroyed = false
  let native = $state(false)
  let accounts = $state<Account[]>([])
  let accountId = $state('')
  let busy = $state('')
  let error = $state('')
  let models = $state<Model[]>([])
  let model = $state('')
  let prompt = $state('Say hello in one sentence.')
  let output = $state('')
  let catalogLoaded = $state(false)
  const account = $derived(accounts.find(item => item.id === accountId))
  const ready = $derived(native && account?.status === 'ready')
  const statusLabels = {
    ready: 'Plan enabled',
    'identity-only': 'Plan not enabled',
    'signed-out': 'Disconnected',
    'reauth-required': 'Reconnect required',
  }

  function resetResults() {
    models = []
    model = ''
    output = ''
    catalogLoaded = false
    error = ''
  }

  async function refreshAccounts(selectedId = accountId) {
    if (!client) return
    const listed = await client.listAccounts()
    if (destroyed) return
    accounts = listed
    accountId = listed.some(item => item.id === selectedId) ? selectedId : listed[0]?.id ?? ''
  }

  async function run(label: string, failure: string, action: (signal: AbortSignal) => Promise<void>) {
    if (!client || busy || destroyed) return
    const controller = new AbortController()
    pending = controller
    busy = label
    error = ''
    try {
      await action(controller.signal)
    } catch {
      if (!destroyed && !controller.signal.aborted) error = failure
    } finally {
      if (!destroyed) busy = ''
      if (pending === controller) pending = undefined
    }
  }

  function connect(existing = false, consent = false) {
    resetResults()
    return run('Connecting…', 'Could not connect. Try again in the desktop app.', async (signal) => {
      const connected = await client!.signIn({
        ...(existing && account ? { accountId: account.id } : {}),
        ...(consent ? { prompt: 'consent' as const } : {}),
        signal,
      })
      await refreshAccounts(connected.id)
    })
  }

  function disconnect() {
    if (!account) return
    const id = account.id
    resetResults()
    return run('Disconnecting…', 'Could not disconnect. Try again.', async () => {
      await client!.signOut(id)
      await refreshAccounts(id)
    })
  }

  function loadModels() {
    if (!ready || !account) return
    const id = account.id
    resetResults()
    return run('Loading models…', 'Could not load models. Check the connection and plan access.', async (signal) => {
      const fetch = client!.createFetch(id)
      const response = await fetch('https://api.openai.com/v1/models', { signal })
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error('Model request failed')
      }
      const catalog: { models: Model[] } = await response.json()
      if (destroyed || signal.aborted) return
      models = catalog.models.filter(item => item.visibility === 'list')
      model = models[0]?.slug ?? ''
      catalogLoaded = true
    })
  }

  function sendPrompt() {
    if (!ready || !account || !model.trim() || !prompt.trim()) return
    const id = account.id
    output = ''
    return run('Generating…', 'Could not generate a response. Try another model or reconnect.', async (signal) => {
      const fetch = client!.createFetch(id)
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: model.trim(), input: [{ role: 'user', content: prompt }], store: false, stream: true }),
        signal,
      })
      if (!response.ok || !response.body) {
        await response.body?.cancel()
        throw new Error('Response request failed')
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let data: string[] = []
      let completed = false

      function dispatch() {
        const payload = data.join('\n')
        data = []
        if (!payload || payload === '[DONE]') return
        const event = JSON.parse(payload)
        if (event.type === 'error' || event.type === 'response.failed' || event.type === 'response.incomplete')
          throw new Error('Generation failed')
        if (event.type === 'response.completed') completed = true
        if (event.type === 'response.output_text.delta' && typeof event.delta === 'string' && !destroyed && !signal.aborted)
          output += event.delta
      }

      function consume(final = false) {
        // Keep incomplete lines (including a split CRLF) until the next chunk.
        while (true) {
          const boundary = buffer.search(/[\r\n]/)
          if (boundary === -1) break
          if (!final && buffer[boundary] === '\r' && boundary === buffer.length - 1) break
          const line = buffer.slice(0, boundary)
          const width = buffer[boundary] === '\r' && buffer[boundary + 1] === '\n' ? 2 : 1
          buffer = buffer.slice(boundary + width)
          if (!line) dispatch()
          else if (line === 'data' || line.startsWith('data:')) {
            let value = line === 'data' ? '' : line.slice(5)
            if (value.startsWith(' ')) value = value.slice(1)
            data.push(value)
          }
        }
      }

      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          buffer += decoder.decode(chunk.value, { stream: true })
          consume()
        }
        buffer += decoder.decode()
        consume(true)
        if (!completed && !signal.aborted) throw new Error('Response stream interrupted')
      } finally {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
    })
  }

  onMount(() => {
    native = __TAURI_DESKTOP__ && isTauri()
    if (!native) return
    client = createChatGPT()
    void run('Loading accounts…', 'Could not load native accounts.', () => refreshAccounts())
  })

  onDestroy(() => {
    destroyed = true
    pending?.abort()
    if (client) void Promise.resolve(client.close()).catch(() => {})
  })
</script>

<svelte:head><title>ChatGPT · Gau</title></svelte:head>

<h1 class="example-title">ChatGPT</h1>
<div class="example-stack">
  <p class="example-muted">Connect your ChatGPT plan separately from your app login.</p>
  {#if !native}
    <p class="example-panel" role="status">Use the Tauri desktop app to connect ChatGPT.</p>
  {/if}

  <section class="example-panel example-stack" aria-label="ChatGPT accounts" aria-busy={!!busy}>
    <div class="example-row">
      <button class="example-button" disabled={!native || !!busy} onclick={() => connect()}>Connect</button>
      {#if busy}
        <span class="example-muted" role="status">{busy}</span>
        {#if busy === 'Connecting…' || busy === 'Loading models…' || busy === 'Generating…'}
          <button class="example-button" onclick={() => pending?.abort()}>Cancel</button>
        {/if}
      {/if}
    </div>
    <label class="example-stack gap-2">
      <span>Account</span>
      <select class="example-panel w-full" bind:value={accountId} onchange={resetResults} disabled={!native || !!busy || !accounts.length}>
        {#if !accounts.length}<option value="">No connected accounts</option>{/if}
        {#each accounts as item (item.id)}
          <option value={item.id}>{item.email ?? item.name ?? item.id}</option>
        {/each}
      </select>
    </label>
    {#if account}
      <div class="example-row">
        <span>{account.name ?? account.email ?? 'ChatGPT account'}</span>
        <span class="example-muted">{statusLabels[account.status]}</span>
      </div>
    {/if}
    <div class="example-row">
      <button class="example-button" disabled={!native || !account || !!busy} onclick={() => connect(true)}>Reconnect</button>
      <button class="example-button" disabled={!native || !account || !!busy || ready} onclick={() => connect(true, true)}>Enable plan</button>
      <button class="example-button example-danger" disabled={!native || !account || !!busy || account.status === 'signed-out'} onclick={disconnect}>Disconnect</button>
    </div>
  </section>

  <section class="example-panel example-stack" aria-labelledby="models-heading">
    <div class="example-row">
      <h2 id="models-heading">Models</h2>
      <button class="example-button" disabled={!ready || !!busy} onclick={loadModels}>Load models</button>
    </div>
    <label class="example-stack gap-2">
      <span>Model</span>
      <input class="example-panel w-full" list="chatgpt-models" bind:value={model} placeholder="Choose or enter a model ID" disabled={!ready || !!busy} spellcheck="false" autocapitalize="none" />
      <datalist id="chatgpt-models">
        {#each models as item (item.slug)}<option value={item.slug}>{item.display_name}</option>{/each}
      </datalist>
    </label>
    {#if catalogLoaded}<p class="example-muted">{models.length} model suggestions. You can also enter a model ID.</p>{/if}
    <form class="example-stack" onsubmit={(event) => { event.preventDefault(); void sendPrompt() }}>
      <label class="example-stack gap-2">
        <span>Prompt</span>
        <textarea class="example-panel w-full" rows="3" bind:value={prompt} disabled={!ready || !!busy}></textarea>
      </label>
      <div><button class="example-button" disabled={!ready || !!busy || !model.trim() || !prompt.trim()}>Send prompt</button></div>
    </form>
    {#if output}<pre class="whitespace-pre-wrap break-words" aria-label="Response">{output}</pre>{/if}
  </section>
  {#if error}<p class="example-error" role="alert">{error}</p>{/if}
</div>
