import type { SerializeOptions } from 'cookie'
import { describe, expect, it } from 'vitest'
import { Cookies, DEFAULT_COOKIE_SERIALIZE_OPTIONS, parseCookies } from '../../src/core/cookies'

describe('cookie utilities', () => {
  describe('parseCookies', () => {
    it('should parse a single cookie', () => {
      const header = 'foo=bar'
      const cookies = parseCookies(header)
      expect(cookies.size).toBe(1)
      expect(cookies.get('foo')).toBe('bar')
    })

    it('should parse multiple cookies', () => {
      const header = 'foo=bar; baz=qux'
      const cookies = parseCookies(header)
      expect(cookies.size).toBe(2)
      expect(cookies.get('foo')).toBe('bar')
      expect(cookies.get('baz')).toBe('qux')
    })

    it('should handle spaces around the separator', () => {
      const header = 'foo=bar;   baz=qux'
      const cookies = parseCookies(header)
      expect(cookies.size).toBe(2)
      expect(cookies.get('foo')).toBe('bar')
      expect(cookies.get('baz')).toBe('qux')
    })

    it('should return an empty map for null input', () => {
      const cookies = parseCookies(null)
      expect(cookies.size).toBe(0)
    })

    it('should return an empty map for undefined input', () => {
      const cookies = parseCookies(undefined)
      expect(cookies.size).toBe(0)
    })

    it('should return an empty map for an empty string', () => {
      const cookies = parseCookies('')
      expect(cookies.size).toBe(0)
    })
  })

  describe('cookies class', () => {
    const defaultOptions: SerializeOptions = {
      path: '/',
      httpOnly: true,
    }

    it('should get an existing cookie', () => {
      const requestCookies = new Map([['foo', 'bar']])
      const cookies = new Cookies(requestCookies, defaultOptions)
      expect(cookies.get('foo')).toBe('bar')
    })

    it('should return undefined for a non-existent cookie', () => {
      const requestCookies = new Map()
      const cookies = new Cookies(requestCookies, defaultOptions)
      expect(cookies.get('baz')).toBeUndefined()
    })

    it('should set a new cookie with default options', () => {
      const cookies = new Cookies(new Map(), defaultOptions)
      cookies.set('new', 'cookie')
      const headers = cookies.toHeaders()
      expect(headers.get('Set-Cookie')).toBe('new=cookie; Path=/; HttpOnly')
    })

    it('should set a new cookie with custom options, overriding defaults', () => {
      const cookies = new Cookies(new Map(), defaultOptions)
      cookies.set('new', 'cookie', { httpOnly: false, sameSite: 'strict' })
      const headers = cookies.toHeaders()
      expect(headers.get('Set-Cookie')).toBe('new=cookie; Path=/; SameSite=Strict')
    })

    it('should preserve URL encoding and decoding of cookie values', () => {
      const cookies = new Cookies(new Map(), defaultOptions)
      const value = '/protected?next=/account&label=hello world;✓%'
      cookies.set('callback', value)

      const header = cookies.toHeaders().get('Set-Cookie')!
      const pair = header.split(';')[0]!
      expect(pair).toBe(`callback=${encodeURIComponent(value)}`)
      expect(parseCookies(pair).get('callback')).toBe(value)
    })

    it('should honor a custom cookie encoder', () => {
      const cookies = new Cookies(new Map(), DEFAULT_COOKIE_SERIALIZE_OPTIONS)
      cookies.set('callback', '/protected', { encode: value => value })
      expect(cookies.toHeaders().get('Set-Cookie')).toContain('callback=/protected;')
    })

    it('should set a cookie with an expires date', () => {
      const cookies = new Cookies(new Map(), defaultOptions)
      const expires = new Date('2025-01-01T00:00:00Z')
      cookies.set('session', 'abc', { expires })
      const headers = cookies.toHeaders()
      expect(headers.get('Set-Cookie')).toBe(`session=abc; Path=/; Expires=${expires.toUTCString()}; HttpOnly`)
    })

    it('should delete a cookie', () => {
      const cookies = new Cookies(new Map(), defaultOptions)
      cookies.delete('old_cookie', { path: '/admin' })
      const headers = cookies.toHeaders()
      const cookieHeader = headers.get('Set-Cookie')
      expect(cookieHeader).toContain('old_cookie=;')
      expect(cookieHeader).toContain('Max-Age=0;')
      expect(cookieHeader).toContain('Path=/admin')
      expect(cookieHeader).toContain('Expires=')
    })

    it('should delete a cookie with default options', () => {
      const cookies = new Cookies(new Map(), defaultOptions)
      cookies.delete('old_cookie')
      const headers = cookies.toHeaders()
      const cookieHeader = headers.get('Set-Cookie')
      expect(cookieHeader).toContain('old_cookie=;')
      expect(cookieHeader).toContain('Max-Age=0;')
      expect(cookieHeader).toContain('Path=/')
      expect(cookieHeader).toContain('HttpOnly')
      expect(cookieHeader).toContain('Expires=')
    })

    it('should handle multiple set/delete operations', () => {
      const cookies = new Cookies(new Map(), DEFAULT_COOKIE_SERIALIZE_OPTIONS)
      cookies.set('a', '1')
      cookies.set('b', '2', { secure: false })
      cookies.delete('c')

      const headers = cookies.toHeaders()
      const setCookieValues = headers.getSetCookie()

      expect(setCookieValues).toHaveLength(3)

      const cookieA = setCookieValues.find(c => c.startsWith('a='))!
      expect(cookieA).toContain('a=1')
      expect(cookieA).toContain('Path=/')
      expect(cookieA).toContain('SameSite=Lax')
      expect(cookieA).toContain('Secure')
      expect(cookieA).toContain('HttpOnly')

      const cookieB = setCookieValues.find(c => c.startsWith('b='))!
      expect(cookieB).toContain('b=2')
      expect(cookieB).toContain('Path=/')
      expect(cookieB).toContain('SameSite=Lax')
      expect(cookieB).not.toContain('Secure')
      expect(cookieB).toContain('HttpOnly')

      const cookieC = setCookieValues.find(c => c.startsWith('c='))!
      expect(cookieC).toContain('c=')
      expect(cookieC).toContain('Max-Age=0')
      expect(cookieC).toContain('Expires=')
    })

    it('should return empty headers if no cookies are changed', () => {
      const cookies = new Cookies(new Map(), defaultOptions)
      const headers = cookies.toHeaders()
      expect(headers.get('Set-Cookie')).toBeNull()
    })
  })
})
