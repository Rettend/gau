/** Account-picker data only. Credentials remain in the native store. */
export interface ChatGPTAccount {
  id: string
  clientId: string
  issuer: string
  subject: string
  email: string | null
  emailVerified: boolean | null
  name: string | null
  picture: string | null
  scopes: string[]
  status: 'ready' | 'identity-only' | 'signed-out' | 'reauth-required'
  /** Unix milliseconds. */
  createdAt: number
  /** Unix milliseconds. */
  updatedAt: number
}

export interface ChatGPTSignOutResult {
  account: ChatGPTAccount
  revocation: 'revoked' | 'not-attempted' | 'failed'
}

export interface ChatGPTSignInOptions {
  accountId?: string
  prompt?: 'consent'
  signal?: AbortSignal
}

export interface ChatGPTClient {
  signIn: (options?: ChatGPTSignInOptions) => Promise<ChatGPTAccount>
  listAccounts: () => Promise<ChatGPTAccount[]>
  signOut: (accountId: string) => Promise<ChatGPTSignOutResult>
  /** Select an account explicitly. Rust supplies its credentials for each request. */
  createFetch: (accountId: string) => typeof globalThis.fetch
  /** Abort this client's pending operations. Saved accounts are not removed. */
  close: () => Promise<void>
}

const ERROR_MESSAGES: Record<string, string> = {
  cancelled: 'The operation was cancelled.',
  client_closed: 'The ChatGPT client is closed.',
  invalid_account: 'Select a ChatGPT account.',
  invalid_response: 'The native ChatGPT response was invalid.',
  unsupported_url: 'This URL is not supported by ChatGPT fetch.',
  body_too_large: 'The request body exceeds 16 MiB.',
  account_not_found: 'The selected connection account was not found.',
  reauth_required: 'Sign in to the selected connection again.',
  insufficient_scope: 'The selected connection has not granted resource access.',
  connection_changed: 'The connection changed during sign-in. Try again.',
  identity_mismatch: 'The result does not match the selected registration.',
  registration_exists: 'Select the existing registration to sign in again.',
  refresh_not_available: 'The issuer does not permit refreshing this token yet.',
  access_denied: 'Authorization was declined.',
  authorization_failed: 'Authorization failed.',
  authorization_timeout: 'Sign-in timed out. Start a new attempt.',
  store_busy: 'The connection store is busy. Try again.',
  store_unavailable: 'The connection store could not be accessed.',
  store_key_missing: 'The encryption key for the existing connection store is missing.',
  keystore_unavailable: 'The operating system credential store is unavailable.',
  invalid_store: 'The connection store is corrupt or unsupported. Restore it instead of resetting it.',
  browserOpenFailed: 'Could not open the system browser.',
  browser_unavailable: 'The system browser could not be opened.',
  invalidRequest: 'Only supported HTTPS OpenAI API requests are allowed.',
  invalidRequestId: 'The Gau request is unknown, expired, or already used.',
  invalidAcknowledgement: 'The stream acknowledgement does not match the pending chunk.',
  channelClosed: 'The response stream was closed.',
  networkError: 'The native OpenAI request failed.',
  network_error: 'The OpenAI request could not be completed.',
  timeout: 'The native OpenAI request or stream timed out.',
  request_timeout: 'The OpenAI request timed out.',
  tooManyRequests: 'Too many Gau operations are pending.',
  unavailable: 'Gau is shutting down.',
}

/** A safe error: arbitrary native/provider messages are never forwarded. */
export class ChatGPTError extends Error {
  readonly code?: string

  constructor(code?: string) {
    const safeCode = typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/i.test(code) ? code : undefined
    super(
      (safeCode && Object.hasOwn(ERROR_MESSAGES, safeCode) && ERROR_MESSAGES[safeCode]) || 'ChatGPT request failed.',
    )
    this.name = 'ChatGPTError'
    this.code = safeCode
  }
}

type Core = typeof import('@tauri-apps/api/core')
type FetchEvent =
  | { type: 'response'; status: number; statusText: string; headers: [string, string][]; url: string }
  | { type: 'chunk'; sequence: number; data: number[] }
  | { type: 'end' }

const MAX_BODY_BYTES = 16 * 1024 * 1024
const MAX_CHUNK_BYTES = 64 * 1024
const CHANNEL_COMPLETION_TIMEOUT_MS = 60_000
const ignoreEvent = () => {}

