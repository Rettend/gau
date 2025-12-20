import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Microsoft } from '../../../src/oauth/providers/microsoft'

const mockUser = { id: 'user-id-123', displayName: 'Test User', mail: 'fallback@example.com', userPrincipalName: 'upn@example.com' }
const mockPhotoBlob = new Blob(['photo-data'], { type: 'image/jpeg' })

let mockIdToken: (() => string | null) | null = null

const mockTokens = {
  accessToken: () => 'test_access_token',
  accessTokenExpiresAt: () => new Date(Date.now() + 3600 * 1000),
  refreshToken: () => 'test_refresh_token',
  idToken: () => mockIdToken?.() ?? null,
}

vi.mock('arctic', async (importOriginal) => {
  const original = await importOriginal<typeof import('arctic')>()
  return {
    ...original,
    OAuth2Client: vi.fn(class {
      createAuthorizationURLWithPKCE = vi.fn((authURL: string) => {
        const u = new URL(authURL)
        u.searchParams.set('mock', 'true')
        return u
      })

      validateAuthorizationCode = vi.fn(() => Promise.resolve(mockTokens))
    }),
  }
})

describe('microsoft Provider', () => {
  const provider = Microsoft({
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
  })

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('graph.microsoft.com/v1.0/me/photo'))
        return Promise.resolve(new Response(mockPhotoBlob))

      if (url.includes('graph.microsoft.com/v1.0/me')) {
        return Promise.resolve(new Response(JSON.stringify(mockUser), {
          headers: { 'Content-Type': 'application/json' },
        }))
      }
      return Promise.reject(new Error(`Unhandled fetch mock for ${url}`))
    }))

    vi.stubGlobal('FileReader', class {
      result: string | null = null
      onloadend: (() => void) | null = null
      onerror: ((err: any) => void) | null = null
      readAsDataURL(_blob: Blob) {
        this.result = 'data:image/jpeg;base64,cGhvdG8tZGF0YQ=='
        queueMicrotask(() => this.onloadend?.())
      }
    })
  })

  afterEach(() => {
    mockIdToken = null
    vi.restoreAllMocks()
  })

  function b64(payload: object): string {
    const json = JSON.stringify(payload)
    return btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
  }

  it('should create an authorization URL', async () => {
    const url = await provider.getAuthorizationUrl('state', 'code-verifier')
    expect(url.toString()).toContain('https://login.microsoftonline.com/common/oauth2/v2.0/authorize')
    expect(url.toString()).toContain('mock=true')
  })

  it('applies prompt and params and tenant overrides in authorization URL', async () => {
    const url = await provider.getAuthorizationUrl('state', 'cv', {
      params: { prompt: 'login', foo: 'bar' },
      overrides: { tenant: 'organizations' },
    } as any)
    expect(url.toString()).toContain('/organizations/oauth2/v2.0/authorize')
    expect(url.searchParams.get('prompt')).toBe('login')
    expect(url.searchParams.get('foo')).toBe('bar')
  })

  describe('validateCallback', () => {
    it('should use `verified_primary_email` (string) for work/school accounts', async () => {
      mockIdToken = () => `h.${b64({ verified_primary_email: 'work@example.com' })}.s`
      const { user } = await provider.validateCallback('code', 'code-verifier')
      expect(user.email).toBe('work@example.com')
      expect(user.emailVerified).toBe(true)
    })

    it('should use `verified_primary_email` (array) for work/school accounts', async () => {
      mockIdToken = () => `h.${b64({ verified_primary_email: ['work-array@example.com', 'other@example.com'] })}.s`
      const { user } = await provider.validateCallback('code', 'code-verifier')
      expect(user.email).toBe('work-array@example.com')
      expect(user.emailVerified).toBe(true)
    })

    it('should use `email` for personal accounts based on `tid`', async () => {
      const personalTenantId = '9188040d-6c67-4c5b-b112-36a304b66dad'
      mockIdToken = () => `h.${b64({ tid: personalTenantId, email: 'personal@example.com' })}.s`
      const { user } = await provider.validateCallback('code', 'code-verifier')
      expect(user.email).toBe('personal@example.com')
      expect(user.emailVerified).toBe(true)
    })

    it('should use legacy `xms_edov` for email verification', async () => {
      mockIdToken = () => `h.${b64({ xms_edov: true, email: 'legacy-verified@example.com' })}.s`
      const { user } = await provider.validateCallback('code', 'code-verifier')
      expect(user.email).toBe('legacy-verified@example.com')
      expect(user.emailVerified).toBe(true)
    })

    it('should fall back to user profile email if `idToken` has no verified email', async () => {
      mockIdToken = () => `h.${b64({ some_claim: 'value' })}.s`
      const { user } = await provider.validateCallback('code', 'code-verifier')
      expect(user.email).toBe('fallback@example.com') // from mockUser.mail
      expect(user.emailVerified).toBe(false)
    })

    it('should fall back to user profile email if no `idToken` is provided', async () => {
      mockIdToken = () => null
      const { user } = await provider.validateCallback('code', 'code-verifier')
      expect(user.email).toBe('fallback@example.com') // from mockUser.mail
      expect(user.emailVerified).toBe(false)
    })

    it('should return basic user info and avatar', async () => {
      mockIdToken = () => null
      const { user, tokens } = await provider.validateCallback('code', 'code-verifier')
      expect(tokens.accessToken()).toBe('test_access_token')
      expect(user.id).toBe('user-id-123')
      expect(user.name).toBe('Test User')
      expect(user.avatar).toContain('data:image/jpeg;base64')
      expect(user.raw).toEqual(mockUser)
    })
  })
})
