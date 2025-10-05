import type { AnyColumn, InferInsertModel, InferSelectModel, Table } from 'drizzle-orm'
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'
import type { Account, Adapter, NewAccount, NewUser, User } from '../../core/index'
import { and, eq } from 'drizzle-orm'
import { transaction } from './transaction'

export type UsersTable = Table & {
  id: AnyColumn
  name: AnyColumn
  email: AnyColumn
  image: AnyColumn
  emailVerified: AnyColumn
  role?: AnyColumn
  createdAt: AnyColumn
  updatedAt: AnyColumn
}

export type AccountsTable = Table & {
  userId: AnyColumn
  provider: AnyColumn
  providerAccountId: AnyColumn
}

export function SQLiteDrizzleAdapter<
  DB extends BaseSQLiteDatabase<'sync' | 'async', any, any>,
  U extends UsersTable,
  A extends AccountsTable,
>(db: DB, Users: U, Accounts: A): Adapter {
  type DBUser = InferSelectModel<U>
  type DBAccount = InferSelectModel<A>
  type DBInsertUser = InferInsertModel<U>
  type DBInsertAccount = InferInsertModel<A>

  const toUser = (row: DBUser | undefined | null): User | null =>
    row ? ({ ...(row as any) }) : null

  return {
    async getUser(id) {
      const user: DBUser | undefined = await db
        .select()
        .from(Users)
        .where(eq(Users.id, id))
        .get()
      return toUser(user)
    },

    async getUserByEmail(email) {
      const user: DBUser | undefined = await db
        .select()
        .from(Users)
        .where(eq(Users.email, email))
        .get()
      return toUser(user)
    },

    async getUserByAccount(provider, providerAccountId) {
      const result: DBUser | undefined = await db
        .select()
        .from(Users)
        .innerJoin(Accounts, eq(Users.id, Accounts.userId))
        .where(and(eq(Accounts.provider, provider), eq(Accounts.providerAccountId, providerAccountId)))
        .get()
      return toUser(result?.users)
    },

    async getAccounts(userId) {
      const accounts: DBAccount[] = await db
        .select()
        .from(Accounts)
        .where(eq(Accounts.userId, userId))
        .all()
      return accounts as Account[]
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

      const user = toUser(result[0]!.users)!
      const accounts = result
        .map(row => row.accounts)
        .filter(Boolean) as Account[]

      return { user, accounts }
    },

    async createUser(data: NewUser) {
      const id = data.id ?? crypto.randomUUID()
      return await transaction(db, async (tx) => {
        await tx
          .insert(Users)
          .values({
            id,
            name: data.name ?? null,
            email: data.email ?? null,
            image: data.image ?? null,
            emailVerified: data.emailVerified ?? null,
            ...(Users.role ? { role: data.role ?? null } : {}),
            createdAt: new Date(),
            updatedAt: new Date(),
          } as DBInsertUser)
          .run()

        const result: DBUser | undefined = await tx.select().from(Users).where(eq(Users.id, id)).get()
        return toUser(result) as User
      })
    },

    async linkAccount(data: NewAccount) {
      await db
        .insert(Accounts)
        .values({
          type: 'oauth',
          ...data,
        } as DBInsertAccount)
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

    async updateUser(partial) {
      return await transaction(db, async (tx) => {
        await tx
          .update(Users)
          .set({
            name: partial.name,
            email: partial.email,
            image: partial.image,
            emailVerified: partial.emailVerified,
            ...(Users.role ? { role: partial.role } : {}),
            updatedAt: new Date(),
          } as Partial<DBInsertUser>)
          .where(eq(Users.id, partial.id))
          .run()

        const result: DBUser | undefined = await tx.select().from(Users).where(eq(Users.id, partial.id)).get()
        return toUser(result) as User
      })
    },

    async deleteUser(id) {
      await db.delete(Users).where(eq(Users.id, id)).run()
    },
  }
}
