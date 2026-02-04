import { describe, expect, it } from 'vitest'
import {
  createErrorRedirectUrl,
  ErrorCodes,
  ErrorMessages,
  ErrorStatuses,
  GauError,
  handleError,
  isUserFacingRequest,
} from '../../src/core/errors'

describe('gauError', () => {
  describe('constructor', () => {
    it('should create error with just error code (using defaults)', () => {
      const error = new GauError(ErrorCodes.CSRF_INVALID)

      expect(error.code).toBe('CSRF_INVALID')
      expect(error.message).toBe('Invalid CSRF token')
      expect(error.status).toBe(403)
      expect(error.name).toBe('GauError')
    })

    it('should use default status from ErrorStatuses', () => {
      expect(new GauError(ErrorCodes.UNAUTHORIZED).status).toBe(401)
      expect(new GauError(ErrorCodes.NOT_FOUND).status).toBe(404)
      expect(new GauError(ErrorCodes.INTERNAL_ERROR).status).toBe(500)
    })

    it('should default to 400 for codes without explicit status', () => {
      expect(new GauError(ErrorCodes.PKCE_MISSING).status).toBe(400)
      expect(new GauError(ErrorCodes.INVALID_REQUEST).status).toBe(400)
    })

    it('should accept options as second argument', () => {
      const error = new GauError(ErrorCodes.CSRF_INVALID, {
        redirectUrl: '/login',
      })

      expect(error.message).toBe('Invalid CSRF token')
      expect(error.redirectUrl).toBe('/login')
    })

    it('should accept custom message as second argument', () => {
      const error = new GauError(ErrorCodes.PROVIDER_NOT_FOUND, 'GitHub not configured')

      expect(error.message).toBe('GitHub not configured')
      expect(error.status).toBe(400)
    })

    it('should accept custom message with options', () => {
      const cause = new Error('DB error')
      const error = new GauError(ErrorCodes.USER_CREATE_FAILED, 'Failed to create test user', {
        cause,
        redirectUrl: '/error',
      })

      expect(error.message).toBe('Failed to create test user')
      expect(error.status).toBe(500)
      expect(error.cause).toBe(cause)
      expect(error.redirectUrl).toBe('/error')
    })

    it('should allow overriding default status', () => {
      const error = new GauError(ErrorCodes.CSRF_INVALID, { status: 418 })
      expect(error.status).toBe(418)
    })
  })

  describe('toJSON', () => {
    it('should serialize to JSON correctly', () => {
      const error = new GauError(ErrorCodes.UNAUTHORIZED)
      const json = error.toJSON()

      expect(json).toEqual({
        error: 'Unauthorized',
        code: 'UNAUTHORIZED',
      })
    })

    it('should include redirectUrl if set', () => {
      const error = new GauError(ErrorCodes.CSRF_INVALID, { redirectUrl: '/login' })
      const json = error.toJSON()

      expect(json).toEqual({
        error: 'Invalid CSRF token',
        code: 'CSRF_INVALID',
        redirectUrl: '/login',
      })
    })
  })
})

describe('errorCodes', () => {
  it('should have all codes matching ErrorMessages keys', () => {
    const messageKeys = Object.keys(ErrorMessages)
    const codeKeys = Object.keys(ErrorCodes)

    expect(codeKeys).toEqual(messageKeys)
  })

  it('should map each code to itself', () => {
    expect(ErrorCodes.CSRF_INVALID).toBe('CSRF_INVALID')
    expect(ErrorCodes.UNAUTHORIZED).toBe('UNAUTHORIZED')
    expect(ErrorCodes.NOT_FOUND).toBe('NOT_FOUND')
  })
})

describe('errorStatuses', () => {
  it('should have correct status codes for common errors', () => {
    expect(ErrorStatuses.UNAUTHORIZED).toBe(401)
    expect(ErrorStatuses.FORBIDDEN).toBe(403)
    expect(ErrorStatuses.NOT_FOUND).toBe(404)
    expect(ErrorStatuses.METHOD_NOT_ALLOWED).toBe(405)
    expect(ErrorStatuses.INTERNAL_ERROR).toBe(500)
  })
})

