import type { Adapter } from '../../../src/core'
import { PGlite } from '@electric-sql/pglite'
import { bigint, boolean, integer, snakeCase, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { drizzle } from 'drizzle-orm/pglite'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'
import { DrizzleAdapter } from '../../../src/adapters/drizzle'
import { verificationTests } from '../verification'

const verificationTable = snakeCase.table('verification', {
  id: text().primaryKey(),
  value: text().notNull(),
  expiresAt: bigint({ mode: 'number' }).notNull(),
  version: integer().notNull(),
})

const usersTable = snakeCase.table('auth_users', {
  id: uuid().primaryKey(),
  name: text(),
  email: text().unique(),
  image: text(),
  emailVerified: boolean(),
  role: text(),
  nickname: text().default('New user'),
  createdAt: timestamp().notNull(),
  updatedAt: timestamp().notNull(),
})

const accountsTable = snakeCase.table('auth_accounts', {
  userId: uuid().notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  provider: text().notNull(),
  providerAccountId: text().notNull(),
  type: text(),
  refreshToken: text(),
  accessToken: text(),
  expiresAt: integer(),
  tokenType: text(),
  scope: text(),
  idToken: text(),
  sessionState: text(),
})

describe('postgres drizzle adapter', () => {
  let db: ReturnType<typeof drizzle>
  let adapter: Adapter
  let client: PGlite
  verificationTests(() => adapter.verification!)

  beforeEach(async () => {
    client = new PGlite()
    db = drizzle({ client })

    await client.exec(`
      CREATE TABLE IF NOT EXISTS "auth_users" (
        "id" uuid PRIMARY KEY,
        "name" text,
        "email" text UNIQUE,
        "image" text,
        "email_verified" boolean,
        "role" text,
        "nickname" text DEFAULT 'New user',
        "created_at" timestamp NOT NULL,
        "updated_at" timestamp NOT NULL
      );
    `)
    await client.exec(`
      CREATE TABLE IF NOT EXISTS "auth_accounts" (
        "user_id" uuid NOT NULL REFERENCES "auth_users"("id") ON DELETE CASCADE,
        "provider" text NOT NULL,
        "provider_account_id" text NOT NULL,
        "type" text,
        "refresh_token" text,
        "access_token" text,
        "expires_at" integer,
        "token_type" text,
        "scope" text,
        "id_token" text,
        "session_state" text,
        PRIMARY KEY ("provider", "provider_account_id")
      );
    `)

    await client.exec('CREATE TABLE verification (id text PRIMARY KEY, value text NOT NULL, expires_at bigint NOT NULL, version integer NOT NULL)')
    adapter = DrizzleAdapter(db, usersTable, accountsTable, verificationTable)
  })

  afterEach(async () => {
    await client.exec('DROP TABLE IF EXISTS "auth_accounts"')
    await client.exec('DROP TABLE IF EXISTS "auth_users"')
    await client.close()
  })

  it('createUser: should create a new user with all fields', async () => {
    const user = await adapter.createUser({
      name: 'Test User',
      email: 'test@example.com',
      image: 'image.png',
      emailVerified: true,
    })
    expect(user.id).toBeDefined()
    expect(user.name).toBe('Test User')
    expect(user.email).toBe('test@example.com')
    expect(user.image).toBe('image.png')
    expect(user.emailVerified).toBe(true)
  })

  it('createUser: should create a user with only an email', async () => {
    const user = await adapter.createUser({ email: 'minimal@example.com' })
    expect(user.id).toBeDefined()
    expect(user.email).toBe('minimal@example.com')
    expect(user.name).toBeNull()
    expect(user.image).toBeNull()
    expect(user.emailVerified).toBeNull()
  })

  it('getUser: should retrieve a user by id', async () => {
    const createdUser = await adapter.createUser({ email: 'get@example.com' })
    const user = await adapter.getUser(createdUser.id)
    expect(user).toEqual(createdUser)
  })

  it('getUser: should return null for a non-existent user', async () => {
    const user = await adapter.getUser(crypto.randomUUID())
    expect(user).toBeNull()
  })

  it('getUserByEmail: should retrieve a user by email', async () => {
    const createdUser = await adapter.createUser({ email: 'getbyemail@example.com' })
    const user = await adapter.getUserByEmail('getbyemail@example.com')
    expect(user).toEqual(createdUser)
  })

  it('getUserByEmail: should return null for a non-existent email', async () => {
    const user = await adapter.getUserByEmail('non-existent@example.com')
    expect(user).toBeNull()
  })

  it('getUserByAccount: should retrieve a user by account', async () => {
    const createdUser = await adapter.createUser({ email: 'getbyaccount@example.com' })
    await adapter.linkAccount({
      userId: createdUser.id,
      provider: 'test-provider',
      providerAccountId: 'test-provider-id',
    })
    const user = await adapter.getUserByAccount('test-provider', 'test-provider-id')
    expect(user).toEqual(createdUser)
  })

  it('getUserByAccount: should return null for a non-existent account', async () => {
    const user = await adapter.getUserByAccount('non-existent-provider', 'non-existent-id')
    expect(user).toBeNull()
  })

  it('updateUser: should update user fields', async () => {
    const createdUser = await adapter.createUser({ name: 'Original Name', email: 'update@example.com' })
    const updatedUser = await adapter.updateUser({
      id: createdUser.id,
      name: 'Updated Name',
      image: 'new-image.png',
      emailVerified: true,
    })
    expect(updatedUser.name).toBe('Updated Name')
    expect(updatedUser.image).toBe('new-image.png')
    expect(updatedUser.emailVerified).toBe(true)
    expect(updatedUser.email).toBe('update@example.com')
  })

  it('linkAccount: should link an account to a user', async () => {
    const user = await adapter.createUser({ email: 'link@example.com' })
    await adapter.linkAccount({
      userId: user.id,
      provider: 'test-provider',
      providerAccountId: 'test-provider-id',
    })
    const retrievedUser = await adapter.getUserByAccount('test-provider', 'test-provider-id')
    expect(retrievedUser).toEqual(user)
  })

  it('updateUser: should reject a missing user', async () => {
    await expect(adapter.updateUser({ id: crypto.randomUUID(), name: 'Missing' }))
      .rejects.toThrow('User not found')
  })

  it('preserves roles, extra fields, and Date timestamps through writes and joins', async () => {
    const data = { email: 'extended@example.com', role: 'admin', nickname: 'Custom' }
    const created = await adapter.createUser(data)
    expect(created).toMatchObject({ ...data, createdAt: expect.any(Date), updatedAt: expect.any(Date) })

    await adapter.linkAccount({ userId: created.id, provider: 'github', providerAccountId: 'extended' })
    const update = { id: created.id, role: 'user', nickname: 'Changed' }
    const updated = await adapter.updateUser(update)
    expect(updated).toMatchObject(update)
    expect(await adapter.getUserByAccount('github', 'extended')).toEqual(updated)
    expect((await adapter.getUserAndAccounts(created.id))?.user).toEqual(updated)
  })

  it('only updates tokens on the matching user and provider account', async () => {
    const user = await adapter.createUser({ email: 'scoped@example.com' })
    await adapter.linkAccount({ userId: user.id, provider: 'github', providerAccountId: 'one', accessToken: 'original', refreshToken: 'refresh' })
    await adapter.linkAccount({ userId: user.id, provider: 'github', providerAccountId: 'two', accessToken: 'other' })
    await adapter.updateAccount!({ userId: crypto.randomUUID(), provider: 'github', providerAccountId: 'one', accessToken: 'wrong-user' })
    expect((await adapter.getAccounts(user.id)).find(account => account.providerAccountId === 'one')?.accessToken).toBe('original')

    await adapter.updateAccount!({ userId: user.id, provider: 'github', providerAccountId: 'one', accessToken: null })
    expect(await adapter.getAccounts(user.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ providerAccountId: 'one', accessToken: null, refreshToken: 'refresh' }),
      expect.objectContaining({ providerAccountId: 'two', accessToken: 'other' }),
    ]))
  })

  it('updateAccount: should update token fields for an account', async () => {
    const user = await adapter.createUser({ email: 'tokens@example.com' })
    await adapter.linkAccount({ userId: user.id, provider: 'github', providerAccountId: 'gh1' })

    await adapter.updateAccount!({
      userId: user.id,
      provider: 'github',
      providerAccountId: 'gh1',
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      expiresAt: 123456,
      idToken: 'id-token',
      tokenType: 'Bearer',
      scope: 'read',
    })

    const accounts = await adapter.getAccounts(user.id)
    const acc = accounts.find(a => a.provider === 'github' && a.providerAccountId === 'gh1')!
    expect(acc.accessToken).toBe('new-access')
    expect(acc.refreshToken).toBe('new-refresh')
    expect(acc.expiresAt).toBe(123456)
    expect(acc.idToken).toBe('id-token')
    expect(acc.tokenType).toBe('Bearer')
    expect(acc.scope).toBe('read')
  })

  it('deleteUser: should delete a user', async () => {
    const user = await adapter.createUser({ email: 'delete@example.com' })
    expect(await adapter.getUser(user.id)).not.toBeNull()
    await adapter.deleteUser(user.id)
    expect(await adapter.getUser(user.id)).toBeNull()
  })

  it('getAccounts: should return all accounts for a user', async () => {
    const user = await adapter.createUser({ email: 'accounts@example.com' })
    await adapter.linkAccount({ userId: user.id, provider: 'github', providerAccountId: 'gh1' })
    await adapter.linkAccount({ userId: user.id, provider: 'google', providerAccountId: 'gg1' })
    const accounts = await adapter.getAccounts(user.id)
    expect(accounts).toHaveLength(2)
    expect(accounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'github', providerAccountId: 'gh1' }),
      expect.objectContaining({ provider: 'google', providerAccountId: 'gg1' }),
    ]))
  })

  it('getAccounts: should return an empty array for a user with no accounts', async () => {
    const user = await adapter.createUser({ email: 'no-accounts@example.com' })
    const accounts = await adapter.getAccounts(user.id)
    expect(accounts).toEqual([])
  })

  it('getAccounts: should return an empty array for a non-existent user', async () => {
    const accounts = await adapter.getAccounts(crypto.randomUUID())
    expect(accounts).toEqual([])
  })

  it('getUserAndAccounts: should return user and their accounts', async () => {
    const user = await adapter.createUser({ email: 'userandaccounts@example.com' })
    await adapter.linkAccount({ userId: user.id, provider: 'github', providerAccountId: 'gh1' })
    await adapter.linkAccount({ userId: user.id, provider: 'google', providerAccountId: 'gg1' })

    const result = await adapter.getUserAndAccounts(user.id)
    expect(result).not.toBeNull()
    expect(result!.user).toEqual(user)
    expect(result!.accounts).toHaveLength(2)
    expect(result!.accounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'github', providerAccountId: 'gh1' }),
      expect.objectContaining({ provider: 'google', providerAccountId: 'gg1' }),
    ]))
  })

  it('getUserAndAccounts: should return user and empty array for user with no accounts', async () => {
    const user = await adapter.createUser({ email: 'userandnoaccounts@example.com' })
    const result = await adapter.getUserAndAccounts(user.id)
    expect(result).not.toBeNull()
    expect(result!.user).toEqual(user)
    expect(result!.accounts).toEqual([])
  })

  it('getUserAndAccounts: should return null for non-existent user', async () => {
    const result = await adapter.getUserAndAccounts(crypto.randomUUID())
    expect(result).toBeNull()
  })

  it('unlinkAccount: should unlink an account from a user', async () => {
    const user = await adapter.createUser({ email: 'unlink@example.com' })
    await adapter.linkAccount({
      userId: user.id,
      provider: 'github',
      providerAccountId: 'gh1',
    })
    let accounts = await adapter.getAccounts(user.id)
    expect(accounts).toHaveLength(1)

    await adapter.unlinkAccount('github', 'gh1')

    accounts = await adapter.getAccounts(user.id)
    expect(accounts).toHaveLength(0)

    const userByAccount = await adapter.getUserByAccount('github', 'gh1')
    expect(userByAccount).toBeNull()
  })

  it('unlinkAccount: should not affect other accounts for the same user', async () => {
    const user = await adapter.createUser({ email: 'unlink-multi@example.com' })
    await adapter.linkAccount({ userId: user.id, provider: 'github', providerAccountId: 'gh1' })
    await adapter.linkAccount({ userId: user.id, provider: 'google', providerAccountId: 'gg1' })

    await adapter.unlinkAccount('github', 'gh1')

    const accounts = await adapter.getAccounts(user.id)
    expect(accounts).toHaveLength(1)
    expect(accounts[0]!.provider).toBe('google')

    const userByGhAccount = await adapter.getUserByAccount('github', 'gh1')
    expect(userByGhAccount).toBeNull()
    const userByGgAccount = await adapter.getUserByAccount('google', 'gg1')
    expect(userByGgAccount).toEqual(user)
  })

  it('unlinkAccount: unlinking a non-existent account should not throw', async () => {
    await expect(adapter.unlinkAccount('noop', 'noop')).resolves.toBeUndefined()
  })
})
