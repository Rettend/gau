import { command, getRequestEvent } from '$app/server'
import { env as publicEnv } from '$env/dynamic/public'
import { auth } from '$lib/server/auth'

const OFFLINE_DEMO_EMAIL = 'offline-demo@gau.local'
const OFFLINE_DEMO_NAME = 'Offline Demo'
const OFFLINE_DEMO_TTL = 60 * 60 * 24 * 7

export const offlineDemoLogin = command(async () => {
  if (publicEnv.PUBLIC_ENABLE_OFFLINE_DEMO_LOGIN !== 'true') {
    return {
      success: false as const,
      error: 'Offline demo login is disabled.',
    }
  }

  const { cookies } = getRequestEvent()

  let user = await auth.getUserByEmail(OFFLINE_DEMO_EMAIL)

  if (!user) {
    user = await auth.createUser({
      name: OFFLINE_DEMO_NAME,
      email: OFFLINE_DEMO_EMAIL,
      emailVerified: true,
    })
  }

  const { token, cookieName, maxAge } = await auth.issueSession(user.id, {
    data: { isOfflineDemo: true },
    ttl: OFFLINE_DEMO_TTL,
  })

  cookies.set(cookieName, token, {
    path: auth.cookieOptions.path ?? '/',
    httpOnly: auth.cookieOptions.httpOnly ?? true,
    secure: auth.cookieOptions.secure ?? true,
    sameSite: auth.cookieOptions.sameSite ?? 'lax',
    maxAge,
  })

  return { success: true as const }
})
