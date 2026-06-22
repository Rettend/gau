import { createAuth } from '@rttnd/gau'
import { DrizzleAdapter } from '@rttnd/gau/adapters/drizzle'
import { GitHub, Google, Microsoft } from '@rttnd/gau/oauth'
import { serverEnv } from '~/env/server'
import { db } from './db'
import { Accounts, Users } from './db/schema'

export const auth = createAuth({
  adapter: DrizzleAdapter(db, Users, Accounts),
  providers: [
    GitHub({
      clientId: serverEnv.AUTH_GITHUB_ID,
      clientSecret: serverEnv.AUTH_GITHUB_SECRET,
    }),
    Google({
      clientId: serverEnv.AUTH_GOOGLE_ID,
      clientSecret: serverEnv.AUTH_GOOGLE_SECRET,
    }),
    Microsoft({
      clientId: serverEnv.AUTH_MICROSOFT_ID,
      clientSecret: serverEnv.AUTH_MICROSOFT_SECRET,
    }),
  ],
  jwt: {
    secret: serverEnv.AUTH_SECRET,
  },
})

export type Auth = typeof auth
