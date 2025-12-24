import type { RequestEvent } from '@sveltejs/kit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NULL_SESSION, REFRESHED_TOKEN_HEADER, SESSION_COOKIE_NAME } from '../../src/core'
import { createRefreshHandle, SvelteKitAuth } from '../../src/sveltekit/index'

const mockAuth = {
  providerMap: new Map(),
  signJWT: vi.fn(),
  validateSession: vi.fn(),
} as any

vi.mock('../../src/core', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/core')>()
  return {
    ...mod,
    createAuth: vi.fn(() => mockAuth),
    createHandler: vi.fn(() => (request: Request) => {
      return new Response(`Handled by core for ${request.method}`)
    }),
  }
})

describe('svelteKitAuth', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('should return GET, POST, and OPTIONS handlers', () => {
    const { GET, POST, OPTIONS } = SvelteKitAuth({ providers: [] } as any)
    expect(GET).toBeInstanceOf(Function)
    expect(POST).toBeInstanceOf(Function)
    expect(OPTIONS).toBeInstanceOf(Function)
  })

  it('should accept an auth instance', () => {
    const authInstance = { providerMap: new Map(), signJWT: vi.fn() } as any
    const { GET } = SvelteKitAuth(authInstance)
    expect(GET).toBeInstanceOf(Function)
  })

  it('handlers should call the core handler', async () => {
    const { GET, POST, OPTIONS } = SvelteKitAuth({ providers: [] } as any)
    const request = new Request('http://localhost/api/auth/github')
    const getResponse = await GET({ request } as RequestEvent)
    expect(await getResponse.text()).toBe('Handled by core for GET')

    const postResponse = await POST({ request: new Request('http://localhost/api/auth/github', { method: 'POST' }) } as RequestEvent)
    expect(await postResponse.text()).toBe('Handled by core for POST')

    const optionsResponse = await OPTIONS({ request: new Request('http://localhost/api/auth/github', { method: 'OPTIONS' }) } as RequestEvent)
    expect(await optionsResponse.text()).toBe('Handled by core for OPTIONS')
  })

  describe('handle hook', () => {
    const { handle } = SvelteKitAuth({ providers: [] } as any)

    it('should add getSession to event.locals', async () => {
      const event = { locals: {} } as RequestEvent
      const resolve = vi.fn()
      await handle({ event, resolve })
      expect(event.locals).toHaveProperty('getSession')
      expect(typeof (event.locals as any).getSession).toBe('function')
    })

    it('getSession should return null if no session token is found', async () => {
      const event = {
        locals: {},
        request: new Request('http://localhost', { headers: new Headers() }),
      } as RequestEvent
      const resolve = vi.fn()
      await handle({ event, resolve })
      const session = await (event.locals as any).getSession()
      expect(session).toEqual({ ...NULL_SESSION, providers: [] })
    })

    it('getSession should validate session from cookie', async () => {
      const event = {
        locals: {},
        request: new Request('http://localhost', {
          headers: { Cookie: `${SESSION_COOKIE_NAME}=test-token` },
        }),
      } as RequestEvent
      const resolve = vi.fn()
      mockAuth.validateSession.mockResolvedValueOnce({ user: { id: '1' }, session: { sub: '1' }, accounts: [] })

      await handle({ event, resolve })
      const session = await (event.locals as any).getSession()

      expect(mockAuth.validateSession).toHaveBeenCalledWith('test-token')
      expect(session).toEqual({ user: { id: '1' }, session: { sub: '1' }, accounts: [], providers: [] })
    })

    it('getSession should validate session from Authorization header', async () => {
      const event = {
        locals: {},
        request: new Request('http://localhost', {
          headers: { Authorization: 'Bearer test-token-header' },
        }),
      } as RequestEvent
      const resolve = vi.fn()
      mockAuth.validateSession.mockResolvedValueOnce({ user: { id: '2' }, session: { sub: '2' }, accounts: [] })

      await handle({ event, resolve })
      const session = await (event.locals as any).getSession()

      expect(mockAuth.validateSession).toHaveBeenCalledWith('test-token-header')
      expect(session).toEqual({ user: { id: '2' }, session: { sub: '2' }, accounts: [], providers: [] })
    })

    it('getSession should return null if validation fails', async () => {
      const event = {
        locals: {},
        request: new Request('http://localhost', {
          headers: { Authorization: 'Bearer bad-token' },
        }),
      } as RequestEvent
      const resolve = vi.fn()
      mockAuth.validateSession.mockRejectedValueOnce(new Error('Invalid token'))

      await handle({ event, resolve })
      const session = await (event.locals as any).getSession()

      expect(mockAuth.validateSession).toHaveBeenCalledWith('bad-token')
      expect(session).toEqual({ ...NULL_SESSION, providers: [] })
    })

    it('should call resolve with the event', async () => {
      const event = { locals: {} } as RequestEvent
      const resolve = vi.fn(() => new Response('resolved'))
      const response = await handle({ event, resolve })
      expect(resolve).toHaveBeenCalledWith(event)
      expect(await response.text()).toBe('resolved')
    })
  })
})

describe('createRefreshHandle', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('sets Set-Cookie when refreshed source is cookie', async () => {
    const authInstance = {
      providerMap: new Map(),
      signJWT: vi.fn(),
      refreshSession: vi.fn().mockResolvedValue({
        token: 'new-token',
        cookie: 'cookie-value',
        cookieName: SESSION_COOKIE_NAME,
        maxAge: 123,
        source: 'cookie',
      }),
    } as any

    const handle = createRefreshHandle(authInstance, { threshold: 0.5 })
    const event = { request: new Request('http://localhost/'), locals: {} } as any
    const resolve = vi.fn(async () => new Response('ok'))

    const response = await handle({ event, resolve } as any)
    expect(response.headers.get('Set-Cookie')).toBe('cookie-value')
    expect(response.headers.get(REFRESHED_TOKEN_HEADER)).toBeNull()
  })

  it('sets X-Refreshed-Token when refreshed source is bearer', async () => {
    const authInstance = {
      providerMap: new Map(),
      signJWT: vi.fn(),
      refreshSession: vi.fn().mockResolvedValue({
        token: 'new-token',
        cookie: 'cookie-value',
        cookieName: SESSION_COOKIE_NAME,
        maxAge: 123,
        source: 'bearer',
      }),
    } as any

    const handle = createRefreshHandle(authInstance)
    const event = { request: new Request('http://localhost/'), locals: {} } as any
    const resolve = vi.fn(async () => new Response('ok'))

    const response = await handle({ event, resolve } as any)
    expect(response.headers.get(REFRESHED_TOKEN_HEADER)).toBe('new-token')
    expect(response.headers.get('Set-Cookie')).toBeNull()
  })
})
