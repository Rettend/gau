import type { ServerFunctionsClientConfig } from '@solidjs/web/server-functions/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureServerFunctions } from '../../src/client/solid2/serverFunctions'
import { REFRESHED_TOKEN_HEADER, SESSION_TOKEN_KEY } from '../../src/client/token'
import { serverFunctionsMiddleware } from '../../src/solid2'

const mocks = vi.hoisted(() => ({
  config: undefined as ServerFunctionsClientConfig | undefined,
  configure: vi.fn((config: ServerFunctionsClientConfig) => {
    mocks.config = config
  }),
}))

vi.mock('esm-env', () => ({ BROWSER: true, DEV: false }))
vi.mock('@solidjs/web', () => ({
  getRequestEvent: () => undefined,
}))
vi.mock('@solidjs/web/server-functions/client', () => ({
  configureServerFunctionsClient: mocks.configure,
}))

const storage = (() => {
  let values: Record<string, string> = {}
  return {
    getItem: (key: string) => values[key] ?? null,
    setItem: (key: string, value: string) => { values[key] = value },
    removeItem: (key: string) => { delete values[key] },
    clear: () => { values = {} },
  }
})()

function createMockAuth() {
  return {
    providerMap: new Map([['github', {}]]),
    signJWT: vi.fn(),
    basePath: '/api/auth',
    trustHosts: ['tauri.localhost'],
    cors: {
      allowedOrigins: 'trust',
      allowCredentials: true,
      allowedHeaders: ['Content-Type', 'Authorization', 'Cookie'],
      allowedMethods: ['GET', 'POST', 'OPTIONS'],
      exposeHeaders: undefined,
      maxAge: 600,
    },
  } as any
}

function headerValues(headers: Headers, name: string): string[] {
  return (headers.get(name) ?? '').split(',').map(value => value.trim()).filter(Boolean)
}

