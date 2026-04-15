import { describe, expect, it, vi } from 'vitest'
import { createSharedAuthFlow } from '../../src/client/shared/authFlow'

describe('shared auth flow', () => {
  it('signIn falls back to origin and navigates in browser mode', async () => {
    const signIn = vi.fn().mockResolvedValue('https://auth.test/github')
    const navigate = vi.fn()
    const flow = createSharedAuthFlow({
      client: {
        signIn,
        linkAccount: vi.fn(),
        handleRedirectCallback: vi.fn(),
      } as any,
      isBrowser: true,
      isTauri: false,
      getOrigin: () => 'https://app.test',
      getHref: () => 'https://app.test/current',
      navigate,
    })

    await flow.signIn('github')

    expect(signIn).toHaveBeenCalledWith('github', { redirectTo: 'https://app.test', profile: undefined })
    expect(navigate).toHaveBeenCalledWith('https://auth.test/github')
  })

  it('linkAccount uses default redirect when provided and does not navigate in Tauri mode', async () => {
    const linkAccount = vi.fn().mockResolvedValue('https://auth.test/link')
    const navigate = vi.fn()
    const flow = createSharedAuthFlow({
      client: {
        signIn: vi.fn(),
        linkAccount,
        handleRedirectCallback: vi.fn(),
      } as any,
      defaultRedirectTo: 'https://default.test/redirect',
      isBrowser: true,
      isTauri: true,
      getOrigin: () => 'https://app.test',
      getHref: () => 'https://app.test/current',
      navigate,
    })

    await flow.linkAccount('github', { redirectTo: undefined, profile: 'work' })

    expect(linkAccount).toHaveBeenCalledWith('github', { redirectTo: 'https://default.test/redirect', profile: 'work' })
    expect(navigate).not.toHaveBeenCalled()
  })

  it('linkAccount falls back to current href when no redirect defaults are provided', async () => {
    const linkAccount = vi.fn().mockResolvedValue('https://auth.test/link')
    const navigate = vi.fn()
    const flow = createSharedAuthFlow({
      client: {
        signIn: vi.fn(),
        linkAccount,
        handleRedirectCallback: vi.fn(),
      } as any,
      isBrowser: true,
      isTauri: false,
      getOrigin: () => 'https://app.test',
      getHref: () => 'https://app.test/current',
      navigate,
    })

    await flow.linkAccount('github')

    expect(linkAccount).toHaveBeenCalledWith('github', { redirectTo: 'https://app.test/current', profile: undefined })
    expect(navigate).toHaveBeenCalledWith('https://auth.test/link')
  })

  it('delegates handled redirect callbacks to the client without an extra refresh', async () => {
    const replaceUrl = vi.fn()
    const flow = createSharedAuthFlow({
      client: {
        signIn: vi.fn(),
        linkAccount: vi.fn(),
        handleRedirectCallback: vi.fn().mockResolvedValue(true),
      } as any,
      isBrowser: true,
      isTauri: false,
      getOrigin: () => 'https://app.test',
      getHref: () => 'https://app.test/current',
      navigate: vi.fn(),
      replaceUrl,
    })

    await expect(flow.handleRedirectCallback()).resolves.toBe(true)

    expect(replaceUrl).toHaveBeenCalledTimes(0)
  })
})
