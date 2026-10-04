import { queryObjects } from 'node:v8'
import { Channel } from '@tauri-apps/api/core'
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { ChatGPTError, createChatGPT, type ChatGPTAccount } from '../../../src/runtimes/tauri/oauth'

const account: ChatGPTAccount = {
  id: 'personal',
  clientId: 'chatgpt-client',
  issuer: 'https://auth.openai.com',
  subject: 'user-1',
  email: 'person@example.com',
  emailVerified: true,
  name: 'Person',
  picture: null,
  scopes: ['openid', 'profile', 'email'],
  status: 'ready',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_001,
}
const prefix = 'plugin:gau|chatgpt_'
const models = 'https://api.openai.com/v1/models'
const responses = 'https://api.openai.com/v1/responses'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

type Event =
  | { type: 'response'; status: number; statusText: string; headers: [string, string][]; url: string }
  | { type: 'chunk'; sequence: number; data: number[] }
  | { type: 'end' }

interface FetchArgs {
  requestId: string
  accountId: string
  request: { url: string; method: string; headers: [string, string][]; body?: number[] }
  onEvent: Channel<Event>
}

function internals() {
  return (
    globalThis as unknown as {
      __TAURI_INTERNALS__: {
        runCallback: (id: number, value: unknown) => void
        unregisterCallback: (id: number) => void
        callbacks: Map<number, unknown>
      }
    }
  ).__TAURI_INTERNALS__
}

function mockNative() {
  const fetches: ReturnType<typeof session>[] = []
  let nextId = 0
  const invoke = vi.fn((command: string, args?: unknown): unknown => {
    switch (command) {
      case `${prefix}prepare`:
        return `request-${++nextId}`
      case `${prefix}sign_in`:
        return account
      case `${prefix}list_accounts`:
        return [account]
      case `${prefix}sign_out`:
        return { account: { ...account, status: 'signed-out' }, revocation: 'revoked' }
      case `${prefix}cancel`:
      case `${prefix}ack`:
        return undefined
      case `${prefix}fetch`: {
        const stream = session(args as FetchArgs)
        fetches.push(stream)
        return stream.done.promise
      }
      default:
        throw new Error(`Unexpected command: ${command}`)
    }
  })
  mockIPC((command, args) => invoke(command, args))

  function session(args: FetchArgs) {
    let index = 0
    const done = deferred<void>()
    return {
      args,
      done,
      emit(message: Event, messageIndex = index) {
        index = Math.max(index, messageIndex + 1)
        internals().runCallback(args.onEvent.id, { index: messageIndex, message })
      },
      lose() {
        // Reserve the native message's index without delivering it to the frontend.
        index++
      },
      headers(status = 200, headers: [string, string][] = [['content-type', 'text/event-stream']]) {
        this.emit({ type: 'response', status, statusText: status === 200 ? 'OK' : '', headers, url: args.request.url })
      },
      chunk(sequence: number, data: Uint8Array) {
        this.emit({ type: 'chunk', sequence, data: Array.from(data) })
      },
      end() {
        this.emit({ type: 'end' })
        this.drop()
        done.resolve()
      },
      drop() {
        internals().runCallback(args.onEvent.id, { index, end: true })
      },
    }
  }

  return {
    invoke,
    fetches,
    calls: (name: string) =>
      invoke.mock.calls.filter(([command]) => command === `${prefix}${name}`).map(([, args]) => args),
    async fetch(index = 0) {
      await vi.waitFor(() => expect(fetches.length).toBeGreaterThan(index))
      return fetches[index]
    },
  }
}

