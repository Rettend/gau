import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { MemoryAdapter } from '../../src/adapters/memory'
import { createAuthClient } from '../../src/client/vanilla'
import { createAuth, createHandler } from '../../src/core'
import { Email, renderEmail } from '../../src/email'
import * as runtime from '../../src/runtimes/tauri'
import * as token from '../../src/client/token'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('email client', () => {
  it('uses signIn for both steps, survives reload, refreshes the session, and removes proof', async () => {
    let code = ''
    let cookie = ''
    const data = new Map<string, string>()
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => data.set(key, value),
      removeItem: (key: string) => data.delete(key),
    })
    const auth = createAuth({
      adapter: MemoryAdapter(),
      jwt: { algorithm: 'HS256', secret: 'secret' },
      providers: [
        Email({
          from: 'app@example.com',
          send: async () => {},
          render: (context) => {
            code = context.code!
            return renderEmail(context)
          },
        }),
      ],
    })
    const handler = createHandler(auth)
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const headers = new Headers(init?.headers)
      headers.set('Origin', 'https://app.example.com')
      if (cookie) headers.set('Cookie', cookie)
      const response = await handler(new Request(String(input), { ...init, headers }))
      const setCookie = response.headers.get('Set-Cookie')
      if (setCookie) cookie = setCookie.split(';')[0]!
      return response
    })
    const first = createAuthClient<typeof auth>({ baseUrl: 'https://app.example.com/api/auth' })
    const result = await first.signIn('email', { email: 'user@example.com' })
    const second = createAuthClient<typeof auth>({ baseUrl: 'https://app.example.com/api/auth' })
    const listener = vi.fn()
    second.onSessionChange(listener)
    await expect(
      second.signIn('email', { challengeId: result.challengeId, code: code === '000000' ? '111111' : '000000' }),
    ).rejects.toMatchObject({ code: 'EMAIL_VERIFICATION_INVALID' })
    await expect(second.signIn('email', { challengeId: result.challengeId, code })).resolves.toEqual({
      status: 'authenticated',
    })
    expect(listener).toHaveBeenCalled()
    expect(second.session.user?.email).toBe('user@example.com')
    expect(data.size).toBe(0)
  })

  it('uses token sessions directly in Tauri without an OAuth redirect', async () => {
    vi.spyOn(runtime, 'isTauri').mockReturnValue(true)
    const store = vi.spyOn(token, 'storeSessionToken').mockImplementation(() => {})
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        Response.json({
          status: 'verification-required',
          challengeId: 'id',
          expiresAt: Date.now() + 600000,
          retryAfter: 60,
        }),
      )
      .mockResolvedValueOnce(Response.json({ status: 'authenticated', token: 'session-token' }))
      .mockResolvedValueOnce(Response.json({ user: { id: 'user' }, session: { sub: 'user' }, accounts: [] }))
    const client = createAuthClient({ baseUrl: 'https://app.example.com/api/auth' })
    const result = await client.signIn('email', { email: 'user@example.com' })
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string).session).toBe('token')
    const completed = await client.signIn('email', { challengeId: result.challengeId, code: '123456' })
    expect(completed).toEqual({ status: 'authenticated' })
    expect(store).toHaveBeenCalledWith('session-token')
  })
})
