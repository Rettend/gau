import type { InferInsertModel, InferSelectModel } from 'drizzle-orm'
import type { PgDatabase, PgTable } from 'drizzle-orm/pg-core'
import type { AccountsTable, UsersTable } from './shared'
import { and, eq } from 'drizzle-orm'
import { createDrizzleAdapter } from './shared'

export type { AccountsTable, UsersTable } from './shared'

export function PostgresDrizzleAdapter<
  DB extends PgDatabase<any, any, any>,
  U extends UsersTable,
  A extends AccountsTable,
>(db: DB, Users: U, Accounts: A) {
  type DBAccount = InferSelectModel<A>
  type DBInsertAccount = InferInsertModel<A>

  return createDrizzleAdapter(Users, {
    async getUser(id) {
      const rows = await db
        .select()
        .from(Users as unknown as PgTable)
        .where(eq(Users.id, id))
        .limit(1)
        .execute()
      return rows[0] as InferSelectModel<U> | undefined
    },

    async getUserByEmail(email) {
      const rows = await db
        .select()
        .from(Users as unknown as PgTable)
        .where(eq(Users.email, email))
        .limit(1)
        .execute()
      return rows[0] as InferSelectModel<U> | undefined
    },

    async getUserByAccount(provider, providerAccountId) {
      const rows = await db
        .select()
        .from(Users as unknown as PgTable)
        .innerJoin(Accounts as unknown as PgTable, eq(Users.id, Accounts.userId))
        .where(and(
          eq(Accounts.provider, provider),
          eq(Accounts.providerAccountId, providerAccountId),
        ))
        .limit(1)
        .execute()
      const row = rows[0] as { users?: InferSelectModel<U> } | undefined
      return row?.users
    },

    async getAccounts(userId) {
      const rows = await db
        .select()
        .from(Accounts as unknown as PgTable)
        .where(eq(Accounts.userId, userId))
        .execute()
      return rows as DBAccount[]
    },

    async getUserAndAccounts(userId) {
      const rows = await db
        .select()
        .from(Users as unknown as PgTable)
        .leftJoin(Accounts as unknown as PgTable, eq(Users.id, Accounts.userId))
        .where(eq(Users.id, userId))
        .execute()

      if (!rows.length)
        return null

      return {
        user: (rows[0] as unknown as { users: InferSelectModel<U> }).users,
        accounts: rows
          .map((r: { accounts?: DBAccount } | undefined) => r?.accounts)
          .filter(Boolean) as DBAccount[],
      }
    },

    async createUser(_id, data) {
      const [inserted] = await db
        .insert(Users)
        .values(data)
        .returning()
        .execute()

      return inserted
    },

    async linkAccount(data) {
      await db
        .insert(Accounts)
        .values(data as DBInsertAccount)
        .execute()
    },

    async unlinkAccount(provider, providerAccountId) {
      await db
        .delete(Accounts)
        .where(and(
          eq(Accounts.provider, provider),
          eq(Accounts.providerAccountId, providerAccountId),
        ))
        .execute()
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
        } as Partial<DBInsertAccount>)
        .where(and(
          eq(Accounts.userId, data.userId),
          eq(Accounts.provider, data.provider),
          eq(Accounts.providerAccountId, data.providerAccountId),
        ))
        .execute()
    },

    async updateUser(id, data) {
      const [updated] = await db
        .update(Users)
        .set(data)
        .where(eq(Users.id, id))
        .returning()
        .execute()

      return updated
    },

    async deleteUser(id) {
      await db
        .delete(Users)
        .where(eq(Users.id, id))
        .execute()
    },
  })
}
