import process from 'node:process'
import { MemoryAdapter } from '@rttnd/gau/adapters/memory'
import { createAuth } from '@rttnd/gau/core'
import { GitHub, Google } from '@rttnd/gau/oauth'

export const auth = createAuth({
  adapter: MemoryAdapter(),
  errorRedirect: '/auth/error',
  providers: [
    GitHub({
      clientId: process.env.AUTH_GITHUB_ID!,
      clientSecret: process.env.AUTH_GITHUB_SECRET!,
    }),
    Google({
      clientId: process.env.AUTH_GOOGLE_ID!,
      clientSecret: process.env.AUTH_GOOGLE_SECRET!,
    }),
  ],
  jwt: {
    secret: process.env.AUTH_SECRET!,
  },
  trustHosts: 'all',
})

export type Auth = typeof auth
