import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as tokenHelpers from '../../src/client/token'
import { REFRESHED_TOKEN_HEADER, SESSION_TOKEN_KEY } from '../../src/client/token'

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

describe('token helpers', () => {
  beforeEach(() => {
    localStorageMock.clear()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('constants', () => {
    it('exports SESSION_TOKEN_KEY', () => {
      expect(SESSION_TOKEN_KEY).toBe('__gau-session-token')
    })

    it('exports REFRESHED_TOKEN_HEADER', () => {
      expect(REFRESHED_TOKEN_HEADER).toBe('X-Refreshed-Token')
    })
  })

  describe('token storage', () => {
    it('storeSessionToken should set localStorage only (not cookies)', () => {
      tokenHelpers.storeSessionToken('my-secret-token')
      expect(localStorageMock.getItem(SESSION_TOKEN_KEY)).toBe('my-secret-token')
    })

    it('getSessionToken should retrieve from localStorage', () => {
      localStorageMock.setItem(SESSION_TOKEN_KEY, 'my-retrieved-token')
      expect(tokenHelpers.getSessionToken()).toBe('my-retrieved-token')
    })

    it('getSessionToken returns null when not set', () => {
      expect(tokenHelpers.getSessionToken()).toBeNull()
    })

    it('clearSessionToken should remove from localStorage', () => {
      localStorageMock.setItem(SESSION_TOKEN_KEY, 'token-to-clear')
      tokenHelpers.clearSessionToken()
      expect(localStorageMock.getItem(SESSION_TOKEN_KEY)).toBeNull()
    })
  })

  describe('handleRefreshedToken', () => {
    it('stores token when X-Refreshed-Token header is present', () => {
      const response = new Response(null, {
        headers: { [REFRESHED_TOKEN_HEADER]: 'new-refreshed-token' },
      })
      tokenHelpers.handleRefreshedToken(response)
      expect(localStorageMock.getItem(SESSION_TOKEN_KEY)).toBe('new-refreshed-token')
    })

    it('does nothing when header is not present', () => {
      localStorageMock.setItem(SESSION_TOKEN_KEY, 'original-token')
      const response = new Response(null)
      tokenHelpers.handleRefreshedToken(response)
      expect(localStorageMock.getItem(SESSION_TOKEN_KEY)).toBe('original-token')
    })
  })

  describe('generatePKCE', () => {
    beforeEach(() => {
      vi.stubGlobal('window', {
        crypto: globalThis.crypto,
      })
      vi.stubGlobal('TextEncoder', TextEncoder)
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('should generate a verifier and challenge', async () => {
      const { codeVerifier, codeChallenge } = await tokenHelpers.generatePKCE()
      expect(codeVerifier).toBeDefined()
      expect(codeChallenge).toBeDefined()
      expect(typeof codeVerifier).toBe('string')
      expect(typeof codeChallenge).toBe('string')
    })
  })
})
