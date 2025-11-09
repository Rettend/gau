import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as tauriHelpers from '../../src/runtimes/tauri/index'

vi.mock('esm-env', () => ({ BROWSER: true }))

const mockListen = vi.fn(() => Promise.resolve(() => {}))
vi.mock('@tauri-apps/api/event', () => ({ listen: mockListen }))

const mockPlatform = vi.fn(() => 'windows')

const mockOpen = vi.fn()
vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: mockOpen,
}))

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

describe('tauri runtime helpers', () => {
  function setTauri(on: boolean) {
    if (on)
      globalThis.__TAURI_INTERNALS__ = {}
    else
      delete globalThis.__TAURI_INTERNALS__
  }

  beforeEach(() => {
    localStorageMock.clear()
    document.cookie = ''
  })

  afterEach(() => {
    vi.clearAllMocks()
    delete globalThis.__TAURI_INTERNALS__
  })

  describe('isTauri', () => {
    it('should be true when __TAURI_INTERNALS__ is present', () => {
      setTauri(true)
      expect(tauriHelpers.isTauri()).toBe(true)
    })

    it('should be false when not in a Tauri environment', () => {
      setTauri(false)
      expect(tauriHelpers.isTauri()).toBe(false)
    })
  })

  describe('with Tauri environment', () => {
    beforeEach(() => {
      setTauri(true)
    })

    describe('signInWithTauri', () => {
      it('should open the correct auth URL on desktop', async () => {
        mockPlatform.mockReturnValue('windows')
        await tauriHelpers.signInWithTauri('github', 'http://localhost:3000/api/auth', 'gau')
        expect(mockOpen).toHaveBeenCalledWith('http://localhost:3000/api/auth/github?redirectTo=gau%3A%2F%2Foauth%2Fcallback')
      })

      it('should default to scheme redirect when override omitted', async () => {
        mockPlatform.mockReturnValue('windows')
        await tauriHelpers.signInWithTauri('google', 'http://localhost:3000/api/auth', 'gau', undefined)
        expect(mockOpen).toHaveBeenCalledWith('http://localhost:3000/api/auth/google?redirectTo=gau%3A%2F%2Foauth%2Fcallback')
      })

      it('should use redirectOverride if provided', async () => {
        mockPlatform.mockReturnValue('windows')
        await tauriHelpers.signInWithTauri('github', 'http://localhost:3000/api/auth', 'gau', 'myapp://custom')
        expect(mockOpen).toHaveBeenCalledWith('http://localhost:3000/api/auth/github?redirectTo=myapp%3A%2F%2Fcustom')
      })

      it('should use custom scheme for redirect on mobile platforms', async () => {
        mockPlatform.mockReturnValue('android')
        await tauriHelpers.signInWithTauri('google', 'https://server.com/api/auth')
        expect(mockOpen).toHaveBeenCalledWith('https://server.com/api/auth/google?redirectTo=gau%3A%2F%2Foauth%2Fcallback')
      })
    })

    describe('linkAccountWithTauri', () => {
      it('should not open URL if session token is missing', async () => {
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        await tauriHelpers.linkAccountWithTauri('github', 'http://localhost:3000/api/auth')
        expect(mockOpen).not.toHaveBeenCalled()
        expect(consoleSpy).toHaveBeenCalledWith('No session token found, cannot link account.')
        consoleSpy.mockRestore()
      })

      it('should open the correct link URL on desktop', async () => {
        localStorageMock.setItem('gau-token', 'test-session-token')
        mockPlatform.mockReturnValue('windows')
        await tauriHelpers.linkAccountWithTauri('github', 'http://localhost:3000/api/auth', 'gau')
        const expectedUrl = 'http://localhost:3000/api/auth/link/github?redirectTo=gau%3A%2F%2Foauth%2Fcallback&token=test-session-token'
        expect(mockOpen).toHaveBeenCalledWith(expectedUrl)
      })

      it('should default to scheme redirect when override omitted', async () => {
        localStorageMock.setItem('gau-token', 'test-session-token')
        mockPlatform.mockReturnValue('windows')
        await tauriHelpers.linkAccountWithTauri('google', 'http://localhost:3000/api/auth', 'gau', undefined)
        const expectedUrl = 'http://localhost:3000/api/auth/link/google?redirectTo=gau%3A%2F%2Foauth%2Fcallback&token=test-session-token'
        expect(mockOpen).toHaveBeenCalledWith(expectedUrl)
      })

      it('should use redirectOverride if provided', async () => {
        localStorageMock.setItem('gau-token', 'test-session-token')
        mockPlatform.mockReturnValue('windows')
        await tauriHelpers.linkAccountWithTauri('github', 'http://localhost:3000/api/auth', 'gau', 'myapp://custom')
        const expectedUrl = 'http://localhost:3000/api/auth/link/github?redirectTo=myapp%3A%2F%2Fcustom&token=test-session-token'
        expect(mockOpen).toHaveBeenCalledWith(expectedUrl)
      })

      it('should use custom scheme for redirect on mobile platforms', async () => {
        localStorageMock.setItem('gau-token', 'test-session-token')
        mockPlatform.mockReturnValue('android')
        await tauriHelpers.linkAccountWithTauri('google', 'https://server.com/api/auth')
        const expectedUrl = 'https://server.com/api/auth/link/google?redirectTo=gau%3A%2F%2Foauth%2Fcallback&token=test-session-token'
        expect(mockOpen).toHaveBeenCalledWith(expectedUrl)
      })
    })

    describe('setupTauriListener', () => {
      it('should set up a listener for deep-links', async () => {
        const handler = vi.fn()
        await tauriHelpers.setupTauriListener(handler)
        expect(mockListen).toHaveBeenCalledWith('deep-link', expect.any(Function))
      })
    })

    describe('relative baseUrl resolution', () => {
      let originalWindow: any
      beforeEach(() => {
        originalWindow = globalThis.window
        ;(globalThis as any).window = { location: { origin: 'http://localhost:4444' } }
      })
      afterEach(() => {
        ;(globalThis as any).window = originalWindow
      })

      it('signInWithTauri resolves relative baseUrl against window.location.origin', async () => {
        mockPlatform.mockReturnValue('windows')
        await tauriHelpers.signInWithTauri('github', '/api/auth', 'gau')
        expect(mockOpen).toHaveBeenCalledWith('http://localhost:4444/api/auth/github?redirectTo=gau%3A%2F%2Foauth%2Fcallback')
      })

      it('linkAccountWithTauri resolves relative baseUrl and includes token', async () => {
        localStorageMock.setItem('gau-token', 'test-session-token')
        mockPlatform.mockReturnValue('windows')
        await tauriHelpers.linkAccountWithTauri('google', '/api/auth', 'gau')
        expect(mockOpen).toHaveBeenCalledWith('http://localhost:4444/api/auth/link/google?redirectTo=gau%3A%2F%2Foauth%2Fcallback&token=test-session-token')
      })
    })

    describe('handleTauriDeepLink', () => {
      it('should call onToken with the token from a custom scheme URL', () => {
        const onToken = vi.fn()
        const url = 'gau://oauth/callback#token=test-token'
        tauriHelpers.handleTauriDeepLink(url, 'http://localhost:3000', 'gau', onToken)
        expect(onToken).toHaveBeenCalledWith('test-token')
      })

      it('should call onToken with the token from a base URL origin', () => {
        const onToken = vi.fn()
        const url = 'http://localhost:3000/#token=test-token-2'
        tauriHelpers.handleTauriDeepLink(url, 'http://localhost:3000', 'gau', onToken)
        expect(onToken).toHaveBeenCalledWith('test-token-2')
      })

      it('should not call onToken for an invalid URL', () => {
        const onToken = vi.fn()
        const url = 'http://another-site.com/#token=bad-token'
        tauriHelpers.handleTauriDeepLink(url, 'http://localhost:3000', 'gau', onToken)
        expect(onToken).not.toHaveBeenCalled()
      })
    })
  })

  describe('without Tauri environment', () => {
    beforeEach(() => {
      delete globalThis.__TAURI_INTERNALS__
    })

    it('signInWithTauri should not do anything', async () => {
      await tauriHelpers.signInWithTauri('github', 'http://localhost:3000')
      expect(mockOpen).not.toHaveBeenCalled()
    })

    it('setupTauriListener should not do anything', async () => {
      await tauriHelpers.setupTauriListener(vi.fn())
      expect(mockListen).not.toHaveBeenCalled()
    })
  })
})
