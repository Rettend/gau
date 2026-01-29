import type { Auth } from '../../src/core/createAuth'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHandler } from '../../src/core/handler'
import { setup } from '../handler'

describe('createHandler', () => {
  let auth: Auth
  let handler: ReturnType<typeof createHandler>

  beforeEach(() => {
    ({ auth } = setup())
    handler = createHandler(auth)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('routing', () => {
    it('should return 404 for unknown paths', async () => {
      const request = new Request('http://localhost/api/auth/a/b/c')
      const response = await handler(request)
      expect(response.status).toBe(404)
    })

    it('should return 404 for unknown actions', async () => {
      const request = new Request('http://localhost/api/auth/mock/unknown')
      const response = await handler(request)
      expect(response.status).toBe(404)
    })

    it('should return 404 for requests without action', async () => {
      const request = new Request('http://localhost/api/auth/')
      const response = await handler(request)
      expect(response.status).toBe(404)
    })

    it('should return 405 for wrong method', async () => {
      const request = new Request('http://localhost/api/auth/mock', { method: 'PUT' })
      const response = await handler(request)
      expect(response.status).toBe(405)
    })

    it('should handle OPTIONS requests for CORS preflight', async () => {
      const request = new Request('http://localhost/api/auth/mock', {
        method: 'OPTIONS',
        headers: { Origin: 'http://localhost:3000' },
      })
      const response = await handler(request)
      expect(response.status).toBe(204)
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:3000')
      expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST')
    })

    it('should return 403 for POST requests from untrusted origins', async () => {
      const request = new Request('http://localhost/api/auth/signout', {
        method: 'POST',
        headers: { Origin: 'https://untrusted.com' },
      })
      const response = await handler(request)
      expect(response.status).toBe(403)
    })

    it('should allow POST requests from trusted origins', async () => {
      const request = new Request('http://localhost/api/auth/signout', {
        method: 'POST',
        headers: { Origin: 'https://trusted.app.com' },
      })
      const response = await handler(request)
      expect(response.status).toBe(200)
    })

    it('should return 400 if provider is not found during sign-in', async () => {
      const request = new Request('http://localhost/api/auth/unknown-provider')
      const response = await handler(request)
      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body.error).toBe('Provider not found')
    })
  })
})
