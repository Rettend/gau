import type { AnyRelations } from 'drizzle-orm'
import type { PgAsyncDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import type { Adapter } from '../../core'
import type { PostgresAccountsTable, PostgresUsersTable } from './schema'
import { and, eq } from 'drizzle-orm'
import { accountFromRow, userInsert, userUpdate } from './shared'

export type PostgresDatabase = PgAsyncDatabase<PgQueryResultHKT, AnyRelations>

export function PostgresDrizzleAdapter(db: PostgresDatabase, users: PostgresUsersTable, accounts: PostgresAccountsTable): Adapter {
  return {
    async getUser(id) {
      const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1)
      return user ?? null
    },

    async getUserByEmail(email) {
      const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1)
      return user ?? null
    },

    async getUserByAccount(provider, providerAccountId) {
      const [row] = await db.select({ user: users }).from(users)
        .innerJoin(accounts, eq(users.id, accounts.userId))
        .where(and(eq(accounts.provider, provider), eq(accounts.providerAccountId, providerAccountId)))
        .limit(1)
      return row?.user ?? null
    },

    async getAccounts(userId) {
      const rows = await db.select().from(accounts).where(eq(accounts.userId, userId))
      return rows.map(accountFromRow)
    },

    async getUserAndAccounts(userId) {
      const rows = await db.select({ user: users, account: accounts }).from(users)
        .leftJoin(accounts, eq(users.id, accounts.userId))
        .where(eq(users.id, userId))
      const first = rows[0]
      return first
        ? { user: first.user, accounts: rows.flatMap(row => row.account ? [accountFromRow(row.account)] : []) }
        : null
    },

    async createUser(data) {
      const [user] = await db.insert(users).values(userInsert(data, !!users.role)).returning()
      if (!user)
        throw new Error('Failed to create user.')
      return user
    },

    async updateUser(data) {
      const [user] = await db.update(users).set(userUpdate(data, !!users.role))
        .where(eq(users.id, data.id)).returning()
      if (!user)
        throw new Error('User not found')
      return user
    },

    async deleteUser(id) {
      await db.delete(users).where(eq(users.id, id))
    },

    async linkAccount(data) {
      await db.insert(accounts).values({ type: 'oauth', ...data })
    },

    async unlinkAccount(provider, providerAccountId) {
      await db.delete(accounts)
        .where(and(eq(accounts.provider, provider), eq(accounts.providerAccountId, providerAccountId)))
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
      ))
    },
  }
}
