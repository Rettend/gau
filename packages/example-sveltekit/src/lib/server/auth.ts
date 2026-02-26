import * as env from '$env/static/private'
import { createAuth } from '@rttnd/gau'
import { DrizzleAdapter } from '@rttnd/gau/adapters/drizzle'
import { Discord, Facebook, GitHub, Google, Microsoft } from '@rttnd/gau/oauth'
import { db } from './db'
import { Accounts, Users } from './db/schema'

export const auth = createAuth({
  adapter: DrizzleAdapter(db, Users, Accounts),
  providers: [
    GitHub({
      clientId: env.AUTH_GITHUB_ID,
      clientSecret: env.AUTH_GITHUB_SECRET,
    }),
    Google({
      clientId: env.AUTH_GOOGLE_ID,
      clientSecret: env.AUTH_GOOGLE_SECRET,
    }),
    Microsoft({
      clientId: env.AUTH_MICROSOFT_ID,
      clientSecret: env.AUTH_MICROSOFT_SECRET,
    }),
    Facebook({
      clientId: env.AUTH_FACEBOOK_ID,
      clientSecret: env.AUTH_FACEBOOK_SECRET,
    }),
    Discord({
      clientId: env.AUTH_DISCORD_ID,
      clientSecret: env.AUTH_DISCORD_SECRET,
    }),
  ],
  jwt: {
    secret: env.AUTH_SECRET,
  },
  trustHosts: 'all',
  roles: {
    adminRoles: ['admin'],
  },
  impersonation: {
    enabled: true,
    onImpersonate: ({ adminUserId, targetUserId, reason }) => {
      // eslint-disable-next-line no-console
      console.log(`[IMPERSONATION] ${adminUserId} → ${targetUserId} (reason: ${reason ?? 'none'})`)
    },
  },
})

export type Auth = typeof auth