describe('Solid 2 cross-origin server functions', () => {
  beforeEach(() => {
    storage.clear()
    mocks.config = undefined
    mocks.configure.mockClear()
    vi.stubGlobal('localStorage', storage)
    vi.stubGlobal('window', {
      location: { href: 'http://tauri.localhost/' },
      fetch: globalThis.fetch,
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('configures Solid with Gau bearer and refresh handling', async () => {
    storage.setItem(SESSION_TOKEN_KEY, 'session-token')
    const prepareRequest = vi.fn((init: RequestInit) => {
      const headers = new Headers(init.headers)
      headers.set('X-Trace-Id', 'trace-id')
      return { ...init, headers }
    })
    const fetch = vi.fn(async () => new Response(null, {
      headers: { [REFRESHED_TOKEN_HEADER]: 'refreshed-token' },
    }))
    vi.stubGlobal('fetch', fetch)
    window.fetch = fetch

    configureServerFunctions({ endpoint: 'https://api.example.com/_server', prepareRequest })

    expect(mocks.configure).toHaveBeenCalledOnce()
    expect(mocks.config?.endpoint).toBe('https://api.example.com/_server')

    const prepared = await mocks.config!.prepareRequest!({
      method: 'POST',
      headers: { 'X-Server-Function-Id': 'server-function' },
    }, {
      id: 'server-function',
      meta: undefined,
    })
    expect(new Headers(prepared.headers).get('Authorization')).toBe('Bearer session-token')
    expect(new Headers(prepared.headers).get('X-Trace-Id')).toBe('trace-id')
    expect(prepareRequest).toHaveBeenCalledOnce()

    const existing = await mocks.config!.prepareRequest!({
      headers: { Authorization: 'Bearer explicit-token' },
    }, {
      id: 'server-function',
      meta: undefined,
    })
    expect(new Headers(existing.headers).get('Authorization')).toBe('Bearer explicit-token')

    expect(mocks.config?.responseHandler).toBeUndefined()
    await globalThis.fetch('http://tauri.localhost/explicit-action', prepared)
    expect(storage.getItem(SESSION_TOKEN_KEY)).toBe('refreshed-token')
  })

  it('answers trusted preflights with Solid and Gau headers', async () => {
    const middleware = serverFunctionsMiddleware(createMockAuth())
    const next = vi.fn()
    const response = await middleware(new Request('https://api.example.com/_server', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://tauri.localhost',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization, x-server-function-id',
      },
    }), next)

    expect(next).not.toHaveBeenCalled()
    expect(response.status).toBe(204)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://tauri.localhost')
    expect(headerValues(response.headers, 'Access-Control-Allow-Headers')).toEqual(expect.arrayContaining([
      'Authorization',
      'X-Server-Function-Id',
      'X-Server-Function-Instance',
      'X-Server-Function-Format',
      'X-Single-Flight',
    ]))
  })

  it('rejects untrusted preflights', async () => {
    const middleware = serverFunctionsMiddleware(createMockAuth())
    const next = vi.fn()
    const response = await middleware(new Request('https://api.example.com/_server', {
      method: 'OPTIONS',
      headers: { Origin: 'https://hostile.example.com' },
    }), next)

    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
    expect(next).not.toHaveBeenCalled()
  })

  it('does not run server functions for untrusted origins', async () => {
    const next = vi.fn()
    const response = await serverFunctionsMiddleware(createMockAuth())(new Request('https://api.example.com/_server?id=server-function', {
      method: 'POST',
      headers: { Origin: 'https://hostile.example.com' },
    }), next)

    expect(response.status).toBe(403)
    expect(next).not.toHaveBeenCalled()
  })

  it('rejects unrestricted credentialed CORS', () => {
    const auth = createMockAuth()
    auth.cors.allowedOrigins = 'all'

    expect(() => serverFunctionsMiddleware(auth)).toThrow('requires restricted CORS origins')
  })

  it('rejects unrestricted CORS without credentials', () => {
    const auth = createMockAuth()
    auth.cors.allowedOrigins = 'all'
    auth.cors.allowCredentials = false

    expect(() => serverFunctionsMiddleware(auth)).toThrow('requires restricted CORS origins')
  })

  it('carries a token and refresh response through the cross-origin middleware', async () => {
    storage.setItem(SESSION_TOKEN_KEY, 'session-token')
    const middleware = serverFunctionsMiddleware(createMockAuth())
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init)
      return await middleware(request, () => {
        expect(request.headers.get('Authorization')).toBe('Bearer session-token')
        return new Response('[]', {
          headers: {
            Vary: 'Accept-Encoding',
            [REFRESHED_TOKEN_HEADER]: 'refreshed-token',
            'X-Frame-Stream': 'frame',
            'X-Server-Function-Format': '8',
          },
        })
      })
    })
    vi.stubGlobal('fetch', fetch)
    window.fetch = fetch
    configureServerFunctions({ endpoint: 'https://api.example.com/_server' })

    const prepared = await mocks.config!.prepareRequest!({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Server-Function-Id': 'server-function',
        'X-Server-Function-Instance': 'server-function:0',
        'X-Server-Function-Format': '8',
      },
    }, {
      id: 'server-function',
      meta: undefined,
    })
    const headers = new Headers(prepared.headers)
    headers.set('Origin', 'http://tauri.localhost')
    const request = new Request('https://api.example.com/_server', {
      ...prepared,
      headers,
      body: '[]',
    })

    const response = await globalThis.fetch(request)

    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://tauri.localhost')
    expect(response.headers.get('Vary')).toBe('Accept-Encoding, Origin')
    expect(headerValues(response.headers, 'Access-Control-Expose-Headers')).toEqual(expect.arrayContaining([
      'Location',
      'X-Frame-Stream',
      'X-Revalidate',
      'X-Server-Function-Error',
      'X-Server-Function-Format',
      'X-Single-Flight',
      REFRESHED_TOKEN_HEADER,
    ]))
    expect(storage.getItem(SESSION_TOKEN_KEY)).toBe('refreshed-token')
  })
})
