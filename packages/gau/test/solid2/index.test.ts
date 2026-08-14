import { DEV } from 'esm-env'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { REFRESHED_TOKEN_HEADER, SESSION_COOKIE_NAME } from '../../src/core'
import { authMiddleware, refreshMiddleware, SolidAuth } from '../../src/solid2'

const mocks = vi.hoisted(() => ({
  createHandler: vi.fn(),
  event: undefined as any,
}))

vi.mock('@solidjs/web', () => ({
  getRequestEvent: () => mocks.event,
}))

vi.mock('../../src/core', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/core')>()
  return {
    ...original,
    createHandler: mocks.createHandler,
  }
})

function createMockAuth(overrides: Record<string, unknown> = {}) {
  return {
    providerMap: new Map([['github', {}]]),
    signJWT: vi.fn(),
    validateSession: vi.fn(),
    refreshSession: vi.fn().mockResolvedValue(null),
    basePath: '/api/auth',
    development: false,
    ...overrides,
  } as any
}

describe('Solid 2 server integration', () => {
  beforeEach(() => {
    mocks.event = undefined
    mocks.createHandler.mockReset()
    mocks.createHandler.mockReturnValue((request: Request) => new Response(request.method))
  })

  it('creates API handlers without mutating a shared auth instance', async () => {
    const auth = createMockAuth({ development: !DEV, errorRedirect: undefined })
    const handlers = SolidAuth(auth)

    expect(auth.development).toBe(!DEV)
    expect(auth.errorRedirect).toBeUndefined()
    const handlerAuth = mocks.createHandler.mock.calls[0][0]
    expect(handlerAuth).not.toBe(auth)
    expect(handlerAuth.development).toBe(DEV)
    expect(handlerAuth.errorRedirect).toBeUndefined()
    expect(await (await handlers.POST({
      request: new Request('https://app.test/api/auth/signout', { method: 'POST' }),
    })).text()).toBe('POST')
  })

  it('attaches memoized safe and sensitive sessions and calls next', async () => {
    const validateSession = vi.fn().mockResolvedValue({
      user: { id: 'user-1' },
      session: { id: 'secret-session-id', sub: 'user-1', exp: 123 },
      accounts: [{
        provider: 'github',
        providerAccountId: 'account-1',
        accessToken: 'secret-access-token',
      }],
    })
    const auth = createMockAuth({ validateSession })
    const request = new Request('https://app.test/private', {
      headers: { Authorization: 'Bearer session-token' },
    })
    mocks.event = { request, locals: {}, response: { headers: new Headers() } }
    const nextResponse = new Response('next response', { status: 202 })
    const next = vi.fn().mockResolvedValue(nextResponse)

    const response = await authMiddleware(auth)(request, next)
    const serverOne = await mocks.event.locals.getServerSession()
    const serverTwo = await mocks.event.locals.getServerSession()
    const clientOne = await mocks.event.locals.getSession()
    const clientTwo = await mocks.event.locals.getSession()

    expect(response).toBe(nextResponse)
    expect(next).toHaveBeenCalledOnce()
    expect(serverTwo).toBe(serverOne)
    expect(clientTwo).toBe(clientOne)
    expect(validateSession).toHaveBeenCalledOnce()
    expect(serverOne.session.id).toBe('secret-session-id')
    expect(serverOne.accounts[0].accessToken).toBe('secret-access-token')
    expect(clientOne.session).toEqual({ sub: 'user-1', exp: 123 })
    expect(clientOne.accounts).toEqual([{ provider: 'github', providerAccountId: 'account-1' }])
    expect(clientOne.providers).toEqual(['github'])
  })

  it('appends refreshed cookies to the response stub without replacing existing cookies', async () => {
    const auth = createMockAuth({
      refreshSession: vi.fn().mockResolvedValue({
        source: 'cookie',
        token: 'new-token',
        cookie: `${SESSION_COOKIE_NAME}=new-token; Path=/; HttpOnly`,
      }),
    })
    const stubHeaders = new Headers()
    stubHeaders.append('Set-Cookie', 'app-cookie=one; Path=/')
    mocks.event = {
      request: new Request('https://app.test/dashboard'),
      locals: {},
      response: { headers: stubHeaders },
    }
    const downstream = new Response('downstream', {
      headers: { 'X-Downstream': 'preserved' },
    })
    const next = vi.fn().mockResolvedValue(downstream)

    const response = await refreshMiddleware(auth)(mocks.event.request, next)

    expect(response).toBe(downstream)
    expect(response.headers.get('X-Downstream')).toBe('preserved')
    expect(next).toHaveBeenCalledOnce()
    expect(stubHeaders.getSetCookie()).toEqual([
      'app-cookie=one; Path=/',
      `${SESSION_COOKIE_NAME}=new-token; Path=/; HttpOnly`,
    ])
  })

  it('sets bearer refresh headers while preserving the downstream response', async () => {
    const auth = createMockAuth({
      refreshSession: vi.fn().mockResolvedValue({
        source: 'bearer',
        token: 'new-bearer-token',
        cookie: 'unused',
      }),
    })
    const request = new Request('https://app.test/dashboard')
    mocks.event = { request, locals: {} }
    const downstream = new Response('ok', { headers: { 'X-App': 'kept' } })

    const response = await refreshMiddleware(auth)(request, () => downstream)

    expect(response.headers.get(REFRESHED_TOKEN_HEADER)).toBe('new-bearer-token')
    expect(response.headers.get('X-App')).toBe('kept')
    expect(await response.text()).toBe('ok')
  })

  it('skips refresh on the Gau auth base path and still calls next', async () => {
    const refreshSession = vi.fn()
    const auth = createMockAuth({ refreshSession })
    const request = new Request('https://app.test/api/auth/callback/github')
    const downstream = new Response('auth response', {
      headers: { 'Set-Cookie': 'gau-session=callback; Path=/' },
    })
    const next = vi.fn().mockResolvedValue(downstream)

    const response = await refreshMiddleware(auth)(request, next)

    expect(response).toBe(downstream)
    expect(next).toHaveBeenCalledOnce()
    expect(refreshSession).not.toHaveBeenCalled()
    expect(response.headers.getSetCookie()).toEqual(['gau-session=callback; Path=/'])
  })
})
