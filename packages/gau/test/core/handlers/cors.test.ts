import { describe, expect, it } from 'vitest'
import { MemoryAdapter } from '../../../src/adapters/memory'
import { createAuth } from '../../../src/core/createAuth'
import { createHandler } from '../../../src/core/handler'
import { applyCors, handlePreflight } from '../../../src/core/handlers/cors'
import { GitHub } from '../../../src/oauth'

function makeAuth(options: any = {}) {
  return createAuth({
    adapter: MemoryAdapter(),
    providers: [GitHub({ clientId: 'id', clientSecret: 'secret' })],
    ...options,
  })
}

describe('cors handler & configuration', () => {
  describe('preflight / apply helpers (default config)', () => {
    const auth = makeAuth()

    it('handlePreflight returns 204 with headers', () => {
      const req = new Request('https://app.local/api/auth/github', { method: 'OPTIONS', headers: { Origin: 'https://frontend.local' } })
      const res = handlePreflight(req, auth)
      expect(res.status).toBe(204)
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://frontend.local')
    })

    it('applyCors reflects origin', () => {
      const req = new Request('https://app.local/api/auth/github', { headers: { Origin: 'https://frontend.local' } })
      const res = applyCors(req, new Response('ok', { headers: { Vary: 'Accept-Encoding' } }), auth)
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://frontend.local')
      expect(res.headers.get('Vary')).toBe('Accept-Encoding, Origin')
    })
  })

  describe('configuration via createAuth', () => {
    it('disables CORS when cors=false', async () => {
      const auth = makeAuth({ cors: false })
      const handler = createHandler(auth)
      const res = await handler(new Request('https://example.com/api/auth/session', { headers: { Origin: 'https://foo.test' } }))
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
    })

    it('restricts origins when array provided', async () => {
      const auth = makeAuth({ cors: { allowedOrigins: ['https://allowed.test'] } })
      const handler = createHandler(auth)
      const allowed = await handler(new Request('https://example.com/api/auth/session', { headers: { Origin: 'https://allowed.test' } }))
      expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe('https://allowed.test')
      const denied = await handler(new Request('https://example.com/api/auth/session', { headers: { Origin: 'https://denied.test' } }))
      expect(denied.headers.get('Access-Control-Allow-Origin')).toBeNull()
    })

    it('uses wildcard when allowedOrigins = all and credentials disabled', async () => {
      const auth = makeAuth({ cors: { allowedOrigins: 'all', allowCredentials: false } })
      const handler = createHandler(auth)
      const res = await handler(new Request('https://example.com/api/auth/session', { headers: { Origin: 'https://anything.test' } }))
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    })

    it('reuses trust hosts when allowedOrigins = trust', async () => {
      const auth = makeAuth({ trustHosts: ['trusted.test'], cors: { allowedOrigins: 'trust' } })
      const handler = createHandler(auth)
      const allowed = await handler(new Request('https://example.com/api/auth/session', { headers: { Origin: 'https://trusted.test' } }))
      expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe('https://trusted.test')
      const denied = await handler(new Request('https://example.com/api/auth/session', { headers: { Origin: 'https://untrusted.test' } }))
      expect(denied.headers.get('Access-Control-Allow-Origin')).toBeNull()
    })
  })

  describe('cors extended scenarios', () => {
    it('allows any origin when * present in array (echoes origin)', async () => {
      const auth = makeAuth({ cors: { allowedOrigins: ['https://foo.test', '*'] } })
      const handler = createHandler(auth)
      const res = await handler(new Request('https://api.test/api/auth/session', { headers: { Origin: 'https://bar.test' } }))
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://bar.test')
    })

    it('allows host-only match (hostname without scheme)', async () => {
      const auth = makeAuth({ cors: { allowedOrigins: ['allowed.test'] } })
      const handler = createHandler(auth)
      const ok = await handler(new Request('https://api.test/api/auth/session', { headers: { Origin: 'https://allowed.test' } }))
      expect(ok.headers.get('Access-Control-Allow-Origin')).toBe('https://allowed.test')
      const denied = await handler(new Request('https://api.test/api/auth/session', { headers: { Origin: 'https://denied.test' } }))
      expect(denied.headers.get('Access-Control-Allow-Origin')).toBeNull()
    })

    it('trust hosts = all with allowedOrigins trust permits any origin', async () => {
      const auth = makeAuth({ trustHosts: 'all', cors: { allowedOrigins: 'trust' } })
      const handler = createHandler(auth)
      const res = await handler(new Request('https://api.test/api/auth/session', { headers: { Origin: 'https://whatever.any' } }))
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://whatever.any')
    })

    it('custom headers / methods / exposeHeaders / maxAge reflected in preflight', () => {
      const auth = makeAuth({
        cors: {
          allowedOrigins: ['https://custom.test'],
          allowCredentials: true,
          allowedHeaders: ['X-Auth', 'Content-Type'],
          allowedMethods: ['GET', 'DELETE'],
          exposeHeaders: ['X-Session-Id'],
          maxAge: 600,
        },
      })
      const req = new Request('https://api.test/api/auth/github', { method: 'OPTIONS', headers: { Origin: 'https://custom.test' } })
      const res = handlePreflight(req, auth)
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://custom.test')
      expect(res.headers.get('Access-Control-Allow-Headers')).toBe('X-Auth, Content-Type')
      expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET, DELETE')
      expect(res.headers.get('Access-Control-Expose-Headers')).toBe('X-Session-Id')
      expect(res.headers.get('Access-Control-Max-Age')).toBe('600')
      expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true')
    })

    it('omits credentials header when allowCredentials = false', async () => {
      const auth = makeAuth({ cors: { allowedOrigins: ['https://nocreds.test'], allowCredentials: false } })
      const handler = createHandler(auth)
      const res = await handler(new Request('https://api.test/api/auth/session', { headers: { Origin: 'https://nocreds.test' } }))
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://nocreds.test')
      expect(res.headers.has('Access-Control-Allow-Credentials')).toBe(false)
    })

    it('uses wildcard when allowedOrigins = all and credentials disabled (applyCors path)', async () => {
      const auth = makeAuth({ cors: { allowedOrigins: 'all', allowCredentials: false } })
      const res = applyCors(
        new Request('https://api.test/api/auth/session', { headers: { Origin: 'https://anywhere.test' } }),
        new Response('ok'),
        auth,
      )
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    })

    it('no headers added when Origin header missing', async () => {
      const auth = makeAuth()
      const handler = createHandler(auth)
      const res = await handler(new Request('https://api.test/api/auth/session'))
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
    })
  })
})
