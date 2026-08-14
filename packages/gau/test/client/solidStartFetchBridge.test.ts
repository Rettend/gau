import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installSolidStartFetchBridge } from '../../src/client/shared/solidStartFetchBridge'
import { REFRESHED_TOKEN_HEADER, SESSION_TOKEN_KEY } from '../../src/client/token'

vi.mock('esm-env', () => ({ BROWSER: true }))

const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => { store[key] = value.toString() },
    removeItem: (key: string) => { delete store[key] },
    clear: () => { store = {} },
  }
})()

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  configurable: true,
})

describe('solidStart fetch bridge', () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    localStorageMock.clear()

    fetchSpy = vi.fn().mockResolvedValue(new Response('ok'))
    vi.stubGlobal('fetch', fetchSpy)
    vi.stubGlobal('window', {
      location: {
        origin: 'http://localhost:3000',
        href: 'http://localhost:3000/',
      },
      fetch: globalThis.fetch,
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function forwardedRequest(): Request {
    const input = fetchSpy.mock.calls[0]?.[0]
    expect(input).toBeInstanceOf(Request)
    return input as Request
  }

  it('injects Authorization for same-origin /_server requests', async () => {
    localStorageMock.setItem(SESSION_TOKEN_KEY, 'token-abc')

    installSolidStartFetchBridge()
    await globalThis.fetch('http://localhost:3000/_server?id=1', { method: 'POST' })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const request = forwardedRequest()
    expect(request.url).toBe('http://localhost:3000/_server?id=1')
    expect(request.headers.get('Authorization')).toBe('Bearer token-abc')
  })

  it('rewrites local server functions to a remote backend', async () => {
    localStorageMock.setItem(SESSION_TOKEN_KEY, 'token-remote')

    installSolidStartFetchBridge({ serverBaseUrl: 'https://api.example.com/functions' })
    await globalThis.fetch('/_server?id=remote', { method: 'POST' })

    const request = forwardedRequest()
    expect(request.url).toBe('https://api.example.com/functions/_server?id=remote')
    expect(request.headers.get('Authorization')).toBe('Bearer token-remote')
  })

  it('supports local application base paths', async () => {
    installSolidStartFetchBridge({
      applicationBaseUrl: '/app/',
      serverBaseUrl: 'https://api.example.com/backend/',
    })
    await globalThis.fetch('http://localhost:3000/app/_server?id=base')

    expect(forwardedRequest().url).toBe('https://api.example.com/backend/_server?id=base')
  })

  it('authenticates direct remote requests without rewriting them', async () => {
    localStorageMock.setItem(SESSION_TOKEN_KEY, 'token-direct')

    installSolidStartFetchBridge({ serverBaseUrl: 'https://api.example.com/backend' })
    await globalThis.fetch(new URL('https://api.example.com/backend/_server?id=direct'))

    const request = forwardedRequest()
    expect(request.url).toBe('https://api.example.com/backend/_server?id=direct')
    expect(request.headers.get('Authorization')).toBe('Bearer token-direct')
  })

  it('preserves Request and RequestInit semantics when rewriting', async () => {
    const controller = new AbortController()
    const input = new Request('http://localhost:3000/_server?id=request', {
      method: 'POST',
      body: 'original',
      credentials: 'include',
      headers: {
        Authorization: 'Bearer original',
        'X-Input': 'replaced',
      },
      signal: controller.signal,
    })

    installSolidStartFetchBridge({ serverBaseUrl: 'https://api.example.com/backend' })
    await globalThis.fetch(input, {
      body: 'override',
      headers: {
        Authorization: 'Bearer override',
        'X-Init': 'kept',
      },
    })

    const request = forwardedRequest()
    expect(request.url).toBe('https://api.example.com/backend/_server?id=request')
    expect(request.method).toBe('POST')
    expect(request.credentials).toBe('include')
    expect(request.headers.get('Authorization')).toBe('Bearer override')
    expect(request.headers.get('X-Input')).toBeNull()
    expect(request.headers.get('X-Init')).toBe('kept')
    expect(await request.text()).toBe('override')

    controller.abort()
    expect(request.signal.aborted).toBe(true)
  })

  it('does not modify unrelated origins or near-matching paths', async () => {
    localStorageMock.setItem(SESSION_TOKEN_KEY, 'secret')
    installSolidStartFetchBridge({ serverBaseUrl: 'https://api.example.com/backend' })

    await globalThis.fetch('https://attacker.example/_server')
    await globalThis.fetch('http://localhost:3000/_server/extra')
    await globalThis.fetch('https://api.example.com/backend/_server-evil')

    expect(fetchSpy).toHaveBeenCalledTimes(3)
    for (const call of fetchSpy.mock.calls)
      expect(call[0]).not.toBeInstanceOf(Request)
  })

  it('respects an existing Authorization header', async () => {
    installSolidStartFetchBridge()
    await globalThis.fetch('http://localhost:3000/_server?id=2', {
      method: 'POST',
      headers: { Authorization: 'Bearer existing' },
    })

    expect(forwardedRequest().headers.get('Authorization')).toBe('Bearer existing')
  })

  it('stores refreshed token from response header', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('ok', {
      headers: { [REFRESHED_TOKEN_HEADER]: 'new-token' },
    }))

    installSolidStartFetchBridge()
    await globalThis.fetch('http://localhost:3000/_server?id=3', { method: 'POST' })

    expect(localStorageMock.getItem(SESSION_TOKEN_KEY)).toBe('new-token')
  })

  it('keeps repeated identical installations flat', () => {
    installSolidStartFetchBridge({ serverBaseUrl: 'https://api.example.com/backend' })
    const first = globalThis.fetch

    installSolidStartFetchBridge({ serverBaseUrl: 'https://api.example.com/backend/' })

    expect(globalThis.fetch).toBe(first)
  })

  it('upgrades an unconfigured installation with an explicit server base URL', async () => {
    installSolidStartFetchBridge()
    const first = globalThis.fetch
    installSolidStartFetchBridge({ serverBaseUrl: 'https://api.example.com/backend' })

    await globalThis.fetch('/_server?id=upgrade')

    expect(globalThis.fetch).toBe(first)
    expect(forwardedRequest().url).toBe('https://api.example.com/backend/_server?id=upgrade')
  })

  it('rejects conflicting server-function destinations', () => {
    installSolidStartFetchBridge({ serverBaseUrl: 'https://api.example.com/backend' })

    expect(() => installSolidStartFetchBridge({
      serverBaseUrl: 'https://other.example.com/functions',
    })).toThrow('different server base URL')
  })

  it('supports relative server base URLs with path prefixes', async () => {
    installSolidStartFetchBridge({ serverBaseUrl: '/backend' })
    await globalThis.fetch('/_server?id=relative')

    expect(forwardedRequest().url).toBe('http://localhost:3000/backend/_server?id=relative')
  })

  it('keeps the legacy Vite SERVER_BASE_URL fallback independent from AuthProvider.baseUrl', async () => {
    const bridgeSource = await readFile(new URL('../../src/client/shared/solidStartFetchBridge.ts', import.meta.url), 'utf8')
    const providerSource = await readFile(new URL('../../src/client/solid/index.tsx', import.meta.url), 'utf8')

    expect(bridgeSource).toContain('.env.SERVER_BASE_URL')
    expect(providerSource).toContain('installSolidStartFetchBridge()')
    expect(providerSource).not.toContain('installSolidStartFetchBridge({ baseUrl })')
  })
})
