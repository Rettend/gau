import type { EmailProvider } from '../email'
import type { OAuthProvider } from '../oauth'

export type AuthProvider = OAuthProvider | EmailProvider

export function isEmailProvider(provider: AuthProvider): provider is EmailProvider {
  return 'type' in provider && provider.type === 'email'
}
