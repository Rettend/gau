import { query } from '@solidjs/router'
import { getRequestEvent } from 'solid-js/web'

export const getSession = query(async () => {
  'use server'
  const event = getRequestEvent()
  const session = await event?.locals.getSession()
  return session
}, 'session')
