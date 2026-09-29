import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vite-plus/test'
import { constantTimeEqual, deriveKeysFromSecret, rawToDer } from '../../src/jwt/utils'

describe('jWT utils', () => {
  describe('constantTimeEqual', () => {
    it('returns true for equal Uint8Arrays', () => {
      const a = new TextEncoder().encode('hello')
      const b = new TextEncoder().encode('hello')
      expect(constantTimeEqual(a, b)).toBe(true)
    })

    it('returns false for Uint8Arrays of different lengths', () => {
      const a = new TextEncoder().encode('hello')
      const b = new TextEncoder().encode('hello-world')
      expect(constantTimeEqual(a, b)).toBe(false)
    })

    it('returns false for Uint8Arrays with different content', () => {
      const a = new TextEncoder().encode('hello-A')
      const b = new TextEncoder().encode('hello-B')
      expect(constantTimeEqual(a, b)).toBe(false)
    })
  })

  describe('deriveKeysFromSecret', () => {
    it('derives a valid key pair from a base64url PKCS8 secret', async () => {
      const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
      const exportedPkcs8 = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey)
      const secret = Buffer.from(exportedPkcs8).toString('base64url')

      const { privateKey, publicKey } = await deriveKeysFromSecret(secret)
      expect(privateKey).toBeInstanceOf(CryptoKey)
      expect(privateKey.type).toBe('private')
      expect(publicKey).toBeInstanceOf(CryptoKey)
      expect(publicKey.type).toBe('public')

      // Optional: sign and verify to be sure
      const data = new TextEncoder().encode('test data')
      const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, data)
      const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, signature, data)
      expect(valid).toBe(true)
    })

    it('throws AuthError for a malformed base64url secret', async () => {
      const invalidSecret = 'not-base64-url-$$'
      await expect(deriveKeysFromSecret(invalidSecret))
        .rejects
        .toThrow('Invalid base64url string')
    })

    it('throws AuthError for an invalid secret', async () => {
      const invalidSecret = 'not-a-valid-key'
      await expect(deriveKeysFromSecret(invalidSecret))
        .rejects
        .toThrow('Invalid secret. Must be a base64url-encoded PKCS#8 private key for ES256.')
    })
  })

  describe('rawToDer', () => {
    it('throws if raw signature is not 64 bytes', () => {
      const invalidSig = new Uint8Array(63)
      expect(() => rawToDer(invalidSig)).toThrow('Invalid raw signature length')
    })

    it('correctly converts a 64-byte raw signature to DER format', () => {
      // A sample 64-byte raw signature (r || s)
      const r = '5b6c8ab275b0a3f3a4a356c702c2533228a6f6f1406834f374e2a868a2432029'
      const s = '067b5c8f495c3451e5e2e8b61a354b322588c7576f4e6f43e06f8c7921a97d39'
      const rawSig = new Uint8Array(Buffer.from(r + s, 'hex'))

      const derSig = rawToDer(rawSig)

      // Check for SEQUENCE, INTEGER markers and total length
      expect(derSig[0]).toBe(0x30) // SEQUENCE
      expect(derSig[2]).toBe(0x02) // INTEGER (for R)
      expect(derSig[4 + derSig[3]!]).toBe(0x02) // INTEGER (for S)
      expect(derSig.length).toBe(2 + derSig[1]!) // Total length check
    })

    it('correctly handles r or s values that need padding', () => {
      // A signature where 'r' starts with a byte >= 0x80, requiring a padding byte.
      const r = 'f'.repeat(64)
      const s = '1'.repeat(64)
      const rawSig = new Uint8Array(Buffer.from(r + s, 'hex'))

      const derSig = rawToDer(rawSig)

      expect(derSig[0]).toBe(0x30) // SEQUENCE
      expect(derSig[2]).toBe(0x02) // INTEGER (for R)
      expect(derSig[3]).toBe(33) // Length of R should be 33 (32 + padding)
      expect(derSig[4]).toBe(0x00) // Padding byte
    })
  })
})
