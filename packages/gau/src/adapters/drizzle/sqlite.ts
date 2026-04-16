import type { InferInsertModel, InferSelectModel } from 'drizzle-orm'
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'
import { and, eq } from 'drizzle-orm'
import { createDrizzleAdapter } from './shared'
import type { AccountsTable, UsersTable } from './shared'
import { transaction } from './transaction'

export type { AccountsTable, UsersTable } from './shared'

export function SQLiteDrizzleAdapter<
  DB extends BaseSQLiteDatabase<'sync' | 'async', any, any>,
  U extends UsersTable,
  A extends AccountsTable,
>(db: DB, Users: U, Accounts: A) {
  type DBAccount = InferSelectModel<A>
  type DBInsertUser = InferInsertModel<U>
  type DBInsertAccount = InferInsertModel<A>

  return createDrizzleAdapter(Users, {
    async getUser(id) {
      return await db
        .select()
        .from(Users)
        .where(eq(Users.id, id))
        .get()
    },

    async getUserByEmail(email) {
      return await db
        .select()
        .from(Users)
        .where(eq(Users.email, email))
        .get()
    },

    async getUserByAccount(provider, providerAccountId) {
      const result = await db
        .select()
        .from(Users)
        .innerJoin(Accounts, eq(Users.id, Accounts.userId))
        .where(and(eq(Accounts.provider, provider), eq(Accounts.providerAccountId, providerAccountId)))
        .get()
      return result?.users
    },

    async getAccounts(userId) {
      return await db
        .select()
        .from(Accounts)
        .where(eq(Accounts.userId, userId))
        .all()
    },

    async getUserAndAccounts(userId) {
      const result = await db
        .select()
        .from(Users)
        .where(eq(Users.id, userId))
        .leftJoin(Accounts, eq(Users.id, Accounts.userId))
        .all()

      if (!result.length)
        return null

      return {
        user: result[0]!.users,
        accounts: result
        .map(row => row.accounts)
        .filter(Boolean) as DBAccount[],
      }
    },

    async createUser(id, data) {
      return await transaction(db, async (tx) => {
        await tx
          .insert(Users)
          .values(data as DBInsertUser)
          .run()

        return await tx.select().from(Users).where(eq(Users.id, id)).get()
      })
    },

    async linkAccount(data) {
      await db
        .insert(Accounts)
        .values(data as DBInsertAccount)
        .run()
    },

    async unlinkAccount(provider, providerAccountId) {
      await db
        .delete(Accounts)
        .where(and(eq(Accounts.provider, provider), eq(Accounts.providerAccountId, providerAccountId)))
        .run()
    },

    async updateAccount(data) {
      await db
        .update(Accounts)
        .set({
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
          expiresAt: data.expiresAt,
          idToken: data.idToken,
          tokenType: data.tokenType,
          scope: data.scope,
        })
        .where(and(
          eq(Accounts.userId, data.userId),
          eq(Accounts.provider, data.provider),
          eq(Accounts.providerAccountId, data.providerAccountId),
        ))
        .run()
    },

    async updateUser(id, data) {
      return await transaction(db, async (tx) => {
        await tx
          .update(Users)
          .set(data as Partial<DBInsertUser>)
          .where(eq(Users.id, id))
          .run()

        return await tx.select().from(Users).where(eq(Users.id, id)).get()
      })
    },

    async deleteUser(id) {
      await db.delete(Users).where(eq(Users.id, id)).run()
    },
  })
}
