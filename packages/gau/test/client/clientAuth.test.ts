import type { GauSession } from '../../src/core'
import { describe, expect, it, vi } from 'vitest'
import { createClientAuth } from '../../src/client/shared/clientAuth'

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
    expect(client.linkAccount).toHaveBeenCalledWith('github', { redirectTo: 'https://app.test/current', profile: undefined })
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

    expect(client.linkAccount).toHaveBeenCalledWith('github', { redirectTo: 'https://default.test/redirect', profile: 'work' })
    expect(navigate).not.toHaveBeenCalled()
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
      refreshSession: vi.fn().mockImplementation(() => new Promise<GauSession>((resolve) => {
        resolveRefresh = resolve
      })),
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

  it('cleans up a late Tauri bridge subscription after disposal', async () => {
    const unlisten = vi.fn()
    let resolveBridge!: (cleanup: () => void) => void
    const client = createClient({
      handleRedirectCallback: vi.fn().mockResolvedValue(true),
      startTauriBridge: vi.fn().mockImplementation(() => new Promise<() => void>((resolve) => {
        resolveBridge = resolve
      })),
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

  it('logs unlink failures but not successful unlinks', async () => {
    const logger = { error: vi.fn() }
    const client = createClient({
      unlinkAccount: vi.fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false),
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
