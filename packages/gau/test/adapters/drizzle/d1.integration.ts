import type { Adapter } from '../../../src/core'
import assert from 'node:assert/strict'
import { Miniflare } from 'miniflare'
import { drizzle } from 'drizzle-orm/d1'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { DrizzleAdapter } from '../../../src/adapters/drizzle'

const users = sqliteTable('users', {
  id: text().primaryKey(),
  name: text(),
  email: text().unique(),
  image: text(),
  emailVerified: integer({ mode: 'boolean' }),
  role: text(),
  createdAt: integer({ mode: 'timestamp' }).notNull(),
  updatedAt: integer({ mode: 'timestamp' }).notNull(),
})

const accounts = sqliteTable('accounts', {
  userId: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
  provider: text().notNull(),
  providerAccountId: text().notNull(),
  type: text(),
  refreshToken: text(),
  accessToken: text(),
  expiresAt: integer(),
  tokenType: text(),
  scope: text(),
  idToken: text(),
})

const miniflare = new Miniflare({
  compatibilityDate: '2026-01-14',
  modules: true,
  script: 'export default { fetch() { return new Response("ok") } }',
  d1Databases: ['DB'],
})

try {
  const d1 = await miniflare.getD1Database('DB')
  await resetDatabase(d1)
  const adapter = DrizzleAdapter(
    drizzle(d1 as any, { casing: 'snake_case' }) as any,
    users as any,
    accounts as any,
  )

  await verifyAdapter(adapter)
}
finally {
  await miniflare.dispose()
}

async function resetDatabase(d1: Awaited<ReturnType<Miniflare['getD1Database']>>) {
  await d1.exec('DROP TABLE IF EXISTS accounts;')
  await d1.exec('DROP TABLE IF EXISTS users;')
  await d1.exec('CREATE TABLE users (id text PRIMARY KEY NOT NULL, name text, email text UNIQUE, image text, email_verified integer, role text, created_at integer NOT NULL, updated_at integer NOT NULL);')
  await d1.exec('CREATE TABLE accounts (user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE, provider text NOT NULL, provider_account_id text NOT NULL, type text, refresh_token text, access_token text, expires_at integer, token_type text, scope text, id_token text);')
}

async function verifyAdapter(adapter: Adapter) {
  const created = await adapter.createUser({
    id: 'user-d1',
    email: 'd1@example.com',
    emailVerified: true,
    role: 'admin',
  })

  assert.equal(created.id, 'user-d1')
  assert.equal(created.email, 'd1@example.com')
  assert.equal(created.emailVerified, true)
  assert.equal(created.role, 'admin')
  assert.ok((created as any).createdAt instanceof Date)
  assert.ok((created as any).updatedAt instanceof Date)

  const updated = await adapter.updateUser({
    id: created.id,
    name: 'Updated',
    emailVerified: false,
  })

  assert.equal(updated.name, 'Updated')
  assert.equal(updated.email, created.email)
  assert.equal(updated.emailVerified, false)
  assert.ok((updated as any).updatedAt instanceof Date)

  await assert.rejects(
    adapter.updateUser({ id: 'missing-user', name: 'Missing' }),
    /User not found/,
  )
}
