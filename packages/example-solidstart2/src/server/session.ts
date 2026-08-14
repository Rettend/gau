import type { GauSession, ProviderIds } from '@rttnd/gau'
import { query } from '@solidjs/router'
import { getRequestEvent } from '@solidjs/web'
import type { Auth } from './auth'

export const getSession = query(async (): Promise<GauSession<ProviderIds<Auth>>> => {
  'use server'
  const event = getRequestEvent()
  if (!event)
    throw new Error('Missing request event')
  return event.locals.getSession()
}, 'session')
