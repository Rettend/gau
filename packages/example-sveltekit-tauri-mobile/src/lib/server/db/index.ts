import { serverEnv } from '$lib/env/server'
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'

const client = createClient({
  url: serverEnv.TURSO_DB_URL,
  authToken: serverEnv.TURSO_AUTH_TOKEN,
})

export const db = drizzle({ client })
