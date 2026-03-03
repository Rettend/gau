import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installSolidStartFetchBridge } from '../../src/client/solid/solidStartFetchBridge'
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

  it('injects Authorization for same-origin /_server requests', async () => {
    localStorageMock.setItem(SESSION_TOKEN_KEY, 'token-abc')

    installSolidStartFetchBridge()
    await globalThis.fetch('http://localhost:3000/_server?id=1', { method: 'POST' })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit
    const headers = new Headers(init.headers)
    expect(headers.get('Authorization')).toBe('Bearer token-abc')
  })

  it('injects Authorization for absolute remote SERVER_BASE_URL /_server requests', async () => {
    localStorageMock.setItem(SESSION_TOKEN_KEY, 'token-remote')

    installSolidStartFetchBridge({ serverBaseUrl: 'https://api.example.com' })
    await globalThis.fetch('https://api.example.com/_server?id=remote', { method: 'POST' })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit
    const headers = new Headers(init.headers)
    expect(headers.get('Authorization')).toBe('Bearer token-remote')
  })

  it('does not inject Authorization outside /_server', async () => {
    localStorageMock.setItem(SESSION_TOKEN_KEY, 'token-abc')

    installSolidStartFetchBridge()
    await globalThis.fetch('http://localhost:3000/api/data', {
      headers: { 'X-Test': 'ok' },
    })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit
    const headers = new Headers(init.headers)
    expect(headers.get('Authorization')).toBeNull()
    expect(headers.get('X-Test')).toBe('ok')
  })

  it('respects an existing Authorization header', async () => {
    installSolidStartFetchBridge()
    await globalThis.fetch('http://localhost:3000/_server?id=2', {
      method: 'POST',
      headers: { Authorization: 'Bearer existing' },
    })

    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit
    const headers = new Headers(init.headers)
    expect(headers.get('Authorization')).toBe('Bearer existing')
  })

  it('stores refreshed token from response header', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('ok', {
      headers: { [REFRESHED_TOKEN_HEADER]: 'new-token' },
    }))

    installSolidStartFetchBridge()
    await globalThis.fetch('http://localhost:3000/_server?id=3', { method: 'POST' })

    expect(localStorageMock.getItem(SESSION_TOKEN_KEY)).toBe('new-token')
  })

  it('installs only once', () => {
    installSolidStartFetchBridge()
    const first = globalThis.fetch

    installSolidStartFetchBridge()
    const second = globalThis.fetch

    expect(second).toBe(first)
  })
})
