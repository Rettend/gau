import { describe, expect, it, vi } from 'vite-plus/test'
import { createWebAuth } from '../../src/core/webAuth'
import { MarkoRunAuth } from '../../src/marko-run'
import { AstroAuth } from '../../src/astro'
import { setup } from '../handler'

describe('web integrations', () => {
  it.each([createWebAuth, MarkoRunAuth, AstroAuth])(
    'isolates requests and only exposes safe page data',
    async (factory) => {
      const { auth } = setup()
      const validate = vi.spyOn(auth, 'validateSession').mockResolvedValue({
        user: { id: 'alice' },
        session: { id: 'secret', sub: 'alice' },
        accounts: [{ userId: 'alice', provider: 'github', providerAccountId: '1', accessToken: 'private' }],
      })
      const web = factory(auth)
      const request = new Request('https://app.test/', { headers: { Authorization: 'Bearer token' } })
      const [safe, server] = await Promise.all([web.getSession(request), web.getServerSession(request)])
      expect(validate).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(safe)).not.toContain('secret')
      expect(JSON.stringify(safe)).not.toContain('private')
      expect(server.accounts?.[0]?.accessToken).toBe('private')
      expect((await web.getSession(new Request('https://app.test/'))).user).toBeNull()
      expect(await web.getSession(request)).toBe(safe)
    },
  )

  it('preserves streamed bodies and other cookies when refreshing', async () => {
    const { auth } = setup()
    vi.spyOn(auth, 'refreshSession').mockResolvedValue({
      source: 'cookie',
      token: 'new',
      cookie: 'gau.session=new; Path=/',
    } as any)
    const web = createWebAuth(auth)
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('page'))
        controller.close()
      },
    })
    const response = await web.refresh(
      new Request('https://app.test/account'),
      () =>
        new Response(stream, {
          status: 202,
          headers: { 'Set-Cookie': 'theme=dark; Path=/' },
        }),
    )
    expect(response.status).toBe(202)
    expect(response.headers.getSetCookie()).toHaveLength(2)
    expect(await response.text()).toBe('page')
  })

  it('does not refresh over sign-out or callback responses', async () => {
    const { auth } = setup()
    const refresh = vi.spyOn(auth, 'refreshSession')
    const web = createWebAuth(auth)
    for (const action of ['signout', 'callback/github']) {
      const response = new Response(null, { headers: { 'Set-Cookie': 'gau.session=; Max-Age=0' } })
      expect(await web.refresh(new Request(`https://app.test/api/auth/${action}`), () => response)).toBe(response)
    }
    expect(refresh).not.toHaveBeenCalled()
  })

  it('attaches lazy helpers to Astro locals', async () => {
    const { auth } = setup()
    const gau = AstroAuth(auth, { refresh: false })
    const ctx = { request: new Request('https://app.test/'), locals: {} } as any
    const response = new Response('page')
    expect(await gau.onRequest(ctx, async () => response)).toBe(response)
    expect((await ctx.locals.getSession()).user).toBeNull()
  })

  it('supports form sign-out while retaining origin checks and cookie deletion', async () => {
    const { auth } = setup()
    const web = createWebAuth(auth)
    const request = (target: string, origin = 'http://localhost') =>
      new Request(`http://localhost/api/auth/signout?redirectTo=${encodeURIComponent(target)}`, {
        method: 'POST',
        headers: { Origin: origin },
      })
    const response = await web.handle(request('/signed-out'))
    expect(response.status).toBe(303)
    expect(response.headers.get('Location')).toBe('http://localhost/signed-out')
    expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0')
    expect(response.headers.getSetCookie()).toHaveLength(2)
    expect((await web.handle(request('https://evil.test/'))).status).toBe(400)
    expect((await web.handle(request('javascript:alert(1)'))).status).toBe(400)
    expect((await web.handle(request('/', 'https://evil.test'))).status).toBe(403)
    expect(
      (
        await web.handle(
          new Request('http://localhost/api/auth/signout', { method: 'POST', headers: { Origin: 'http://localhost' } }),
        )
      ).status,
    ).toBe(200)
  })
})
