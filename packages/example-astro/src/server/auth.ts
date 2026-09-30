import { createAuth } from '@rttnd/gau'
import { MemoryAdapter } from '@rttnd/gau/adapters/memory'
import { Discord, Facebook, GitHub, Google, Microsoft } from '@rttnd/gau/oauth'
import { AstroAuth } from '@rttnd/gau/astro'

export const auth = createAuth({
  adapter: MemoryAdapter(),
  errorRedirect: '/auth/error',
  providers: [
    GitHub({
      clientId: import.meta.env.AUTH_GITHUB_ID ?? '',
      clientSecret: import.meta.env.AUTH_GITHUB_SECRET ?? '',
    }),
    Google({ clientId: import.meta.env.AUTH_GOOGLE_ID ?? '', clientSecret: import.meta.env.AUTH_GOOGLE_SECRET ?? '' }),
    Microsoft({
      clientId: import.meta.env.AUTH_MICROSOFT_ID ?? '',
      clientSecret: import.meta.env.AUTH_MICROSOFT_SECRET ?? '',
    }),
    Facebook({
      clientId: import.meta.env.AUTH_FACEBOOK_ID ?? '',
      clientSecret: import.meta.env.AUTH_FACEBOOK_SECRET ?? '',
    }),
    Discord({
      clientId: import.meta.env.AUTH_DISCORD_ID ?? '',
      clientSecret: import.meta.env.AUTH_DISCORD_SECRET ?? '',
    }),
  ],
  jwt: {
    secret: import.meta.env.AUTH_SECRET ?? (import.meta.env.DEV ? 'local-example-secret-change-before-deploying' : ''),
  },
})
export const gau = AstroAuth(auth)
