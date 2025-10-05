import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as tokenHelpers from '../../src/client/token'

vi.mock('esm-env', () => ({ BROWSER: true }))

const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => { store[key] = value.toString() },
    removeItem: (key: string) => { delete store[key] },
    clear: () => { store = {} },
  }
})()

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock })
Object.defineProperty(globalThis, 'document', {
  value: { cookie: '' },
  writable: true,
})

describe('token helpers', () => {
  beforeEach(() => {
    localStorageMock.clear()
    document.cookie = ''
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('token storage', () => {
    it('storeSessionToken should set localStorage and cookie', () => {
      tokenHelpers.storeSessionToken('my-secret-token')
      expect(localStorageMock.getItem('gau-token')).toBe('my-secret-token')
      expect(document.cookie).toBe('__gau-session-token=my-secret-token; path=/; max-age=31536000; samesite=lax; secure')
    })

    it('getSessionToken should retrieve from localStorage', () => {
      localStorageMock.setItem('gau-token', 'my-retrieved-token')
      expect(tokenHelpers.getSessionToken()).toBe('my-retrieved-token')
    })

    it('clearSessionToken should remove from localStorage and expire cookie', () => {
      localStorageMock.setItem('gau-token', 'token-to-clear')
      document.cookie = '__gau-session-token=token-to-clear'
      tokenHelpers.clearSessionToken()
      expect(localStorageMock.getItem('gau-token')).toBeNull()
      expect(document.cookie).toBe('__gau-session-token=; path=/; max-age=0')
    })
  })
})
