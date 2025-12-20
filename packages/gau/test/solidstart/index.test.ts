import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NULL_SESSION, SESSION_COOKIE_NAME } from '../../src/core'
import { authMiddleware, createSolidStartGetSession, SolidAuth } from '../../src/solidstart/index'

const mockAuth = {
  providerMap: new Map(),
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

let mockRequestEvent: { request: Request } | undefined
vi.mock('solid-js/web', () => ({
  getRequestEvent: () => mockRequestEvent,
  isServer: true,
}))

describe('solidAuth', () => {
  beforeEach(() => {
    mockAuth.providerMap = new Map()
    mockAuth.validateSession.mockReset()
  })

  it('should return GET, POST, and OPTIONS handlers', () => {
    const { GET, POST, OPTIONS } = SolidAuth({ providers: [] } as any)
    expect(GET).toBeInstanceOf(Function)
    expect(POST).toBeInstanceOf(Function)
    expect(OPTIONS).toBeInstanceOf(Function)
  })

  it('handlers should call the core handler', async () => {
    const { GET, POST, OPTIONS } = SolidAuth({ providers: [] } as any)
    const request = new Request('http://localhost/api/auth/github')
    const getResponse = await GET({ request })
    expect(await getResponse.text()).toBe('Handled by core for GET')

    const postResponse = await POST({ request: new Request('http://localhost/api/auth/github', { method: 'POST' }) })
    expect(await postResponse.text()).toBe('Handled by core for POST')

    const optionsResponse = await OPTIONS({ request: new Request('http://localhost/api/auth/github', { method: 'OPTIONS' }) })
    expect(await optionsResponse.text()).toBe('Handled by core for OPTIONS')
  })

  it('should accept an auth instance', () => {
    const authInstance = { providerMap: new Map(), signJWT: vi.fn() } as any
    const { GET } = SolidAuth(authInstance)
    expect(GET).toBeInstanceOf(Function)
  })

  it('sets development based on NODE_ENV', () => {
    const original = process.env.NODE_ENV
    try {
      process.env.NODE_ENV = 'development'
      SolidAuth({ providers: [], adapter: {} as any } as any)
      expect(mockAuth.development).toBe(true)

      process.env.NODE_ENV = 'production'
      SolidAuth({ providers: [], adapter: {} as any } as any)
      expect(mockAuth.development).toBe(false)
    }
    finally {
      process.env.NODE_ENV = original
    }
  })
})

describe('createSolidStartGetSession', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('returns NULL_SESSION when no token present', async () => {
    const getSession = createSolidStartGetSession(mockAuth)
    const session = await getSession(new Request('http://localhost'))
    expect(session).toEqual({ ...NULL_SESSION, providers: [] })
  })

  it('validates session from cookie', async () => {
    mockAuth.validateSession.mockResolvedValueOnce({ user: { id: '1' }, session: { sub: '1' }, accounts: [] })
    const getSession = createSolidStartGetSession(mockAuth)
    const req = new Request('http://localhost', { headers: { Cookie: `${SESSION_COOKIE_NAME}=cookie-token` } })
    const session = await getSession(req)
    expect(mockAuth.validateSession).toHaveBeenCalledWith('cookie-token')
    expect(session).toEqual({ user: { id: '1' }, session: { sub: '1' }, accounts: [], providers: [] })
  })

  it('validates session from Authorization header', async () => {
    mockAuth.validateSession.mockResolvedValueOnce({ user: { id: '2' }, session: { sub: '2' }, accounts: [] })
    const getSession = createSolidStartGetSession(mockAuth)
    const req = new Request('http://localhost', { headers: { Authorization: 'Bearer header-token' } })
    const session = await getSession(req)
    expect(mockAuth.validateSession).toHaveBeenCalledWith('header-token')
    expect(session).toEqual({ user: { id: '2' }, session: { sub: '2' }, accounts: [], providers: [] })
  })

  it('returns NULL_SESSION when validation fails or returns null', async () => {
    mockAuth.validateSession.mockRejectedValueOnce(new Error('bad token'))
    const getSession = createSolidStartGetSession(mockAuth)
    const req = new Request('http://localhost', { headers: { Authorization: 'Bearer bad' } })
    const session = await getSession(req)
    expect(mockAuth.validateSession).toHaveBeenCalledWith('bad')
    expect(session).toEqual({ ...NULL_SESSION, providers: [] })

    mockAuth.validateSession.mockResolvedValueOnce(null)
    const session2 = await getSession(new Request('http://localhost', { headers: { Authorization: 'Bearer null-token' } }))
    expect(session2).toEqual({ ...NULL_SESSION, providers: [] })
  })
})

describe('authMiddleware', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('preloads when boolean true and caches result', async () => {
    mockAuth.validateSession.mockResolvedValueOnce({ user: { id: '1' }, session: { sub: '1' }, accounts: [] })
    const mw = authMiddleware(true, mockAuth)
    const event: any = { request: new Request('http://localhost/protected', { headers: { Authorization: 'Bearer token-1' } }), locals: {} }
    await mw(event)
    expect(typeof event.locals.getSession).toBe('function')
    const s1 = await event.locals.getSession()
    const s2 = await event.locals.getSession()
    expect(s1).toEqual({ user: { id: '1' }, session: { sub: '1' }, accounts: [], providers: [] })
    expect(s2).toEqual(s1)
    expect(mockAuth.validateSession).toHaveBeenCalledTimes(1)
  })

  it('preloads when path is included in array', async () => {
    mockAuth.validateSession.mockResolvedValueOnce({ user: { id: '2' }, session: { sub: '2' }, accounts: [] })
    const mw = authMiddleware(['/protected', '/dashboard'], mockAuth)
    const event: any = { request: new Request('http://localhost/protected', { headers: { Authorization: 'Bearer token-2' } }), locals: {} }
    await mw(event)
    const session = await event.locals.getSession()
    expect(session).toEqual({ user: { id: '2' }, session: { sub: '2' }, accounts: [], providers: [] })
    expect(mockAuth.validateSession).toHaveBeenCalledTimes(1)
  })

  it('does not preload when path is not included; resolves on demand each call', async () => {
    mockAuth.validateSession
      .mockResolvedValueOnce({ user: { id: '3' }, session: { sub: '3' }, accounts: [] })
      .mockResolvedValueOnce({ user: { id: '3' }, session: { sub: '3' }, accounts: [] })
    const mw = authMiddleware(['/protected'], mockAuth)
    const event: any = { request: new Request('http://localhost/other', { headers: { Authorization: 'Bearer token-3' } }), locals: {} }
    await mw(event)
    expect(typeof event.locals.getSession).toBe('function')
    const s1 = await event.locals.getSession()
    const s2 = await event.locals.getSession()
    expect(s1).toEqual({ user: { id: '3' }, session: { sub: '3' }, accounts: [], providers: [] })
    expect(s2).toEqual(s1)
    expect(mockAuth.validateSession).toHaveBeenCalledTimes(2)
  })

  it('returns NULL_SESSION when no token present', async () => {
    const mw = authMiddleware(false, mockAuth)
    const event: any = { request: new Request('http://localhost/any'), locals: {} }
    await mw(event)
    const session = await event.locals.getSession()
    expect(session).toEqual({ ...NULL_SESSION, providers: [] })
  })
})
