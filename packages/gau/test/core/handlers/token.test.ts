import { describe, expect, it, vi } from 'vitest'
import { ErrorCodes } from '../../../src/core/errors'
import { handleToken } from '../../../src/core/handlers/token'

describe('handleToken', () => {
  const mockAuth = {
    verifyJWT: vi.fn(),
    createSession: vi.fn(),
  } as any

  it('should return 405 if method is not POST', async () => {
    const request = new Request('http://localhost/token', { method: 'GET' })
    await expect(handleToken(request, mockAuth)).rejects.toMatchObject({
      code: ErrorCodes.METHOD_NOT_ALLOWED,
      status: 405,
    })
  })

  it('should return 400 if body is invalid', async () => {
    const request = new Request('http://localhost/token', { method: 'POST', body: 'invalid-json' })
    await expect(handleToken(request, mockAuth)).rejects.toMatchObject({
      code: ErrorCodes.INVALID_REQUEST,
      status: 400,
    })
  })

  it('should return 400 if code or codeVerifier is missing', async () => {
    const request = new Request('http://localhost/token', {
      method: 'POST',
      body: JSON.stringify({ code: 'some-code' }),
    })
    await expect(handleToken(request, mockAuth)).rejects.toMatchObject({
      code: ErrorCodes.INVALID_REQUEST,
      status: 400,
    })
  })

  it('should return 400 if code is invalid', async () => {
    mockAuth.verifyJWT.mockResolvedValue(null)
    const request = new Request('http://localhost/token', {
      method: 'POST',
      body: JSON.stringify({ code: 'bad-code', codeVerifier: 'verifier' }),
    })
    await expect(handleToken(request, mockAuth)).rejects.toMatchObject({
      code: ErrorCodes.TOKEN_EXPIRED,
      status: 400,
    })
  })

  it('should return 400 if verifier does not match challenge', async () => {
    mockAuth.verifyJWT.mockResolvedValue({ sub: 'user-123', challenge: 'mismatch-challenge' })

    // Mock crypto for SHA-256
    const mockDigest = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3, 4]).buffer)
    Object.defineProperty(globalThis, 'crypto', {
      value: { subtle: { digest: mockDigest } },
      writable: true,
    })
    Object.defineProperty(globalThis, 'TextEncoder', {
      value: class { encode() { return new Uint8Array(0) } },
      writable: true,
    })

    const request = new Request('http://localhost/token', {
      method: 'POST',
      body: JSON.stringify({ code: 'good-code', codeVerifier: 'verifier' }),
    })
    await expect(handleToken(request, mockAuth)).rejects.toMatchObject({
      code: ErrorCodes.CODE_VERIFIER_INVALID,
      status: 400,
    })
  })

  it('should return session token if valid', async () => {
    // Challenge for [1, 2, 3, 4] is AQIDBA (base64url)
    // btoa(String.fromCharCode(1,2,3,4)) -> AQIDBA== -> AQIDBA
    mockAuth.verifyJWT.mockResolvedValue({ sub: 'user-123', challenge: 'AQIDBA' })
    mockAuth.createSession.mockResolvedValue('new-session-token')

    const mockDigest = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3, 4]).buffer)
    Object.defineProperty(globalThis, 'crypto', {
      value: { subtle: { digest: mockDigest } },
      writable: true,
    })
    Object.defineProperty(globalThis, 'TextEncoder', {
      value: class { encode() { return new Uint8Array(0) } },
      writable: true,
    })

    const request = new Request('http://localhost/token', {
      method: 'POST',
      body: JSON.stringify({ code: 'good-code', codeVerifier: 'verifier' }),
    })
    const response = await handleToken(request, mockAuth)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ token: 'new-session-token' })
  })
})
