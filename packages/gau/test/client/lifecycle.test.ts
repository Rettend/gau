import type { GauSession } from '../../src/core'
import { describe, expect, it, vi } from 'vitest'
import { createSharedClientLifecycle } from '../../src/client/shared/lifecycle'

function createSession(id: string): GauSession {
  return { user: { id }, session: { sub: id }, accounts: [], providers: [] }
}

describe('shared client lifecycle', () => {
  it('handles a web redirect callback without fallback refresh', async () => {
    const unsubscribe = vi.fn()
    const refresh = vi.fn()
    const onReady = vi.fn()
    const onSession = vi.fn()
    const handleRedirectCallback = vi.fn().mockResolvedValue(true)
    const startTauriBridge = vi.fn()
    const onSessionChange = vi.fn((listener: (session: GauSession) => void) => {
      listener(createSession('listener'))
      return unsubscribe
    })

    const lifecycle = createSharedClientLifecycle({
      client: {
        onSessionChange,
        startTauriBridge,
        unlinkAccount: vi.fn(),
      },
      authFlow: { handleRedirectCallback },
      isBrowser: true,
      isTauri: false,
      refresh,
      onSession,
      onReady,
    })

    const cleanup = lifecycle.mount()
    await Promise.resolve()

    expect(onSessionChange).toHaveBeenCalledOnce()
    expect(onSession).toHaveBeenCalledWith(createSession('listener'))
    expect(handleRedirectCallback).toHaveBeenCalledOnce()
    expect(refresh).not.toHaveBeenCalled()
    expect(onReady).toHaveBeenCalledOnce()
    expect(startTauriBridge).not.toHaveBeenCalled()

    cleanup()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('falls back to refresh and starts the Tauri bridge on startup', async () => {
    const unlisten = vi.fn()
    const refresh = vi.fn().mockResolvedValue(undefined)
    const startTauriBridge = vi.fn().mockResolvedValue(unlisten)

    const lifecycle = createSharedClientLifecycle({
      client: {
        onSessionChange: vi.fn(() => vi.fn()),
        startTauriBridge,
        unlinkAccount: vi.fn(),
      },
      authFlow: { handleRedirectCallback: vi.fn().mockResolvedValue(false) },
      isBrowser: true,
      isTauri: true,
      refresh,
      onSession: vi.fn(),
    })

    const cleanup = lifecycle.mount()
    await Promise.resolve()
    await Promise.resolve()

    expect(refresh).toHaveBeenCalledOnce()
    expect(startTauriBridge).toHaveBeenCalledOnce()

    cleanup()
    expect(unlisten).toHaveBeenCalledOnce()
  })

  it('waits for fallback refresh before calling onReady', async () => {
    const onReady = vi.fn()
    let resolveRefresh!: () => void
    const refresh = vi.fn().mockImplementation(() => new Promise<void>((resolve) => {
      resolveRefresh = resolve
    }))

    const lifecycle = createSharedClientLifecycle({
      client: {
        onSessionChange: vi.fn(() => vi.fn()),
        startTauriBridge: vi.fn(),
        unlinkAccount: vi.fn(),
      },
      authFlow: { handleRedirectCallback: vi.fn().mockResolvedValue(false) },
      isBrowser: true,
      isTauri: false,
      refresh,
      onSession: vi.fn(),
      onReady,
    })

    lifecycle.mount()
    await Promise.resolve()

    expect(refresh).toHaveBeenCalledOnce()
    expect(onReady).not.toHaveBeenCalled()

    resolveRefresh()
    await Promise.resolve()

    expect(onReady).toHaveBeenCalledOnce()
  })

  it('cleans up a late Tauri bridge subscription after disposal', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined)
    const unlisten = vi.fn()
    let resolveBridge!: (cleanup: () => void) => void
    const startTauriBridge = vi.fn().mockImplementation(() => new Promise<() => void>((resolve) => {
      resolveBridge = resolve
    }))
    const unsubscribe = vi.fn()

    const lifecycle = createSharedClientLifecycle({
      client: {
        onSessionChange: vi.fn(() => unsubscribe),
        startTauriBridge,
        unlinkAccount: vi.fn(),
      },
      authFlow: { handleRedirectCallback: vi.fn().mockResolvedValue(true) },
      isBrowser: true,
      isTauri: true,
      refresh,
      onSession: vi.fn(),
    })

    const cleanup = lifecycle.mount()
    cleanup()
    resolveBridge(unlisten)
    await Promise.resolve()

    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(unlisten).toHaveBeenCalledOnce()
    expect(refresh).not.toHaveBeenCalled()
  })

  it('logs unlink failures but not successful unlinks', async () => {
    const logger = { error: vi.fn() }
    const unlinkAccount = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)

    const lifecycle = createSharedClientLifecycle({
      client: {
        onSessionChange: vi.fn(() => vi.fn()),
        startTauriBridge: vi.fn(),
        unlinkAccount,
      },
      authFlow: { handleRedirectCallback: vi.fn() },
      isBrowser: true,
      isTauri: false,
      refresh: vi.fn(),
      onSession: vi.fn(),
      logger,
    })

    await lifecycle.unlinkAccount('github')
    await lifecycle.unlinkAccount('google')

    expect(unlinkAccount).toHaveBeenNthCalledWith(1, 'github')
    expect(unlinkAccount).toHaveBeenNthCalledWith(2, 'google')
    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith('Failed to unlink account')
  })
})
