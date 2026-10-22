import type { GauSession } from '../../src/core'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import * as token from '../../src/client/token'
import { createClientAuth } from '../../src/client/shared/clientAuth'
import { createAuthClient } from '../../src/client/vanilla'

function createSession(id: string): GauSession {
  return { user: { id }, session: { sub: id }, accounts: [], providers: [] }
}

function createClient(overrides: Record<string, unknown> = {}) {
  return {
    fetch: vi.fn(),
    refreshSession: vi.fn().mockResolvedValue(createSession('refresh')),
    handleRedirectCallback: vi.fn().mockResolvedValue(false),
    onSessionChange: vi.fn(() => vi.fn()),
    startTauriBridge: vi.fn(),
    signIn: vi.fn().mockResolvedValue('https://auth.test/sign-in'),
    linkAccount: vi.fn().mockResolvedValue('https://auth.test/link'),
    unlinkAccount: vi.fn().mockResolvedValue(true),
    signOut: vi.fn(),
    ...overrides,
  } as any
}

const webEnv = {
  isBrowser: () => true,
  isTauri: () => false,
  origin: () => 'https://app.test',
  href: () => 'https://app.test/current',
  navigate: vi.fn(),
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('client auth controller', () => {
  it('uses browser redirect defaults and navigates web auth actions', async () => {
    const navigate = vi.fn()
    const client = createClient()
    const auth = createClientAuth({
      client,
      setSession: vi.fn(),
      env: { ...webEnv, navigate },
    })

    await auth.controls.signIn('github')
    await auth.controls.linkAccount('github')

    expect(client.signIn).toHaveBeenCalledWith('github', { redirectTo: 'https://app.test', profile: undefined })
    expect(client.linkAccount).toHaveBeenCalledWith('github', {
      redirectTo: 'https://app.test/current',
      profile: undefined,
    })
    expect(navigate).toHaveBeenNthCalledWith(1, 'https://auth.test/sign-in')
    expect(navigate).toHaveBeenNthCalledWith(2, 'https://auth.test/link')
  })

  it('uses configured redirect defaults and avoids browser navigation in Tauri', async () => {
    const navigate = vi.fn()
    const client = createClient()
    const auth = createClientAuth({
      client,
      redirectTo: 'https://default.test/redirect',
      setSession: vi.fn(),
      env: { ...webEnv, isTauri: () => true, navigate },
    })

    await auth.controls.linkAccount('github', { profile: 'work' as any })

    expect(client.linkAccount).toHaveBeenCalledWith('github', {
      redirectTo: 'https://default.test/redirect',
      profile: 'work',
    })
    expect(navigate).not.toHaveBeenCalled()
  })

  it('does not replace the native client deep-link default with a browser origin', async () => {
    const client = createClient()
    const auth = createClientAuth({ client, setSession: vi.fn(), env: { ...webEnv, isTauri: () => true } })
    await auth.controls.signIn('github')
    expect(client.signIn).toHaveBeenCalledWith('github', { redirectTo: undefined, profile: undefined })
  })

  it('delivers existing and changing session errors until the provider is disposed', () => {
    const error = new Error('session unavailable')
    const unsubscribe = vi.fn()
    let publish!: (error: unknown) => void
    const client = createClient({
      sessionError: error,
      onSessionError: vi.fn((listener: (error: unknown) => void) => {
        publish = listener
        return unsubscribe
      }),
    })
    const onSessionError = vi.fn()
    const auth = createClientAuth({ client, setSession: vi.fn(), onSessionError, env: webEnv, refreshOnMount: false })
    const dispose = auth.mount()
    expect(onSessionError).toHaveBeenCalledWith(error)
    publish(null)
    expect(onSessionError).toHaveBeenLastCalledWith(null)
    dispose()
    expect(unsubscribe).toHaveBeenCalledOnce()
    publish(error)
    expect(onSessionError).toHaveBeenCalledTimes(2)
  })

  it('handles redirect callbacks without fallback refresh', async () => {
    const unsubscribe = vi.fn()
    const onReady = vi.fn()
    const setSession = vi.fn()
    const handleRedirectCallback = vi.fn().mockResolvedValue(true)
    const client = createClient({
      handleRedirectCallback,
      onSessionChange: vi.fn((listener: (session: GauSession) => void) => {
        listener(createSession('listener'))
        return unsubscribe
      }),
    })

    const auth = createClientAuth({ client, setSession, onReady, env: webEnv })
    const cleanup = auth.mount()
    await Promise.resolve()

    expect(setSession).toHaveBeenCalledWith(createSession('listener'))
    expect(handleRedirectCallback).toHaveBeenCalledOnce()
    expect(client.refreshSession).not.toHaveBeenCalled()
    expect(onReady).toHaveBeenCalledOnce()

    cleanup()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('waits for fallback refresh before calling onReady', async () => {
    const onReady = vi.fn()
    let resolveRefresh!: (session: GauSession) => void
    const client = createClient({
      refreshSession: vi.fn().mockImplementation(
        () =>
          new Promise<GauSession>((resolve) => {
            resolveRefresh = resolve
          }),
      ),
    })

    const auth = createClientAuth({ client, setSession: vi.fn(), onReady, env: webEnv })
    auth.mount()
    await Promise.resolve()

    expect(client.refreshSession).toHaveBeenCalledOnce()
    expect(onReady).not.toHaveBeenCalled()

    resolveRefresh(createSession('refresh'))
    await Promise.resolve()
    await Promise.resolve()

    expect(onReady).toHaveBeenCalledOnce()
  })

  it('skips the mount refresh when an external hydration session is present', async () => {
    const onReady = vi.fn()
    const client = createClient()
    const auth = createClientAuth({
      client,
      refreshOnMount: false,
      setSession: vi.fn(),
      onReady,
      env: webEnv,
    })

    auth.mount()
    await Promise.resolve()
    await Promise.resolve()

    expect(client.handleRedirectCallback).toHaveBeenCalledOnce()
    expect(client.refreshSession).not.toHaveBeenCalled()
    expect(onReady).toHaveBeenCalledOnce()
  })

  it('loads the native token session even when server hydration supplied a session', async () => {
    const client = createClient()
    const setSession = vi.fn()
    const auth = createClientAuth({
      client,
      setSession,
      refreshOnMount: false,
      env: { ...webEnv, isTauri: () => true },
    })
    const dispose = auth.mount()
    await Promise.resolve()
    await Promise.resolve()
    expect(client.refreshSession).toHaveBeenCalledOnce()
    expect(setSession).toHaveBeenCalledWith(createSession('refresh'))
    dispose()
  })

  it('recovers an expired hydrated Tauri session and clears the previous error in one request', async () => {
    // Solid 2 delegates its external-session and Tauri mount path to this controller.
    const baseUrl = 'https://auth.test/api/auth'
    const expiredToken = 'expired-token'
    const hydrated = { ...createSession('hydrated'), providers: ['github'] }
    const guest = { user: null, session: null, accounts: null, providers: ['github'] }
    let sessionToken: string | null = expiredToken
    vi.spyOn(token, 'getSessionToken').mockImplementation(() => sessionToken)
    vi.spyOn(token, 'clearSessionToken').mockImplementation(() => {
      sessionToken = null
    })
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('unavailable', { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)

    const client = createAuthClient({ baseUrl, session: hydrated, credentials: 'omit' })
    const previousError = await client.refreshSession().catch((error: unknown) => error)
    expect(client.sessionError).toBe(previousError)
    expect(client.session).toEqual(hydrated)

    const notified = vi.fn()
    const setSession = vi.fn()
    const onSessionError = vi.fn()
    const onReady = vi.fn()
    client.onSessionChange(notified)
    fetchMock.mockClear()
    fetchMock.mockResolvedValueOnce(Response.json(guest, { status: 401 }))

    const auth = createClientAuth({
      client,
      refreshOnMount: false,
      setSession,
      onSessionError,
      onReady,
      env: { ...webEnv, isTauri: () => true },
    })
    const dispose = auth.mount()
    await vi.waitFor(() => {
      expect(setSession).toHaveBeenCalledWith(guest)
      expect(onReady).toHaveBeenCalledOnce()
    })

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledWith(`${baseUrl}/session`, {
      credentials: 'omit',
      headers: { Authorization: `Bearer ${expiredToken}` },
    })
    expect(sessionToken).toBeNull()
    expect(client.session).toEqual(guest)
    expect(client.sessionLoaded).toBe(true)
    expect(client.sessionError).toBeNull()
    expect(notified).toHaveBeenCalledOnce()
    expect(notified).toHaveBeenCalledWith(guest)
    expect(onSessionError).toHaveBeenNthCalledWith(1, previousError)
    expect(onSessionError).toHaveBeenLastCalledWith(null)
    expect(onReady).toHaveBeenCalledOnce()
    dispose()
  })

  it('does not apply late mount refreshes after disposal', async () => {
    let resolveRefresh!: (session: GauSession) => void
    const setSession = vi.fn()
    const onReady = vi.fn()
    const client = createClient({
      refreshSession: vi.fn().mockImplementation(
        () =>
          new Promise<GauSession>((resolve) => {
            resolveRefresh = resolve
          }),
      ),
    })
    const auth = createClientAuth({ client, setSession, onReady, env: webEnv })

    const cleanup = auth.mount()
    await Promise.resolve()
    cleanup()
    resolveRefresh(createSession('late'))
    await Promise.resolve()
    await Promise.resolve()

    expect(setSession).not.toHaveBeenCalled()
    expect(onReady).not.toHaveBeenCalled()
  })

  it('logs detached initialization failures without an unhandled rejection', async () => {
    const error = new Error('redirect failed')
    const logger = { error: vi.fn() }
    const client = createClient({
      handleRedirectCallback: vi.fn().mockRejectedValue(error),
    })
    const auth = createClientAuth({ client, setSession: vi.fn(), logger, env: webEnv })

    auth.mount()
    await Promise.resolve()
    await Promise.resolve()

    expect(logger.error).toHaveBeenCalledWith('Failed to initialize auth client', error)
  })

  it('cleans up a late Tauri bridge subscription after disposal', async () => {
    const unlisten = vi.fn()
    let resolveBridge!: (cleanup: () => void) => void
    const client = createClient({
      handleRedirectCallback: vi.fn().mockResolvedValue(true),
      startTauriBridge: vi.fn().mockImplementation(
        () =>
          new Promise<() => void>((resolve) => {
            resolveBridge = resolve
          }),
      ),
    })

    const auth = createClientAuth({
      client,
      setSession: vi.fn(),
      env: { ...webEnv, isTauri: () => true },
    })

    const cleanup = auth.mount()
    cleanup()
    resolveBridge(unlisten)
    await Promise.resolve()

    expect(unlisten).toHaveBeenCalledOnce()
    expect(client.refreshSession).not.toHaveBeenCalled()
  })

  it('logs detached Tauri bridge failures', async () => {
    const error = new Error('bridge failed')
    const logger = { error: vi.fn() }
    const client = createClient({
      handleRedirectCallback: vi.fn().mockResolvedValue(true),
      startTauriBridge: vi.fn().mockRejectedValue(error),
    })
    const auth = createClientAuth({
      client,
      setSession: vi.fn(),
      logger,
      env: { ...webEnv, isTauri: () => true },
    })

    auth.mount()
    await Promise.resolve()
    await Promise.resolve()

    expect(logger.error).toHaveBeenCalledWith('Failed to start Tauri auth bridge', error)
  })

  it('logs unlink failures but not successful unlinks', async () => {
    const logger = { error: vi.fn() }
    const client = createClient({
      unlinkAccount: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
    })

    const auth = createClientAuth({ client, setSession: vi.fn(), logger, env: webEnv })

    await auth.controls.unlinkAccount('github')
    await auth.controls.unlinkAccount('google')

    expect(client.unlinkAccount).toHaveBeenNthCalledWith(1, 'github')
    expect(client.unlinkAccount).toHaveBeenNthCalledWith(2, 'google')
    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith('Failed to unlink account')
  })
})
