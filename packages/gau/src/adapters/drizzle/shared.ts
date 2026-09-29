import type { Account, NewUser, User } from '../../core'

export interface UserRow {
  id: string
  name: string | null
  email: string | null
  image: string | null
  emailVerified: boolean | null
  createdAt: Date | null
  updatedAt: Date | null
}

export interface AccountRow {
  userId: string
  provider: string
  providerAccountId: string
  type: string | null
  refreshToken: string | null
  accessToken: string | null
  expiresAt: number | null
  tokenType: string | null
  scope: string | null
  idToken: string | null
}

export function accountFromRow(row: AccountRow): Account {
  return { ...row, type: row.type ?? undefined }
}

export function userInsert(data: NewUser, hasRole: boolean) {
  const { role, ...rest } = data
  return {
    ...rest,
    id: data.id ?? crypto.randomUUID(),
    name: data.name ?? null,
    email: data.email ?? null,
    image: data.image ?? null,
    emailVerified: data.emailVerified ?? null,
    ...(hasRole ? { role: role ?? null } : {}),
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}

export function userUpdate(data: Partial<User> & { id: string }, hasRole: boolean) {
  const { id: _id, role, ...rest } = data
  return { ...rest, ...(hasRole ? { role } : {}), updatedAt: new Date() }
}
