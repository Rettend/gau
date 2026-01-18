import { query } from '@solidjs/router'
import { getRequestEvent } from 'solid-js/web'

export const getSession = query(async () => {
  'use server'
  const event = getRequestEvent()
  const session = await event?.locals.getSession()
  // eslint-disable-next-line no-console
  console.log('server session', session)
  return session
}, 'session')
