import { afterEach, expect, it, vi } from 'vite-plus/test'
import { createAuthClient } from '../../src/client/vanilla'

afterEach(() => vi.unstubAllGlobals())

it('seeds a client without a request and shares server updates with subscribers', () => {
  const session = { user: { id: 'alice' }, session: { sub: 'alice' } }
  const client = createAuthClient({ baseUrl: '/api/auth', session })
  expect(client.session).toBe(session)
  const listener = vi.fn()
  const stop = client.onSessionChange(listener)
  const next = { user: null, session: null }
  client.setSession(next)
  expect(listener).toHaveBeenCalledWith(next)
  stop()
  client.setSession(session)
  expect(listener).toHaveBeenCalledTimes(1)
})

it('does not overwrite a new server session with an older in-flight response', async () => {
  let resolve!: (response: Response) => void
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done
        }),
    ),
  )
  const client = createAuthClient({ baseUrl: '/api/auth' })
  const pending = client.refreshSession()
  const next = { user: { id: 'bob' }, session: { sub: 'bob' } }
  client.setSession(next)
  resolve(Response.json({ user: { id: 'alice' }, session: { sub: 'alice' } }))
  expect(await pending).toBe(next)
  expect(client.session).toBe(next)
})
