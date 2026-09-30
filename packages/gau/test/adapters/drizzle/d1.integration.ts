import type { Adapter } from '../../../src/core'
import assert from 'node:assert/strict'
import { Miniflare } from 'miniflare'
import { drizzle } from 'drizzle-orm/d1'
import { integer, snakeCase, text } from 'drizzle-orm/sqlite-core'
import { DrizzleAdapter } from '../../../src/adapters/drizzle'

const users = snakeCase.table('users', {
  id: text().primaryKey(),
  name: text(),
  email: text().unique(),
  image: text(),
  emailVerified: integer({ mode: 'boolean' }),
  role: text(),
  nickname: text().default('New user'),
  createdAt: integer({ mode: 'timestamp' }).notNull(),
  updatedAt: integer({ mode: 'timestamp' }).notNull(),
})

const accounts = snakeCase.table('accounts', {
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

const verification = snakeCase.table('verification', {
  id: text().primaryKey(),
  value: text().notNull(),
  expiresAt: integer().notNull(),
  version: integer().notNull(),
})

try {
  const d1 = await miniflare.getD1Database('DB')
  await resetDatabase(d1)
  const adapter = DrizzleAdapter(drizzle(d1), users, accounts, verification)

  await verifyAdapter(adapter)
  const store = adapter.verification!
  const record = { id: 'challenge', value: 'pending', expiresAt: Date.now() + 600000, version: 0 }
  assert.equal(await store.set(record, null), true)
  assert.equal(await store.set(record, null), false)
  const updates = await Promise.all(Array.from({ length: 4 }, () => store.set({ ...record, value: 'used', version: 1 }, 0)))
  assert.equal(updates.filter(Boolean).length, 1)
  assert.equal((await store.get('challenge'))?.value, 'used')
  await store.deleteExpired(record.expiresAt)
  assert.equal(await store.get('challenge'), null)
}
finally {
  await miniflare.dispose()
}

async function resetDatabase(d1: Awaited<ReturnType<Miniflare['getD1Database']>>) {
  await d1.exec('CREATE TABLE verification (id text PRIMARY KEY, value text NOT NULL, expires_at integer NOT NULL, version integer NOT NULL);')
  await d1.exec('DROP TABLE IF EXISTS accounts;')
  await d1.exec('DROP TABLE IF EXISTS users;')
  await d1.exec("CREATE TABLE users (id text PRIMARY KEY NOT NULL, name text, email text UNIQUE, image text, email_verified integer, role text, nickname text DEFAULT 'New user', created_at integer NOT NULL, updated_at integer NOT NULL);")
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
  assert.ok('createdAt' in created && created.createdAt instanceof Date)
  assert.ok('updatedAt' in created && created.updatedAt instanceof Date)
  assert.ok('nickname' in created && created.nickname === 'New user')
  assert.deepEqual(await adapter.getUserAndAccounts(created.id), { user: created, accounts: [] })

  const updated = await adapter.updateUser({
    id: created.id,
    name: 'Updated',
    emailVerified: false,
    role: 'user',
  })

  assert.equal(updated.name, 'Updated')
  assert.equal(updated.email, created.email)
  assert.equal(updated.emailVerified, false)
  assert.equal(updated.role, 'user')
  assert.ok('updatedAt' in updated && updated.updatedAt instanceof Date)

  await adapter.linkAccount({
    userId: created.id,
    provider: 'github',
    providerAccountId: 'github-d1',
    accessToken: 'original',
    refreshToken: 'refresh',
  })
  assert.deepEqual(await adapter.getUserByAccount('github', 'github-d1'), updated)
  await adapter.updateAccount!({
    userId: 'another-user',
    provider: 'github',
    providerAccountId: 'github-d1',
    accessToken: 'wrong-user',
  })
  assert.equal((await adapter.getAccounts(created.id))[0]?.accessToken, 'original')
  await adapter.updateAccount!({
    userId: created.id,
    provider: 'github',
    providerAccountId: 'github-d1',
    accessToken: 'updated',
  })
  const linked = await adapter.getUserAndAccounts(created.id)
  assert.deepEqual(linked?.user, updated)
  assert.equal(linked?.accounts.length, 1)
  assert.equal(linked?.accounts[0]?.accessToken, 'updated')
  assert.equal(linked?.accounts[0]?.refreshToken, 'refresh')

  await adapter.unlinkAccount('github', 'github-d1')
  assert.equal(await adapter.getUserByAccount('github', 'github-d1'), null)
  assert.deepEqual(await adapter.getAccounts(created.id), [])
  await adapter.deleteUser(created.id)
  assert.equal(await adapter.getUser(created.id), null)
  assert.equal(await adapter.getUserAndAccounts(created.id), null)

  await assert.rejects(
    adapter.updateUser({ id: 'missing-user', name: 'Missing' }),
    /User not found/,
  )
}
