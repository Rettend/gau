import { query } from '@solidjs/router'
import { getRequestEvent } from '@solidjs/web'

export const getSession = query(async () => {
  'use server'
  const event = getRequestEvent()
  return event!.locals.getSession()
}, 'session')