describe('native ChatGPT client', () => {
  beforeEach(() => {
    vi.stubGlobal('window', globalThis)
    // The real Tauri mock warns when intentionally late messages target disposed callbacks.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    clearMocks()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('is lazy and SSR-safe, with no process, generic action, or credential API', async () => {
    const native = mockNative()
    const client = createChatGPT()
    expect(Object.keys(client)).toEqual(['signIn', 'listAccounts', 'signOut', 'createFetch', 'close'])
    expect(typeof client.createFetch('personal')).toBe('function')
    expect(native.invoke).not.toHaveBeenCalled()
    await client.close()
    expect(native.invoke).not.toHaveBeenCalled()
    vi.stubGlobal('window', undefined)
    await expect(createChatGPT().listAccounts()).rejects.toEqual(new ChatGPTError())
    vi.stubGlobal('window', globalThis)
  })

  it('uses the native contract and exposes only safe account-picker metadata', async () => {
    const native = mockNative()
    const client = createChatGPT()
    const extra = { ...account, accessToken: 'secret', credentials: { refreshToken: 'secret' }, expiresAt: 123 }
    native.invoke.mockImplementation((command) => {
      if (command === `${prefix}prepare`) return 'prepared'
      if (command === `${prefix}sign_in`) return extra
      if (command === `${prefix}list_accounts`) return [extra]
      if (command === `${prefix}sign_out`) return { account: extra, revocation: 'failed', refreshToken: 'secret' }
      throw new Error('Unexpected command')
    })
    await expect(client.signIn({ accountId: 'personal', prompt: 'consent' })).resolves.toEqual(account)
    await expect(client.listAccounts()).resolves.toEqual([account])
    await expect(client.signOut('personal')).resolves.toEqual({ account, revocation: 'failed' })
    expect(native.invoke.mock.calls).toEqual([
      [`${prefix}prepare`, { kind: 'signIn' }],
      [`${prefix}sign_in`, { requestId: 'prepared', options: { accountId: 'personal', prompt: 'consent' } }],
      [`${prefix}list_accounts`, {}],
      [`${prefix}sign_out`, { accountId: 'personal' }],
    ])
    await client.close()
  })

  it('sanitizes native errors and rejects malformed account metadata', async () => {
    const native = mockNative()
    const client = createChatGPT()
    native.invoke.mockRejectedValueOnce({ code: 'reauth_required', message: 'refresh_token=secret' })
    const error = await client.listAccounts().catch((error: unknown) => error)
    expect(error).toEqual(new ChatGPTError('reauth_required'))
    expect((error as Error).message).not.toContain('secret')
    native.invoke.mockRejectedValueOnce({ code: 'secret value!', message: 'provider body' })
    await expect(client.listAccounts()).rejects.toEqual(new ChatGPTError())
    native.invoke.mockReturnValueOnce([{ ...account, emailVerified: 'true' }])
    await expect(client.listAccounts()).rejects.toEqual(new ChatGPTError('invalid_response'))
    await client.close()
  })

  it('aborts sign-in immediately and cancels a preparation that resolves later without starting sign-in', async () => {
    const native = mockNative()
    const prepare = deferred<string>()
    native.invoke.mockReturnValueOnce(prepare.promise)
    const client = createChatGPT()
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const result = client.signIn({ signal: controller.signal }).catch((error: Error) => error)
    await vi.waitFor(() => expect(native.calls('prepare')).toHaveLength(1))
    controller.abort('untrusted reason')
    expect((await result).name).toBe('AbortError')
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(native.calls('sign_in')).toHaveLength(0)
    prepare.resolve('late-id')
    await vi.waitFor(() => expect(native.calls('cancel')).toEqual([{ requestId: 'late-id' }]))
    expect(native.calls('sign_in')).toHaveLength(0)
    await client.close()
  })

  it('does not prepare already aborted sign-ins, and cancels active sign-in IDs on close', async () => {
    const native = mockNative()
    const client = createChatGPT()
    const controller = new AbortController()
    controller.abort()
    await expect(client.signIn({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(native.calls('prepare')).toHaveLength(0)
    const signIn = deferred<ChatGPTAccount>()
    native.invoke.mockImplementation((command) => {
      if (command === `${prefix}prepare`) return 'sign-in-id'
      if (command === `${prefix}sign_in`) return signIn.promise
    })
    const result = client.signIn().catch((error: unknown) => error)
    await vi.waitFor(() => expect(native.calls('sign_in')).toHaveLength(1))
    const closing = client.close()
    expect(client.close()).toBe(closing)
    await expect(result).resolves.toEqual(new ChatGPTError('client_closed'))
    await closing
    expect(native.calls('cancel')).toEqual([{ requestId: 'sign-in-id' }])
    signIn.resolve(account)
    await expect(client.listAccounts()).rejects.toEqual(new ChatGPTError('client_closed'))
  })

  it('waits for late prepared IDs during close without starting native sign-in', async () => {
    const native = mockNative()
    const prepare = deferred<string>()
    native.invoke.mockReturnValueOnce(prepare.promise)
    const client = createChatGPT()
    const result = client.signIn().catch((error: unknown) => error)
    await vi.waitFor(() => expect(native.calls('prepare')).toHaveLength(1))
    const closing = client.close()
    await expect(result).resolves.toEqual(new ChatGPTError('client_closed'))
    prepare.resolve('late-close-id')
    await closing
    expect(native.calls('cancel')).toEqual([{ requestId: 'late-close-id' }])
    expect(native.calls('sign_in')).toHaveLength(0)
  })

  it('handles abort racing native prepare completion, before the sign-in command starts', async () => {
    const native = mockNative()
    const controller = new AbortController()
    native.invoke.mockImplementation((command) => {
      if (command === `${prefix}prepare`) {
        queueMicrotask(() => controller.abort())
        return 'prepared-before-abort'
      }
    })
    const client = createChatGPT()
    await expect(client.signIn({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(native.calls('cancel')).toEqual([{ requestId: 'prepared-before-abort' }]))
    expect(native.calls('sign_in')).toHaveLength(0)
    await client.close()
  })

  it('rejects a pending sign-out caller on close without interrupting the native credential store', async () => {
    const native = mockNative()
    const nativeSignOut = deferred<unknown>()
    native.invoke.mockReturnValueOnce(nativeSignOut.promise)
    const client = createChatGPT()
    const result = client.signOut('personal').catch((error: unknown) => error)
    await vi.waitFor(() => expect(native.calls('sign_out')).toHaveLength(1))
    await client.close()
    await expect(result).resolves.toEqual(new ChatGPTError('client_closed'))
    expect(native.calls('cancel')).toHaveLength(0)
    nativeSignOut.resolve({ account: { ...account, status: 'signed-out' }, revocation: 'revoked' })
  })

  it('resolves a real Response at headers before the native invocation or body completes', async () => {
    const native = mockNative()
    const client = createChatGPT()
    const fetch = client.createFetch('personal')
    const result = fetch(new URL(responses), {
      method: 'POST',
      headers: { authorization: 'Bearer sdk-dummy', 'content-type': 'application/json' },
      body: '{"stream":true}',
    })
    const stream = await native.fetch()
    expect(stream.args.onEvent).toBeInstanceOf(Channel)
    expect(stream.args).toMatchObject({
      requestId: 'request-1',
      accountId: 'personal',
      request: {
        url: responses,
        method: 'POST',
        headers: [
          ['authorization', 'Bearer sdk-dummy'],
          ['content-type', 'application/json'],
        ],
        body: Array.from(new TextEncoder().encode('{"stream":true}')),
      },
    })
    stream.headers()
    const response = await result
    expect(response).toBeInstanceOf(Response)
    expect(response.status).toBe(200)
    expect(response.url).toBe(responses)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    expect(response.body).toBeInstanceOf(ReadableStream)
    expect(response.bodyUsed).toBe(false)
    const reader = response.body!.getReader()
    const first = reader.read()
    const bytes = new TextEncoder().encode('data: {"delta":"hello"}\n\n')
    stream.chunk(1, bytes)
    await expect(first).resolves.toEqual({ done: false, value: bytes })
    stream.end()
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined })
    expect(internals().callbacks.size).toBe(0)
    await client.close()
    expect(native.calls('cancel')).toHaveLength(0)
  })

  it('waits for channel end when the successful native reply arrives after headers but before end', async () => {
    const native = mockNative()
    const client = createChatGPT()
    const result = client.createFetch('personal')(models)
    const stream = await native.fetch()
    stream.headers()
    const response = await result
    const reader = response.body!.getReader()
    const first = reader.read()
    stream.chunk(1, Uint8Array.of(1, 2))
    await expect(first).resolves.toEqual({ done: false, value: Uint8Array.of(1, 2) })
    await vi.waitFor(() => expect(native.calls('ack')).toHaveLength(1))

    vi.useFakeTimers()
    const last = reader.read()
    const settled = vi.fn()
    void last.then(settled, settled)
    stream.done.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(59_999)
    expect(settled).not.toHaveBeenCalled()

    stream.end()
    await expect(last).resolves.toEqual({ done: true, value: undefined })
    expect(vi.getTimerCount()).toBe(0)
    expect(internals().callbacks.size).toBe(0)
    await client.close()
    expect(native.calls('cancel')).toHaveLength(0)
  })

  it('accepts delayed channel headers and end after the successful native reply', async () => {
    const native = mockNative()
    const client = createChatGPT()
    const result = client.createFetch('personal')(models)
    const stream = await native.fetch()
    const fetchSettled = vi.fn()
    void result.then(fetchSettled, fetchSettled)
    vi.useFakeTimers()
    stream.done.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchSettled).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)

    stream.headers()
    const response = await result
    const last = response.body!.getReader().read()
    const bodySettled = vi.fn()
    void last.then(bodySettled, bodySettled)
    await vi.advanceTimersByTimeAsync(59_999)
    expect(bodySettled).not.toHaveBeenCalled()
    stream.end()
    await expect(last).resolves.toEqual({ done: true, value: undefined })
    expect(vi.getTimerCount()).toBe(0)
    await client.close()
    expect(native.calls('cancel')).toHaveLength(0)
  })

  it('does not start a delivery deadline during a live ACK wait and releases the operation if end arrives first', async () => {
    const native = mockNative()
    const client = createChatGPT()
    const result = client.createFetch('personal')(models)
    const stream = await native.fetch()
    stream.headers()
    const response = await result
    stream.chunk(1, Uint8Array.of(1))
    vi.useFakeTimers()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(vi.getTimerCount()).toBe(0)
    expect(native.calls('ack')).toHaveLength(0)
    const reader = response.body!.getReader()
    await expect(reader.read()).resolves.toEqual({ done: false, value: Uint8Array.of(1) })
    await vi.advanceTimersByTimeAsync(0)
    expect(native.calls('ack')).toHaveLength(1)
    const last = reader.read()
    stream.emit({ type: 'end' })
    stream.drop()
    await expect(last).resolves.toEqual({ done: true, value: undefined })
    await client.close()
    expect(native.calls('cancel')).toHaveLength(0)
    stream.done.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('consumes a command rejection arriving after channel end without reopening the completed body', async () => {
    const native = mockNative()
    const client = createChatGPT()
    const result = client.createFetch('personal')(models)
    const stream = await native.fetch()
    stream.headers()
    const response = await result
    const body = response.text()
    stream.emit({ type: 'end' })
    stream.drop()
    await expect(body).resolves.toBe('')
    vi.useFakeTimers()
    stream.done.reject({ code: 'network_error', message: 'provider secret' })
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(0)
    await client.close()
    expect(native.calls('cancel')).toHaveLength(0)
  })

  it.each([false, true])(
    'bounds lost channel delivery after native success (headers received: %s)',
    async (headersReceived) => {
      const native = mockNative()
      const client = createChatGPT()
      const controller = new AbortController()
      const result = client
        .createFetch('personal')(models, { signal: controller.signal })
        .catch((error: unknown) => error)
      const stream = await native.fetch()
      const handler = stream.args.onEvent.onmessage
      let outcome: Promise<unknown> = result
      if (headersReceived) {
        stream.headers()
        const response = (await result) as Response
        outcome = response.text().catch((error: unknown) => error)
      }
      stream.lose() // Logical end (or headers) is lost, but the native DROP has the next index.
      stream.drop()
      expect(internals().callbacks.has(stream.args.onEvent.id)).toBe(true)
      const unregister = vi.spyOn(internals(), 'unregisterCallback')
      const settled = vi.fn()
      void outcome.then(settled)
      vi.useFakeTimers()
      stream.done.resolve()
      await vi.advanceTimersByTimeAsync(0)
      expect(vi.getTimerCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(59_999)
      expect(settled).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await expect(outcome).resolves.toEqual(new ChatGPTError('invalid_response'))
      expect(vi.getTimerCount()).toBe(0)
      expect(native.calls('cancel')).toEqual([{ requestId: 'request-1' }])
      expect(stream.args.onEvent.onmessage).not.toBe(handler)
      expect(internals().callbacks.size).toBe(0)
      expect(unregister.mock.calls).toEqual([[stream.args.onEvent.id]])
      controller.abort()
      await client.close()
      expect(native.calls('cancel')).toHaveLength(1)
      expect(internals().callbacks.size).toBe(0)
      expect(unregister).toHaveBeenCalledOnce()
    },
  )

  it('close cancels a native-success/channel-end gap and clears its deadline', async () => {
    const native = mockNative()
    const client = createChatGPT()
    const result = client.createFetch('personal')(models)
    const stream = await native.fetch()
    stream.headers()
    const response = await result
    const body = response.text().catch((error: unknown) => error)
    const handler = stream.args.onEvent.onmessage
    stream.lose() // End at index 1 is missing; DROP at index 2 cannot dispose the callback itself.
    stream.drop()
    expect(internals().callbacks.has(stream.args.onEvent.id)).toBe(true)
    vi.useFakeTimers()
    stream.done.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(1)
    await client.close()
    await expect(body).resolves.toEqual(new ChatGPTError('client_closed'))
    expect(native.calls('cancel')).toEqual([{ requestId: 'request-1' }])
    expect(stream.args.onEvent.onmessage).not.toBe(handler)
    expect(vi.getTimerCount()).toBe(0)
    expect(internals().callbacks.size).toBe(0)
    stream.end()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(native.calls('cancel')).toHaveLength(1)
  })

  it.each(['abort', 'cancel', 'native-error', 'protocol-error'] as const)(
    'disposes the callback on %s even when native DROP is stuck behind a missing message',
    async (cause) => {
      const native = mockNative()
      const client = createChatGPT()
      const controller = new AbortController()
      const result = client.createFetch('personal')(models, { signal: controller.signal })
      const stream = await native.fetch()
      stream.headers()
      const response = await result
      const reader = response.body!.getReader()
      const outcome = reader.read().catch((error: unknown) => error)
      stream.lose()
      // For the protocol failure, index 1 will arrive with an invalid sequence, but index 2
      // remains lost. A DROP at index 3 must not make the test pass by auto-disposing Channel.
      if (cause === 'protocol-error') stream.lose()
      stream.drop()
      expect(internals().callbacks.has(stream.args.onEvent.id)).toBe(true)
      const unregister = vi.spyOn(internals(), 'unregisterCallback')
      vi.useFakeTimers()
      if (cause === 'abort') controller.abort()
      else if (cause === 'cancel') await reader.cancel()
      else if (cause === 'native-error') stream.done.reject({ code: 'network_error', message: 'provider secret' })
      else stream.emit({ type: 'chunk', sequence: 2, data: [1] }, 1)
      await vi.advanceTimersByTimeAsync(0)
      if (cause === 'abort') await expect(outcome).resolves.toMatchObject({ name: 'AbortError' })
      else if (cause === 'cancel') await expect(outcome).resolves.toEqual({ done: true, value: undefined })
      else
        await expect(outcome).resolves.toEqual(
          new ChatGPTError(cause === 'native-error' ? 'network_error' : 'invalid_response'),
        )
      expect(internals().callbacks.size).toBe(0)
      expect(unregister.mock.calls).toEqual([[stream.args.onEvent.id]])
      expect(native.calls('cancel')).toEqual([{ requestId: 'request-1' }])
      expect(vi.getTimerCount()).toBe(0)
      await client.close()
      stream.done.resolve()
      await vi.advanceTimersByTimeAsync(0)
      expect(unregister).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)

      stream.emit({ type: 'end' }, 1)
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining(`Couldn't find callback id ${stream.args.onEvent.id}`),
      )
      expect(internals().callbacks.size).toBe(0)
      expect(native.calls('cancel')).toHaveLength(1)
    },
  )

  it('still completes when channel frames and native DROP arrive out of order', async () => {
    const native = mockNative()
    const client = createChatGPT()
    const result = client.createFetch('personal')(models)
    const stream = await native.fetch()
    vi.useFakeTimers()
    stream.emit({ type: 'end' }, 1)
    stream.drop() // DROP at index 2 and end at index 1 both wait for headers at index 0.
    expect(internals().callbacks.has(stream.args.onEvent.id)).toBe(true)
    stream.emit({ type: 'response', status: 200, statusText: 'OK', headers: [], url: models }, 0)
    const response = await result
    await expect(response.text()).resolves.toBe('')
    expect(internals().callbacks.size).toBe(0)
    stream.done.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(0)
    await client.close()
    expect(native.calls('cancel')).toHaveLength(0)
  })

  it('applies Request/init semantics and preserves split UTF-8 and SSE bytes with acknowledgement backpressure', async () => {
    const native = mockNative()
    const client = createChatGPT()
    const original = new Request(responses, { method: 'POST', headers: { 'x-original': 'yes' }, body: 'old' })
    const result = client.createFetch('personal')(original, { headers: { 'x-new': 'yes' }, body: 'new' })
    const stream = await native.fetch()
    expect(stream.args.request.method).toBe('POST')
    expect(stream.args.request.headers).toContainEqual(['x-new', 'yes'])
    expect(stream.args.request.headers).not.toContainEqual(['x-original', 'yes'])
    expect(stream.args.request.body).toEqual(Array.from(new TextEncoder().encode('new')))
    stream.headers()
    const response = await result
    const bytes = new TextEncoder().encode('data: {"delta":"Á🙂"}\n\ndata: [DONE]\n\n')
    const split = 19 // In the middle of the emoji's UTF-8 sequence.
    stream.chunk(1, bytes.subarray(0, split))
    await Promise.resolve()
    expect(native.calls('ack')).toHaveLength(0)
    const text = response.text()
    await vi.waitFor(() => expect(native.calls('ack')).toEqual([{ requestId: 'request-1', sequence: 1 }]))
    stream.chunk(2, bytes.subarray(split))
    await vi.waitFor(() => expect(native.calls('ack')).toHaveLength(2))
    stream.end()
    await expect(text).resolves.toBe(new TextDecoder().decode(bytes))
    expect(native.calls('ack')).toEqual([
      { requestId: 'request-1', sequence: 1 },
      { requestId: 'request-1', sequence: 2 },
    ])
    await client.close()
  })

  it('acknowledges a queued chunk only when a consumer creates capacity', async () => {
    const native = mockNative()
    const client = createChatGPT()
    const result = client.createFetch('personal')(`${models}/gpt-test`)
    const stream = await native.fetch()
    stream.headers()
    const response = await result
    stream.chunk(1, Uint8Array.of(1))
    const reader = response.body!.getReader()
    await Promise.resolve()
    expect(native.calls('ack')).toHaveLength(0)
    await expect(reader.read()).resolves.toEqual({ done: false, value: Uint8Array.of(1) })
    await vi.waitFor(() => expect(native.calls('ack')).toHaveLength(1))
    stream.chunk(2, Uint8Array.of(2))
    await Promise.resolve()
    expect(native.calls('ack')).toHaveLength(1)
    await reader.read()
    await vi.waitFor(() => expect(native.calls('ack')).toHaveLength(2))
    stream.end()
    await client.close()
  })

  it('returns ordinary HTTP error responses, not transport errors', async () => {
    const native = mockNative()
    const client = createChatGPT()
    const result = client.createFetch('personal')(models)
    const stream = await native.fetch()
    stream.headers(429, [
      ['content-type', 'application/json'],
      ['retry-after', '10'],
    ])
    const response = await result
    expect(response.ok).toBe(false)
    expect(response.headers.get('retry-after')).toBe('10')
    const body = response.json()
    stream.chunk(1, new TextEncoder().encode('{"error":{"message":"rate limited"}}'))
    await vi.waitFor(() => expect(native.calls('ack')).toHaveLength(1))
    stream.end()
    await expect(body).resolves.toEqual({ error: { message: 'rate limited' } })
    await client.close()
  })

  it.each([204, 205, 304, 'HEAD'] as const)('constructs a null body for %s', async (status) => {
    const native = mockNative()
    const client = createChatGPT()
    const result = client.createFetch('personal')(models, status === 'HEAD' ? { method: 'HEAD' } : undefined)
    const stream = await native.fetch()
    stream.headers(status === 'HEAD' ? 200 : status)
    const response = await result
    expect(response.body).toBeNull()
    await expect(response.text()).resolves.toBe('')
    stream.end()
    await client.close()
  })

  it('reports native rejection before headers and errors an already returned response body safely', async () => {
    const native = mockNative()
    const client = createChatGPT()
    const fetch = client.createFetch('personal')
    const first = fetch(models).catch((error: unknown) => error)
    const beforeHeaders = await native.fetch()
    beforeHeaders.done.reject({ code: 'reauth_required', message: 'access_token=secret' })
    await expect(first).resolves.toEqual(new ChatGPTError('reauth_required'))
    const second = fetch(models)
    const afterHeaders = await native.fetch(1)
    afterHeaders.headers()
    const response = await second
    const body = response.text().catch((error: unknown) => error)
    afterHeaders.done.reject({ code: 'network_error', message: 'provider secret' })
    await expect(body).resolves.toEqual(new ChatGPTError('network_error'))
    expect(beforeHeaders.args.onEvent.onmessage).toBe(afterHeaders.args.onEvent.onmessage)
    beforeHeaders.drop()
    afterHeaders.drop()
    await client.close()
  })

  it('aborts returned bodies using Request signals and cancels native work on reader cancellation', async () => {
    const native = mockNative()
    const client = createChatGPT()
    const controller = new AbortController()
    const first = client.createFetch('personal')(new Request(models, { signal: controller.signal }))
    const stream = await native.fetch()
    stream.headers()
    const response = await first
    // This runs a full GC while the caller no longer holds the temporary input Request.
    // Node forwards Request aborts through weak controller references.
    queryObjects(Request)
    const body = response.text().catch((error: Error) => error)
    controller.abort()
    await expect(body).resolves.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(native.calls('cancel')).toEqual([{ requestId: 'request-1' }]))
    const second = client.createFetch('personal')(models)
    const cancelled = await native.fetch(1)
    cancelled.headers()
    const otherResponse = await second
    await otherResponse.body!.cancel('untrusted reason')
    expect(native.calls('cancel')).toEqual([{ requestId: 'request-1' }, { requestId: 'request-2' }])
    expect(stream.args.onEvent.onmessage).toBe(cancelled.args.onEvent.onmessage)
    stream.drop()
    cancelled.drop()
    stream.done.reject({ code: 'cancelled', message: 'The operation was cancelled.' })
    cancelled.done.resolve()
    await client.close()
  })

  it('close affects only this client, leaves saved accounts alone, and disables existing fetch functions', async () => {
    const native = mockNative()
    const first = createChatGPT()
    const second = createChatGPT()
    const fetch = first.createFetch('personal')
    const firstResult = fetch(models)
    const firstStream = await native.fetch()
    firstStream.headers()
    const firstResponse = await firstResult
    const firstBody = firstResponse.text().catch((error: unknown) => error)
    const secondResult = second.createFetch('personal')(models)
    const secondStream = await native.fetch(1)
    secondStream.headers()
    const secondResponse = await secondResult
    await first.close()
    await expect(firstBody).resolves.toEqual(new ChatGPTError('client_closed'))
    expect(native.calls('cancel')).toEqual([{ requestId: 'request-1' }])
    expect(native.calls('sign_out')).toHaveLength(0)
    await expect(fetch(models)).rejects.toEqual(new ChatGPTError('client_closed'))
    const secondBody = secondResponse.text()
    secondStream.end()
    await expect(secondBody).resolves.toBe('')
    await expect(second.listAccounts()).resolves.toEqual([account])
    firstStream.drop()
    firstStream.done.resolve()
    await second.close()
  })

  it('cancels late fetch preparation without invoking fetch', async () => {
    const native = mockNative()
    const prepare = deferred<string>()
    native.invoke.mockReturnValueOnce(prepare.promise)
    const client = createChatGPT()
    const controller = new AbortController()
    const result = client
      .createFetch('personal')(models, { signal: controller.signal })
      .catch((error: Error) => error)
    await vi.waitFor(() => expect(native.calls('prepare')).toHaveLength(1))
    controller.abort()
    await expect(result).resolves.toMatchObject({ name: 'AbortError' })
    prepare.resolve('late-fetch')
    await vi.waitFor(() => expect(native.calls('cancel')).toEqual([{ requestId: 'late-fetch' }]))
    expect(native.calls('fetch')).toHaveLength(0)
    await client.close()
  })

  it('validates explicit account selection and blocks unsupported URLs before IPC', async () => {
    const native = mockNative()
    const client = createChatGPT()
    expect(() => client.createFetch(' ')).toThrow(new ChatGPTError('invalid_account'))
    const fetch = client.createFetch('personal')
    for (const url of [
      'file:///private/key',
      'http://api.openai.com/v1/models',
      'https://api.openai.com.evil.test/v1/models',
      'https://example.com/v1/responses',
      'https://api.openai.com/v1/chat/completions',
      'https://api.openai.com:444/v1/models',
      'https://api.openai.com/v1/models#fragment',
      'https://api.openai.com/v1/models/model/subpath',
    ])
      await expect(fetch(url)).rejects.toEqual(new ChatGPTError('unsupported_url'))
    await expect(fetch('/v1/models')).rejects.toBeInstanceOf(TypeError)
    expect(native.invoke).not.toHaveBeenCalled()
    await client.close()
  })

  it('bounds streaming uploads and aborts stalled body reads without waiting for their source', async () => {
    const native = mockNative()
    const client = createChatGPT()
    const fetch = client.createFetch('personal')
    const cancel = vi.fn()
    const tooLarge = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1))
      },
      cancel,
    })
    const upload = (body: ReadableStream<Uint8Array>, signal?: AbortSignal) =>
      fetch(responses, { method: 'POST', body, signal, duplex: 'half' } as RequestInit)
    await expect(upload(tooLarge)).rejects.toEqual(new ChatGPTError('body_too_large'))
    expect(cancel).toHaveBeenCalledOnce()
    expect(native.invoke).not.toHaveBeenCalled()
    const controller = new AbortController()
    const stalled = new ReadableStream<Uint8Array>({ cancel: () => new Promise(() => {}) })
    const aborted = upload(stalled, controller.signal).catch((error: Error) => error)
    await Promise.resolve()
    controller.abort()
    await expect(aborted).resolves.toMatchObject({ name: 'AbortError' })
    const closed = upload(new ReadableStream<Uint8Array>()).catch((error: unknown) => error)
    await Promise.resolve()
    await client.close()
    await expect(closed).resolves.toEqual(new ChatGPTError('client_closed'))
    expect(native.invoke).not.toHaveBeenCalled()
  })

  it('rejects invalid chunk sequencing and safely handles failed acknowledgements', async () => {
    const native = mockNative()
    const client = createChatGPT()
    const first = client.createFetch('personal')(models)
    const stream = await native.fetch()
    stream.headers()
    const response = await first
    stream.chunk(2, Uint8Array.of(1))
    await expect(response.text()).rejects.toEqual(new ChatGPTError('invalid_response'))
    const second = client.createFetch('personal')(models)
    const failedAck = await native.fetch(1)
    failedAck.headers()
    const secondResponse = await second
    const body = secondResponse.text().catch((error: unknown) => error)
    native.invoke.mockRejectedValueOnce({ code: 'ack_failed', message: 'secret' })
    failedAck.chunk(1, Uint8Array.of(1))
    await expect(body).resolves.toEqual(new ChatGPTError('ack_failed'))
    stream.drop()
    failedAck.drop()
    stream.done.resolve()
    failedAck.done.resolve()
    await client.close()
  })
})
