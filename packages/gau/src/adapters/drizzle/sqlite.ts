import type { AnyRelations } from 'drizzle-orm'
import type { SQLiteAsyncDatabase } from 'drizzle-orm/sqlite-core'
import type { Adapter } from '../../core'
import type { SQLiteAccountsTable, SQLiteUsersTable, SQLiteVerificationTable } from './schema'
import { and, eq, lte } from 'drizzle-orm'
import { accountFromRow, userInsert, userUpdate } from './shared'

export type SQLiteDatabase = SQLiteAsyncDatabase<'sync' | 'async', unknown, AnyRelations>

export function SQLiteDrizzleAdapter(db: SQLiteDatabase, users: SQLiteUsersTable, accounts: SQLiteAccountsTable, verification?: SQLiteVerificationTable): Adapter {
  return {
    verification: verification && {
      async get(id) {
        return await db.select().from(verification).where(eq(verification.id, id)).get() ?? null
      },
      async set(record, expectedVersion) {
        const result = expectedVersion === null
          ? await db.insert(verification).values(record).onConflictDoNothing().returning().get()
          : await db.update(verification).set(record).where(and(eq(verification.id, record.id), eq(verification.version, expectedVersion))).returning().get()
        return !!result
      },
      async deleteExpired(now) {
        await db.delete(verification).where(lte(verification.expiresAt, now)).run()
      },
    },
    async getUser(id) {
      return await db.select().from(users).where(eq(users.id, id)).get() ?? null
    },

    async getUserByEmail(email) {
      return await db.select().from(users).where(eq(users.email, email)).get() ?? null
    },

    async getUserByAccount(provider, providerAccountId) {
      const row = await db.select({ user: users }).from(users)
        .innerJoin(accounts, eq(users.id, accounts.userId))
        .where(and(eq(accounts.provider, provider), eq(accounts.providerAccountId, providerAccountId)))
        .get()
      return row?.user ?? null
    },

    async getAccounts(userId) {
      const rows = await db.select().from(accounts).where(eq(accounts.userId, userId)).all()
      return rows.map(accountFromRow)
    },

    async getUserAndAccounts(userId) {
      const rows = await db.select({ user: users, account: accounts }).from(users)
        .leftJoin(accounts, eq(users.id, accounts.userId))
        .where(eq(users.id, userId)).all()
      const first = rows[0]
      return first
        ? { user: first.user, accounts: rows.flatMap(row => row.account ? [accountFromRow(row.account)] : []) }
        : null
    },

    async createUser(data) {
      const user = await db.insert(users).values(userInsert(data, !!users.role)).returning().get()
      if (!user)
        throw new Error('Failed to create user.')
      return user
    },

    async updateUser(data) {
      const user = await db.update(users).set(userUpdate(data, !!users.role))
        .where(eq(users.id, data.id)).returning().get()
      if (!user)
        throw new Error('User not found')
      return user
    },

    async deleteUser(id) {
      await db.delete(users).where(eq(users.id, id)).run()
    },

    async linkAccount(data) {
      await db.insert(accounts).values({ type: 'oauth', ...data }).run()
    },

    async unlinkAccount(provider, providerAccountId) {
      await db.delete(accounts)
        .where(and(eq(accounts.provider, provider), eq(accounts.providerAccountId, providerAccountId))).run()
    },

    async updateAccount(data) {
      await db.update(accounts).set({
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        expiresAt: data.expiresAt,
        idToken: data.idToken,
        tokenType: data.tokenType,
        scope: data.scope,
      }).where(and(
        eq(accounts.userId, data.userId),
        eq(accounts.provider, data.provider),
        eq(accounts.providerAccountId, data.providerAccountId),
      )).run()
    },
  }
}
