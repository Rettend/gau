import { Buffer } from 'node:buffer'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { sign, verify } from '../../src/jwt'

let es256Keys: CryptoKeyPair

beforeAll(async () => {
  es256Keys = await crypto.subtle.generateKey(
    {
      name: 'ECDSA',
      namedCurve: 'P-256',
    },
    true,
    ['sign', 'verify'],
  )
})

describe('jWT module', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('hS256 algorithm', () => {
    const secret = 'super-secret-for-hs256'

    it('signs and verifies a token', async () => {
      const token = await sign({ foo: 'bar' }, { algorithm: 'HS256', secret })
      const payload = await verify<{ foo: string }>(token, { algorithm: 'HS256', secret })
      expect(payload.foo).toBe('bar')
    })

    it('signs and verifies a token with a Uint8Array secret', async () => {
      const secret = new TextEncoder().encode('super-secret-for-hs256')
      const token = await sign({ foo: 'bar' }, { algorithm: 'HS256', secret })
      const payload = await verify<{ foo: string }>(token, { algorithm: 'HS256', secret })
      expect(payload.foo).toBe('bar')
    })

    it('throws on invalid signature', async () => {
      const token = await sign({ foo: 'bar' }, { algorithm: 'HS256', secret })
      await expect(verify(token, { algorithm: 'HS256', secret: 'wrong-secret' }))
        .rejects
        .toThrow('Invalid JWT signature')
    })

    it('throws on an expired token', async () => {
      const token = await sign({ foo: 'bar' }, { algorithm: 'HS256', secret, ttl: 60 }) // expires in 60s
      vi.advanceTimersByTime(61 * 1000) // 61s later
      await expect(verify(token, { algorithm: 'HS256', secret }))
        .rejects
        .toThrow('JWT expired')
    })

    it('verifies a token just before it expires', async () => {
      const token = await sign({ foo: 'bar' }, { algorithm: 'HS256', secret, ttl: 60 })
      vi.advanceTimersByTime(59 * 1000)
      const payload = await verify<{ foo: string }>(token, { algorithm: 'HS256', secret })
      expect(payload.foo).toBe('bar')
    })
  })

  describe('eS256 algorithm', () => {
    it('signs and verifies a token', async () => {
      const { privateKey, publicKey } = es256Keys
      const token = await sign({ hello: 'world' }, { algorithm: 'ES256', privateKey })
      const payload = await verify<{ hello: string }>(token, { algorithm: 'ES256', publicKey })
      expect(payload.hello).toBe('world')
    })

    it('signs and verifies a token using a base64url secret', async () => {
      const pkcs8 = await crypto.subtle.exportKey('pkcs8', es256Keys.privateKey)
      const secret = Buffer.from(pkcs8).toString('base64url')
      const token = await sign({ a: 1 }, { algorithm: 'ES256', secret })
      const payload = await verify(token, { algorithm: 'ES256', secret })
      expect((payload as any).a).toBe(1)
    })

    it('throws on invalid signature', async () => {
      const { privateKey } = es256Keys
      const otherKeyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])

      const token = await sign({ hello: 'world' }, { algorithm: 'ES256', privateKey })
      await expect(verify(token, { algorithm: 'ES256', publicKey: otherKeyPair.publicKey }))
        .rejects
        .toThrow('Invalid JWT signature')
    })

    it('throws on an expired token', async () => {
      const { privateKey, publicKey } = es256Keys
      const token = await sign({ foo: 'bar' }, { algorithm: 'ES256', privateKey, ttl: 120 }) // expires in 120s
      vi.advanceTimersByTime(121 * 1000) // 121s later
      await expect(verify(token, { algorithm: 'ES256', publicKey }))
        .rejects
        .toThrow('JWT expired')
    })
  })

  describe('claim validation', () => {
    it('signs with and verifies iss, aud, and sub claims', async () => {
      const secret = 'claim-secret'
      const options = {
        algorithm: 'HS256' as const,
        secret,
        iss: 'my-app',
        aud: ['user-base', 'admins'],
        sub: 'user-123',
      }
      const token = await sign({ custom: 'claim' }, options)
      const payload = await verify(token, options)
      expect(payload.iss).toBe('my-app')
      expect(payload.aud).toEqual(['user-base', 'admins'])
      expect(payload.sub).toBe('user-123')
      expect((payload as any).custom).toBe('claim')
    })

    it('throws if iss claim is invalid', async () => {
      const secret = 'claim-secret'
      const token = await sign({}, { algorithm: 'HS256', secret, iss: 'my-app' })
      await expect(verify(token, { algorithm: 'HS256', secret, iss: 'another-app' }))
        .rejects
        .toThrow('Invalid JWT issuer')
    })

    it('throws if aud claim is invalid', async () => {
      const secret = 'claim-secret'
      const token = await sign({}, { algorithm: 'HS256', secret, aud: 'audience-1' })
      await expect(verify(token, { algorithm: 'HS256', secret, aud: 'audience-2' }))
        .rejects
        .toThrow('Invalid JWT audience')
    })

    it('throws if aud claim is present but verifier expects none', async () => {
      const secret = 'claim-secret'
      const token = await sign({}, { algorithm: 'HS256', secret, aud: 'audience-1' })
      // This should pass, as we don't require audience verification if not specified
      const payload = await verify(token, { algorithm: 'HS256', secret })
      expect((payload as any).aud).toBe('audience-1')
    })

    it('throws if token has no audience but verifier expects one', async () => {
      const secret = 'claim-secret'
      const token = await sign({}, { algorithm: 'HS256', secret })
      await expect(verify(token, { algorithm: 'HS256', secret, aud: 'audience-1' }))
        .rejects
        .toThrow('Invalid JWT audience')
    })

    it('verifies if one of expected audiences matches', async () => {
      const secret = 'claim-secret'
      const token = await sign({}, { algorithm: 'HS256', secret, aud: 'audience-1' })
      const payload = await verify(token, { algorithm: 'HS256', secret, aud: ['audience-1', 'audience-2'] })
      expect((payload as any).aud).toBe('audience-1')
    })

    it('throws on a token used before its nbf time', async () => {
      const secret = 'nbf-secret'
      const now = Math.floor(Date.now() / 1000)
      const payload = { nbf: now + 60 } // not valid for 60 seconds
      const token = await sign(payload, { algorithm: 'HS256', secret })
      await expect(verify(token, { algorithm: 'HS256', secret }))
        .rejects
        .toThrow('JWT not yet valid')
    })

    it('verifies a token at or after its nbf time', async () => {
      const secret = 'nbf-secret'
      const now = Math.floor(Date.now() / 1000)
      const payload = { nbf: now + 60 }
      const token = await sign(payload, { algorithm: 'HS256', secret })
      vi.advanceTimersByTime(60 * 1000)
      const verified = await verify(token, { algorithm: 'HS256', secret })
      expect(verified).toBeDefined()
    })
  })

  describe('algorithm mismatch', () => {
    it('throws when trying to verify an HS256 token as ES256', async () => {
      const { publicKey } = es256Keys
      const token = await sign({ data: 'foo' }, { algorithm: 'HS256', secret: 'some-secret' })
      await expect(verify(token, { algorithm: 'ES256', publicKey }))
        .rejects
        .toThrow('JWT algorithm is "HS256", but verifier was configured for "ES256"')
    })

    it('throws when trying to verify an ES256 token as HS256', async () => {
      const { privateKey } = es256Keys
      const token = await sign({ data: 'foo' }, { algorithm: 'ES256', privateKey })
      await expect(verify(token, { algorithm: 'HS256', secret: 'some-secret' }))
        .rejects
        .toThrow('JWT algorithm is "ES256", but verifier was configured for "HS256"')
    })
  })

  describe('secret handling', () => {
    it('throws if secret is missing for HS256 signing', async () => {
      await expect(sign({}, { algorithm: 'HS256' }))
        .rejects
        .toThrow('Missing secret for HS256 signing')
    })

    it('throws if secret is missing for ES256 signing without a private key', async () => {
      await expect(sign({}, { algorithm: 'ES256' }))
        .rejects
        .toThrow('Missing secret for ES256 signing. It must be a base64url-encoded string.')
    })

    it('throws if secret is missing for HS256 verification', async () => {
      const token = await sign({ a: 1 }, { algorithm: 'HS256', secret: 'a-secret' })
      await expect(verify(token, { algorithm: 'HS256' }))
        .rejects
        .toThrow('Missing secret for HS256 verification')
    })

    it('throws if secret is missing for ES256 verification without a public key', async () => {
      const { privateKey } = es256Keys
      const token = await sign({ b: 2 }, { algorithm: 'ES256', privateKey })
      await expect(verify(token, { algorithm: 'ES256' }))
        .rejects
        .toThrow('Missing secret for ES256 verification. Must be a base64url-encoded string.')
    })

    it('throws if deriveKeysFromSecret fails during verification', async () => {
      const { privateKey } = es256Keys
      const token = await sign({ b: 2 }, { algorithm: 'ES256', privateKey })
      await expect(verify(token, { algorithm: 'ES256', secret: 'invalid-secret' }))
        .rejects
        .toThrow('Invalid secret')
    })
  })
})