describe('createErrorRedirectUrl', () => {
  it('should create redirect URL with query params', () => {
    const error = new GauError(ErrorCodes.CSRF_INVALID)
    const url = createErrorRedirectUrl('/auth/error', error)

    expect(url).toBe('/auth/error?code=CSRF_INVALID&message=Invalid+CSRF+token&status=403')
  })

  it('should include redirect param if set', () => {
    const error = new GauError(ErrorCodes.UNAUTHORIZED, { redirectUrl: '/dashboard' })
    const url = createErrorRedirectUrl('/auth/error', error)

    expect(url).toContain('redirect=%2Fdashboard')
  })
})

describe('isUserFacingRequest', () => {
  const basePath = '/api/auth'

  it('should return true for sign-in routes', () => {
    const request = new Request('http://localhost/api/auth/github', { method: 'GET' })
    expect(isUserFacingRequest(request, basePath)).toBe(true)
  })

  it('should return true for callback routes', () => {
    const request = new Request('http://localhost/api/auth/callback/github', { method: 'GET' })
    expect(isUserFacingRequest(request, basePath)).toBe(true)
  })

  it('should return true for link routes', () => {
    const request = new Request('http://localhost/api/auth/link/github', { method: 'GET' })
    expect(isUserFacingRequest(request, basePath)).toBe(true)
  })

  it('should return false for session route', () => {
    const request = new Request('http://localhost/api/auth/session', { method: 'GET' })
    expect(isUserFacingRequest(request, basePath)).toBe(false)
  })

  it('should return false for POST requests', () => {
    const request = new Request('http://localhost/api/auth/signout', { method: 'POST' })
    expect(isUserFacingRequest(request, basePath)).toBe(false)
  })
})

describe('handleError', () => {
  const basePath = '/api/auth'

  it('should return JSON for API requests', async () => {
    const error = new GauError(ErrorCodes.UNAUTHORIZED)
    const request = new Request('http://localhost/api/auth/session', { method: 'GET' })

    const response = await handleError({ error, request }, { basePath })

    expect(response.status).toBe(401)
    expect(response.headers.get('Content-Type')).toContain('application/json')

    const body = await response.json()
    expect(body.code).toBe('UNAUTHORIZED')
    expect(body.error).toBe('Unauthorized')
  })

  it('should redirect for user-facing requests when errorRedirect is set', async () => {
    const error = new GauError(ErrorCodes.CSRF_INVALID)
    const request = new Request('http://localhost/api/auth/callback/github', { method: 'GET' })

    const response = await handleError(
      { error, request },
      { basePath, errorRedirect: '/auth/error' },
    )

    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toContain('/auth/error?code=CSRF_INVALID')
  })

  it('should render HTML for user-facing requests without errorRedirect', async () => {
    const error = new GauError(ErrorCodes.CSRF_INVALID)
    const request = new Request('http://localhost/api/auth/github', { method: 'GET' })

    const response = await handleError({ error, request }, { basePath })

    expect(response.status).toBe(403)
    expect(response.headers.get('Content-Type')).toContain('text/html')

    const body = await response.text()
    expect(body).toContain('Invalid CSRF token')
    expect(body).toContain('CSRF_INVALID')
  })

  it('should use custom onError handler if provided', async () => {
    const error = new GauError(ErrorCodes.UNAUTHORIZED)
    const request = new Request('http://localhost/api/auth/session', { method: 'GET' })

    const customResponse = new Response('Custom error', { status: 418 })
    const response = await handleError(
      { error, request },
      {
        basePath,
        onError: () => customResponse,
      },
    )

    expect(response).toBe(customResponse)
    expect(response.status).toBe(418)
  })

  it('should fall back to default handling if onError returns undefined', async () => {
    const error = new GauError(ErrorCodes.UNAUTHORIZED)
    const request = new Request('http://localhost/api/auth/session', { method: 'GET' })

    const response = await handleError(
      { error, request },
      {
        basePath,
        onError: () => undefined,
      },
    )

    expect(response.status).toBe(401)
    const body = await response.json()
    expect(body.code).toBe('UNAUTHORIZED')
  })
})
