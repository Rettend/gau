import { afterEach, expect, it, vi } from 'vite-plus/test'
import { createMarkoAuth } from '../../src/client/marko'
import { createAuthClient } from '../../src/client/vanilla'

afterEach(() => vi.unstubAllGlobals())

it('shares sessions between mounted controllers and unsubscribes on disposal', () => {
  vi.stubGlobal('window', { location: { hash: '' } })
  const initial = { user: null, session: null }
  const client = createAuthClient({ baseUrl: '/api/auth', session: initial })
  const first = vi.fn()
  const second = vi.fn()
  const a = createMarkoAuth({ client, onSession: first })
  const b = createMarkoAuth({ client, onSession: second })
  expect(first).toHaveBeenLastCalledWith(initial)
  expect(second).toHaveBeenLastCalledWith(initial)

  const signedIn = { user: { id: 'alice' }, session: { sub: 'alice' } }
  a.setSession(signedIn)
  expect(first).toHaveBeenLastCalledWith(signedIn)
  expect(second).toHaveBeenLastCalledWith(signedIn)

  a.dispose()
  first.mockClear()
  b.setSession(initial)
  expect(first).not.toHaveBeenCalled()
  expect(second).toHaveBeenLastCalledWith(initial)
  b.dispose()
})
