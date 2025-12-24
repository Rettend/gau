import { describe, expect, it } from 'vitest'
import { getSessionTokenFromRequest, SESSION_COOKIE_NAME } from '../../src/core'

describe('getSessionTokenFromRequest', () => {
  it('returns empty when no token is present', () => {
    const req = new Request('http://localhost/')
    expect(getSessionTokenFromRequest(req)).toEqual({})
  })

  it('extracts token from Cookie header', () => {
    const req = new Request('http://localhost/', {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=cookie-token` },
    })
    expect(getSessionTokenFromRequest(req)).toEqual({ token: 'cookie-token', source: 'cookie' })
  })

  it('extracts token from Authorization: Bearer header', () => {
    const req = new Request('http://localhost/', {
      headers: { Authorization: 'Bearer bearer-token' },
    })
    expect(getSessionTokenFromRequest(req)).toEqual({ token: 'bearer-token', source: 'bearer' })
  })

  it('prefers cookie over bearer when both are present', () => {
    const req = new Request('http://localhost/', {
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=cookie-token`,
        Authorization: 'Bearer bearer-token',
      },
    })
    expect(getSessionTokenFromRequest(req)).toEqual({ token: 'cookie-token', source: 'cookie' })
  })
})
