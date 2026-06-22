import type { AnyColumn, InferInsertModel, InferSelectModel, Table } from 'drizzle-orm'
import type { Account, Adapter, NewAccount, NewUser, User } from '../../core'

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
  sessionState?: AnyColumn
}

type UpdateAccountData = Partial<Account> & {
  userId: string
  provider: string
  providerAccountId: string
}

interface AdapterHooks<
  U extends UsersTable,
  A extends AccountsTable,
> {
  getUser: (id: string) => Promise<InferSelectModel<U> | undefined>
  getUserByEmail: (email: string) => Promise<InferSelectModel<U> | undefined>
  getUserByAccount: (provider: string, providerAccountId: string) => Promise<InferSelectModel<U> | undefined>
  getAccounts: (userId: string) => Promise<InferSelectModel<A>[]>
  getUserAndAccounts: (userId: string) => Promise<{
    user: InferSelectModel<U> | null | undefined
    accounts: InferSelectModel<A>[]
  } | null>
  createUser: (id: string, data: InferInsertModel<U>) => Promise<InferSelectModel<U> | undefined>
  linkAccount: (data: InferInsertModel<A>) => Promise<void>
  unlinkAccount: (provider: string, providerAccountId: string) => Promise<void>
  updateAccount: (data: UpdateAccountData) => Promise<void>
  updateUser: (id: string, data: Partial<InferInsertModel<U>>) => Promise<InferSelectModel<U> | undefined>
  deleteUser: (id: string) => Promise<void>
}

export function createDrizzleAdapter<
  U extends UsersTable,
  A extends AccountsTable,
>(Users: U, hooks: AdapterHooks<U, A>): Adapter {
  type DBUser = InferSelectModel<U>
  type DBInsertUser = InferInsertModel<U>
  type DBInsertAccount = InferInsertModel<A>

  const toUser = (row: DBUser | undefined | null): User | null =>
    row ? ({ ...(row as any) }) : null

  return {
    async getUser(id) {
      return toUser(await hooks.getUser(id))
    },

    async getUserByEmail(email) {
      return toUser(await hooks.getUserByEmail(email))
    },

    async getUserByAccount(provider, providerAccountId) {
      return toUser(await hooks.getUserByAccount(provider, providerAccountId))
    },

    async getAccounts(userId) {
      return await hooks.getAccounts(userId) as Account[]
    },

    async getUserAndAccounts(userId) {
      const result = await hooks.getUserAndAccounts(userId)
      if (!result)
        return null

      return {
        user: toUser(result.user) as User,
        accounts: result.accounts as Account[],
      }
    },

    async createUser(data: NewUser) {
      const id = data.id ?? crypto.randomUUID()
      const result = await hooks.createUser(id, {
        ...data,
        id,
        name: data.name ?? null,
        email: data.email ?? null,
        image: data.image ?? null,
        emailVerified: data.emailVerified ?? null,
        ...(Users.role ? { role: data.role ?? null } : {}),
        createdAt: new Date(),
        updatedAt: new Date(),
      } as DBInsertUser)

      return toUser(result) as User
    },

    async linkAccount(data: NewAccount) {
      await hooks.linkAccount({
        type: 'oauth',
        ...data,
      } as DBInsertAccount)
    },

    async unlinkAccount(provider, providerAccountId) {
      await hooks.unlinkAccount(provider, providerAccountId)
    },

    async updateAccount(data) {
      await hooks.updateAccount(data)
    },

    async updateUser(partial) {
      const { id, ...rest } = partial
      const result = await hooks.updateUser(id, {
        ...rest,
        updatedAt: new Date(),
      } as Partial<DBInsertUser>)

      return toUser(result) as User
    },

    async deleteUser(id) {
      await hooks.deleteUser(id)
    },
  }
}
