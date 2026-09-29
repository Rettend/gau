import type { ProfileName, ProviderIds } from '../../core'
import { randomSecret, sha256 } from '../../email/crypto'

export interface EmailStartOptions {
  email: string
  redirectTo?: string
  challengeId?: never
  code?: never
}

export interface EmailVerifyOptions {
  challengeId: string
  code: string
  email?: never
}

export interface EmailChallengeResult {
  status: 'verification-required'
  challengeId: string
  expiresAt: number
  retryAfter: number
}

export interface EmailAuthenticatedResult {
  status: 'authenticated'
}

export type EmailOptions = EmailStartOptions | EmailVerifyOptions
export type EmailResult<O extends EmailOptions> = O extends EmailStartOptions
  ? EmailChallengeResult
  : EmailAuthenticatedResult
export type EmailProviderId<T> = 'email' extends ProviderIds<T> ? 'email' : never
export type OAuthProviderIds<T> = Exclude<ProviderIds<T>, 'email'>

export interface AuthAction<T, R> {
  <O extends EmailOptions>(provider: EmailProviderId<T>, options: O): Promise<EmailResult<O>>
  <P extends OAuthProviderIds<T>, PR extends (ProfileName<T, P> | string) | undefined = undefined>(
    provider: P,
    options?: { redirectTo?: string; profile?: PR },
  ): Promise<R>
}

/** Proof stays in the initiating client, including across page reloads. */
export function createEmailFlow(baseUrl: string) {
  const proofs = new Map<string, string>()
  const storageKey = (id: string) => `gau:email:${baseUrl}:${id}`
  return {
    async start() {
      const verifier = randomSecret()
      return { verifier, clientChallenge: await sha256(verifier) }
    },
    save(id: string, verifier: string) {
      proofs.set(id, verifier)
      try {
        sessionStorage.setItem(storageKey(id), verifier)
      } catch {}
    },
    get(id: string) {
      let verifier = proofs.get(id)
      try {
        verifier ??= sessionStorage.getItem(storageKey(id)) ?? undefined
      } catch {}
      if (!verifier) throw new Error('Request a new email in this browser before entering a code.')
      return verifier
    },
    clear(id: string) {
      proofs.delete(id)
      try {
        sessionStorage.removeItem(storageKey(id))
      } catch {}
    },
  }
}