function disposeChannel(channel: import('@tauri-apps/api/core').Channel<FetchEvent>): void {
  channel.onmessage = ignoreEvent
  if (typeof window === 'undefined') return
  // Tauri 2 has no public Channel.dispose. Match its cleanupCallback (present in API 2.6):
  // a native DROP can otherwise wait forever behind a missing channel message.
  const internals = (window as unknown as { __TAURI_INTERNALS__?: { unregisterCallback?: (id: number) => void } })
    .__TAURI_INTERNALS__
  if (typeof internals?.unregisterCallback === 'function') internals.unregisterCallback(channel.id)
}

function nativeError(value: unknown): ChatGPTError {
  return value instanceof ChatGPTError
    ? value
    : new ChatGPTError(
        value && typeof value === 'object' && 'code' in value && typeof value.code === 'string'
          ? value.code
          : undefined,
      )
}

function accountId(value: string): void {
  if (typeof value !== 'string' || !value.trim()) throw new ChatGPTError('invalid_account')
}

function account(value: unknown): ChatGPTAccount {
  if (!value || typeof value !== 'object') throw new ChatGPTError('invalid_response')
  const data = value as Record<string, unknown>
  const nullableString = (key: string) => data[key] === null || typeof data[key] === 'string'
  if (
    !['id', 'clientId', 'issuer', 'subject'].every((key) => typeof data[key] === 'string') ||
    !['email', 'name', 'picture'].every(nullableString) ||
    !(data.emailVerified === null || typeof data.emailVerified === 'boolean') ||
    !Array.isArray(data.scopes) ||
    !data.scopes.every((scope) => typeof scope === 'string') ||
    typeof data.status !== 'string' ||
    !['ready', 'identity-only', 'signed-out', 'reauth-required'].includes(data.status) ||
    !['createdAt', 'updatedAt'].every((key) => Number.isSafeInteger(data[key]) && (data[key] as number) >= 0)
  )
    throw new ChatGPTError('invalid_response')
  // Pick fields rather than trusting a cast: even an incorrectly configured plugin cannot return credentials here.
  return {
    id: data.id as string,
    clientId: data.clientId as string,
    issuer: data.issuer as string,
    subject: data.subject as string,
    email: data.email as string | null,
    emailVerified: data.emailVerified as boolean | null,
    name: data.name as string | null,
    picture: data.picture as string | null,
    scopes: [...data.scopes] as string[],
    status: data.status as ChatGPTAccount['status'],
    createdAt: data.createdAt as number,
    updatedAt: data.updatedAt as number,
  }
}

