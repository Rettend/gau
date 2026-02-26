import { command, getRequestEvent, query } from '$app/server'
import { auth } from '$lib/server/auth'
import { db } from '$lib/server/db'
import { Users } from '$lib/server/db/schema'
import { SESSION_COOKIE_NAME, SESSION_STASH_COOKIE_NAME } from '@rttnd/gau'
import { error } from '@sveltejs/kit'
import { eq, ne } from 'drizzle-orm'
import { z } from 'zod'

/**
 * Get list of users for impersonation targets
 */
export const getUsers = query(async () => {
  const { locals } = getRequestEvent()
  const session = await locals.getSession()

  if (!session?.user)
    error(401, 'Not authenticated')

  return await db
    .select({ id: Users.id, name: Users.name, email: Users.email, role: Users.role })
    .from(Users)
    .where(ne(Users.id, session.user.id))
})

/**
 * Toggle your own role between 'user' and 'admin' for testing
 */
export const toggleRole = command(async () => {
  const { locals } = getRequestEvent()
  const session = await locals.getSession()

  if (!session?.user)
    error(401, 'Not authenticated')

  const currentRole = session.user.role ?? 'user'
  const newRole = currentRole === 'admin' ? 'user' : 'admin'

  await db.update(Users).set({ role: newRole }).where(eq(Users.id, session.user.id))

  return { success: true, role: newRole }
})

/**
 * Start impersonating a target user
 */
export const startImpersonation = command(
  z.object({
    targetUserId: z.string(),
    reason: z.string().optional(),
  }),
  async ({ targetUserId, reason }) => {
    const { cookies, locals } = getRequestEvent()
    const session = await locals.getSession()

    if (!session?.user?.isAdmin)
      error(403, 'Forbidden')

    const result = await auth.startImpersonation(session.user.id, targetUserId, {
      reason,
      ttl: 60 * 30, // 30 minutes
    })

    if (!result)
      error(500, 'Impersonation failed')

    cookies.set(SESSION_COOKIE_NAME, result.token, {
      path: auth.cookieOptions.path ?? '/',
      httpOnly: auth.cookieOptions.httpOnly ?? true,
      secure: auth.cookieOptions.secure ?? true,
      sameSite: auth.cookieOptions.sameSite ?? 'lax',
      maxAge: result.maxAge,
    })

    const stashMatch = result.originalCookie.match(/([^=]+)=([^;]+)/)
    if (stashMatch && stashMatch[1] === SESSION_STASH_COOKIE_NAME) {
      cookies.set(SESSION_STASH_COOKIE_NAME, stashMatch[2], {
        path: '/',
        httpOnly: true,
        secure: auth.cookieOptions.secure ?? true,
        sameSite: 'lax',
        maxAge: result.maxAge,
      })
    }

    return { success: true }
  },
)

/**
 * End impersonation and restore admin session
 */
export const endImpersonation = command(async () => {
  const { cookies, request } = getRequestEvent()

  const result = await auth.endImpersonation(request)

  if (!result)
    error(400, 'No active impersonation')

  cookies.set(SESSION_COOKIE_NAME, result.token, {
    path: auth.cookieOptions.path ?? '/',
    httpOnly: auth.cookieOptions.httpOnly ?? true,
    secure: auth.cookieOptions.secure ?? true,
    sameSite: auth.cookieOptions.sameSite ?? 'lax',
    maxAge: auth.jwt.ttl,
  })

  cookies.delete(SESSION_STASH_COOKIE_NAME, { path: '/' })

  return { success: true }
})
