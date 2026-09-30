import process from 'node:process'
import { createAuth } from '@rttnd/gau'
import { MemoryAdapter } from '@rttnd/gau/adapters/memory'
import { Discord, Facebook, GitHub, Google, Microsoft } from '@rttnd/gau/oauth'
import { MarkoRunAuth } from '@rttnd/gau/marko-run'

const auth = createAuth({
  adapter: MemoryAdapter(),
  errorRedirect: '/auth/error',
  providers: [
    GitHub({
      clientId: process.env.AUTH_GITHUB_ID ?? '',
      clientSecret: process.env.AUTH_GITHUB_SECRET ?? '',
    }),
    Google({ clientId: process.env.AUTH_GOOGLE_ID ?? '', clientSecret: process.env.AUTH_GOOGLE_SECRET ?? '' }),
    Microsoft({ clientId: process.env.AUTH_MICROSOFT_ID ?? '', clientSecret: process.env.AUTH_MICROSOFT_SECRET ?? '' }),
    Facebook({ clientId: process.env.AUTH_FACEBOOK_ID ?? '', clientSecret: process.env.AUTH_FACEBOOK_SECRET ?? '' }),
    Discord({ clientId: process.env.AUTH_DISCORD_ID ?? '', clientSecret: process.env.AUTH_DISCORD_SECRET ?? '' }),
  ],
  jwt: {
    secret: process.env.AUTH_SECRET ?? (import.meta.env.DEV ? 'local-example-secret-change-before-deploying' : ''),
  },
})
export const gau = MarkoRunAuth(auth)