function validateUrl(url: string): void {
  const parsed = new URL(url)
  const pathAllowed =
    ['/v1/models', '/v1/responses'].includes(parsed.pathname) || /^\/v1\/models\/[a-z0-9_.:-]+$/i.test(parsed.pathname)
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== 'api.openai.com' ||
    parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    !pathAllowed
  )
    throw new ChatGPTError('unsupported_url')
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Creates a lazy client for tauri-plugin-gau. Safe to construct during SSR. */
export function createChatGPT(): ChatGPTClient {
  let core: Promise<Core> | undefined
  let closed = false
  let closing: Promise<void> | undefined
  const pending = new Set<ReturnType<typeof operation>>()
  const loadCore = () => (core ??= import('@tauri-apps/api/core'))
  const assertOpen = () => {
    if (closed) throw new ChatGPTError('client_closed')
  }

  function operation(signal?: AbortSignal) {
    assertOpen()
    const controller = new AbortController()
    let error: Error | undefined
    let prepared: Promise<{ api: Core; requestId: string }> | undefined
    let native: { api: Core; requestId: string } | undefined
    let cancellation: Promise<void> | undefined

    function cancelNative(): Promise<void> {
      cancellation ??= (async () => {
        // Preparing can finish after abort. Reserve its ID, then cancel it without starting the operation.
        await prepared?.catch(ignoreEvent)
        if (native)
          await native.api.invoke('plugin:gau|chatgpt_cancel', { requestId: native.requestId }).catch(ignoreEvent)
      })()
      return cancellation
    }

    function abort(reason: Error): Promise<void> {
      if (!controller.signal.aborted) {
        error = reason
        controller.abort()
      }
      return cancelNative()
    }

    const onAbort = () => void abort(new DOMException('The operation was aborted.', 'AbortError'))
    const op = {
      signal: controller.signal,
      get error() {
        return error
      },
      check() {
        if (error) throw error
      },
      abort,
      finish() {
        pending.delete(op)
        signal?.removeEventListener('abort', onAbort)
      },
      wait<T>(promise: Promise<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
          const aborted = () => {
            controller.signal.removeEventListener('abort', aborted)
            reject(error)
          }
          controller.signal.addEventListener('abort', aborted, { once: true })
          if (error) aborted()
          promise.then(
            (value) => {
              controller.signal.removeEventListener('abort', aborted)
              resolve(value)
            },
            (error) => {
              controller.signal.removeEventListener('abort', aborted)
              reject(error)
            },
          )
        })
      },
      prepare(kind: 'signIn' | 'fetch') {
        prepared = (async () => {
          const api = await loadCore()
          op.check()
          const requestId = await api.invoke<unknown>('plugin:gau|chatgpt_prepare', { kind })
          if (typeof requestId !== 'string' || !requestId) throw new ChatGPTError('invalid_response')
          native = { api, requestId }
          op.check()
          return native
        })()
        return prepared
      },
    }
    pending.add(op)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    return op
  }

  async function request<T>(command: string, args: Record<string, unknown> | undefined, decode: (value: unknown) => T) {
    const op = operation()
    try {
      const api = await op.wait(loadCore())
      op.check()
      return decode(await op.wait(api.invoke(command, args)))
    } catch (error) {
      throw op.error ?? nativeError(error)
    } finally {
      op.finish()
    }
  }

  async function readBody(req: Request, op: ReturnType<typeof operation>): Promise<number[] | undefined> {
    if (!req.body) return undefined
    const reader = req.body.getReader()
    const cancel = () => void reader.cancel().catch(ignoreEvent)
    op.signal.addEventListener('abort', cancel, { once: true })
    try {
      op.check()
      const chunks: Uint8Array[] = []
      let length = 0
      while (true) {
        const { done, value } = await op.wait(reader.read())
        op.check()
        if (done) break
        if (!(value instanceof Uint8Array)) throw new TypeError('The request body must contain byte chunks.')
        length += value.byteLength
        if (length > MAX_BODY_BYTES) throw new ChatGPTError('body_too_large')
        chunks.push(value.slice())
      }
      const body = new Uint8Array(length)
      let offset = 0
      for (const chunk of chunks) {
        body.set(chunk, offset)
        offset += chunk.byteLength
      }
      return Array.from(body)
    } catch (error) {
      cancel()
      throw error
    } finally {
      op.signal.removeEventListener('abort', cancel)
      reader.releaseLock()
    }
  }

  function createFetch(selectedAccountId: string): typeof globalThis.fetch {
    assertOpen()
    accountId(selectedAccountId)
    return async (input, init) => {
      assertOpen()
      const req = new Request(input, init)
      validateUrl(req.url)
      const op = operation(req.signal)
      // Node forwards Request aborts through weak controller references. Keep the
      // input and normalized Requests alive until the response body finishes.
      const requests = new Set([req])
      if (input instanceof Request) requests.add(input)
      const result = deferred<Response>()
      let channel: import('@tauri-apps/api/core').Channel<FetchEvent> | undefined
      let stream: ReadableStreamDefaultController<Uint8Array> | undefined
      const completion: {
        channel: 'pending' | 'response' | 'ended'
        native: 'pending' | 'fulfilled' | 'rejected'
      } = { channel: 'pending', native: 'pending' }
      let finished = false
      let completionTimeout: ReturnType<typeof globalThis.setTimeout> | undefined
      let sequence = 0
      let pendingAck: number | undefined
      let native: { api: Core; requestId: string } | undefined

      function cleanup() {
        requests.clear()
        if (completionTimeout !== undefined) {
          globalThis.clearTimeout(completionTimeout)
          completionTimeout = undefined
        }
        const activeChannel = channel
        channel = undefined
        if (activeChannel) disposeChannel(activeChannel)
        op.signal.removeEventListener('abort', aborted)
        op.finish()
      }

      function fail(error: Error, cancel = true) {
        if (finished) return
        finished = true
        result.reject(error)
        stream?.error(error)
        if (cancel) void op.abort(error)
        cleanup()
      }

      function aborted() {
        fail(op.error!, false)
      }

      function acknowledge(): Promise<void> | undefined {
        if (finished || pendingAck === undefined || !native || !stream || (stream.desiredSize ?? 0) <= 0) return
        const ack = pendingAck
        pendingAck = undefined
        return native.api
          .invoke<void>('plugin:gau|chatgpt_ack', { requestId: native.requestId, sequence: ack })
          .catch((error) => {
            fail(nativeError(error))
          })
      }

      function receive(event: FetchEvent) {
        if (finished) return
        try {
          if (event.type === 'response') {
            if (completion.channel !== 'pending') throw new ChatGPTError('invalid_response')
            const noBody = req.method === 'HEAD' || [204, 205, 304].includes(event.status)
            const body = noBody
              ? null
              : new ReadableStream<Uint8Array>({
                  start(controller) {
                    stream = controller
                  },
                  pull: acknowledge,
                  cancel() {
                    if (finished) return
                    finished = true
                    const cancelling = op.abort(new DOMException('The operation was aborted.', 'AbortError'))
                    cleanup()
                    return cancelling
                  },
                })
            const response = new Response(body, {
              status: event.status,
              statusText: event.statusText,
              headers: event.headers,
            })
            Object.defineProperty(response, 'url', { value: event.url })
            completion.channel = 'response'
            result.resolve(response)
          } else if (event.type === 'chunk') {
            if (
              completion.channel !== 'response' ||
              !stream ||
              pendingAck !== undefined ||
              event.sequence !== sequence + 1 ||
              !Array.isArray(event.data) ||
              event.data.length > MAX_CHUNK_BYTES ||
              !event.data.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
            )
              throw new ChatGPTError('invalid_response')
            sequence = event.sequence
            pendingAck = sequence
            stream.enqueue(Uint8Array.from(event.data))
            void acknowledge()
          } else if (event.type === 'end' && completion.channel === 'response') {
            if (pendingAck !== undefined) throw new ChatGPTError('invalid_response')
            completion.channel = 'ended'
            finished = true
            stream?.close()
            cleanup()
          } else {
            throw new ChatGPTError('invalid_response')
          }
        } catch {
          fail(new ChatGPTError('invalid_response'))
        }
      }

      op.signal.addEventListener('abort', aborted, { once: true })
      void (async () => {
        try {
          op.check()
          const body = await readBody(req, op)
          native = await op.wait(op.prepare('fetch'))
          op.check()
          channel = new native.api.Channel<FetchEvent>(receive)
          await native.api
            .invoke<void>('plugin:gau|chatgpt_fetch', {
              requestId: native.requestId,
              accountId: selectedAccountId,
              request: {
                url: req.url,
                method: req.method,
                headers: Array.from(req.headers.entries()),
                ...(body === undefined ? {} : { body }),
              },
              onEvent: channel,
            })
            .then(
              () => {
                completion.native = 'fulfilled'
              },
              (error: unknown) => {
                completion.native = 'rejected'
                throw error
              },
            )
          if (!finished && completion.native === 'fulfilled') {
            // IPC replies and Channel messages have independent delivery order. Only bound the
            // final delivery window after Rust has finished, never a live stream or chunk ACK wait.
            completionTimeout = globalThis.setTimeout(
              () => fail(new ChatGPTError('invalid_response')),
              CHANNEL_COMPLETION_TIMEOUT_MS,
            )
          }
        } catch (error) {
          // An end event already closed the body and released this operation. Still consume a
          // later command rejection, but do not try to resurrect or error that completed body.
          if (completion.channel !== 'ended') fail(op.error ?? nativeError(error))
        }
      })()
      return result.promise
    }
  }

  return {
    async signIn(options = {}) {
      const { accountId: selectedAccountId, prompt, signal } = options
      if (selectedAccountId !== undefined) accountId(selectedAccountId)
      const op = operation(signal)
      try {
        const { api, requestId } = await op.wait(op.prepare('signIn'))
        op.check()
        return account(
          await op.wait(
            api.invoke('plugin:gau|chatgpt_sign_in', {
              requestId,
              options: {
                ...(selectedAccountId === undefined ? {} : { accountId: selectedAccountId }),
                ...(prompt === undefined ? {} : { prompt }),
              },
            }),
          ),
        )
      } catch (error) {
        throw op.error ?? nativeError(error)
      } finally {
        op.finish()
      }
    },
    listAccounts: () =>
      request('plugin:gau|chatgpt_list_accounts', undefined, (value) => {
        if (!Array.isArray(value)) throw new ChatGPTError('invalid_response')
        return value.map(account)
      }),
    async signOut(selectedAccountId) {
      accountId(selectedAccountId)
      return request('plugin:gau|chatgpt_sign_out', { accountId: selectedAccountId }, (value) => {
        if (!value || typeof value !== 'object' || !('account' in value) || !('revocation' in value))
          throw new ChatGPTError('invalid_response')
        if (typeof value.revocation !== 'string' || !['revoked', 'not-attempted', 'failed'].includes(value.revocation))
          throw new ChatGPTError('invalid_response')
        return { account: account(value.account), revocation: value.revocation as ChatGPTSignOutResult['revocation'] }
      })
    },
    createFetch,
    close() {
      if (closing) return closing
      closed = true
      closing = Promise.all([...pending].map((op) => op.abort(new ChatGPTError('client_closed')))).then(ignoreEvent)
      return closing
    },
  }
}
