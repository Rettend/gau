import type { AnyColumn, InferInsertModel, InferSelectModel, Table } from 'drizzle-orm'
import type { PgDatabase, PgTable } from 'drizzle-orm/pg-core'
import type { Account, Adapter, NewAccount, NewUser, User } from '../../core'
import { and, eq } from 'drizzle-orm'

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
  type: AnyColumn
  provider: AnyColumn
  providerAccountId: AnyColumn
  refreshToken: AnyColumn
  accessToken: AnyColumn
  expiresAt: AnyColumn
  tokenType: AnyColumn
  scope: AnyColumn
  idToken: AnyColumn
  sessionState: AnyColumn
}

export function PostgresDrizzleAdapter<
  DB extends PgDatabase<any, any, any>,
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
      const rows = await db
        .select()
        .from(Users as unknown as PgTable)
        .where(eq(Users.id, id))
        .limit(1)
        .execute()
      return toUser(rows[0] as DBUser | undefined)
    },

    async getUserByEmail(email) {
      const rows = await db
        .select()
        .from(Users as unknown as PgTable)
        .where(eq(Users.email, email))
        .limit(1)
        .execute()
      return toUser(rows[0] as DBUser | undefined)
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
      const row = rows[0] as { users?: DBUser } | undefined
      return toUser(row?.users)
    },

    async getAccounts(userId) {
      const rows = await db
        .select()
        .from(Accounts as unknown as PgTable)
        .where(eq(Accounts.userId, userId))
        .execute()
      return rows as unknown as Account[]
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

      const user = toUser((rows[0] as { users?: DBUser } | undefined)?.users) as User
      const accounts = (rows
        .map((r: { accounts?: DBAccount } | undefined) => r?.accounts)
        .filter(Boolean) as DBAccount[]) as unknown as Account[]

      return { user, accounts }
    },

    async createUser(data: NewUser) {
      const id = data.id ?? crypto.randomUUID()
      const [inserted] = await db
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
        .returning()
        .execute()

      return toUser(inserted) as User
    },

    async linkAccount(data: NewAccount) {
      await db
        .insert(Accounts)
        .values({
          type: 'oauth',
          ...data,
        } as DBInsertAccount)
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

    async updateUser(partial) {
      const [updated] = await db
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
        .returning()
        .execute()

      return toUser(updated) as User
    },

    async deleteUser(id) {
      await db
        .delete(Users)
        .where(eq(Users.id, id))
        .execute()
    },
  }
}
