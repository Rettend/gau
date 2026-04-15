import type { ProfileName, ProviderIds } from '../../core'

interface SharedAuthClient<TAuth = unknown> {
  signIn: <P extends ProviderIds<TAuth>, PR extends (ProfileName<TAuth, P> | string) | undefined>(provider: P, options?: { redirectTo?: string, profile?: PR }) => Promise<string>
  linkAccount: <P extends ProviderIds<TAuth>, PR extends (ProfileName<TAuth, P> | string) | undefined>(provider: P, options?: { redirectTo?: string, profile?: PR }) => Promise<string>
  handleRedirectCallback: (replaceUrl?: (url: string) => void | Promise<void>) => Promise<boolean>
}

interface SharedAuthFlowOptions<TAuth = unknown> {
  client: SharedAuthClient<TAuth>
  defaultRedirectTo?: string
  isBrowser: boolean
  isTauri: boolean
  getOrigin: () => string
  getHref: () => string
  navigate: (url: string) => void
  replaceUrl?: (url: string) => void | Promise<void>
}

export function createSharedAuthFlow<const TAuth = unknown>({
  client,
  defaultRedirectTo,
  isBrowser,
  isTauri,
  getOrigin,
  getHref,
  navigate,
  replaceUrl,
}: SharedAuthFlowOptions<TAuth>) {
  async function signIn<P extends ProviderIds<TAuth>>(provider: P, { redirectTo, profile }: { redirectTo?: string, profile?: ProfileName<TAuth, P> } = {}) {
    let finalRedirectTo = redirectTo ?? defaultRedirectTo
    if (!finalRedirectTo && isBrowser)
      finalRedirectTo = getOrigin()

    const url = await client.signIn<P, typeof profile>(provider, { redirectTo: finalRedirectTo, profile })
    if (isBrowser && !isTauri)
      navigate(url)
  }

  async function linkAccount<P extends ProviderIds<TAuth>>(provider: P, { redirectTo, profile }: { redirectTo?: string, profile?: ProfileName<TAuth, P> } = {}) {
    let finalRedirectTo = redirectTo ?? defaultRedirectTo
    if (!finalRedirectTo && isBrowser)
      finalRedirectTo = getHref()

    const url = await client.linkAccount<P, typeof profile>(provider, { redirectTo: finalRedirectTo, profile })
    if (isBrowser && !isTauri)
      navigate(url)
  }

  async function handleRedirectCallback() {
    return await client.handleRedirectCallback(replaceUrl)
  }

  return {
    signIn,
    linkAccount,
    handleRedirectCallback,
  }
}
