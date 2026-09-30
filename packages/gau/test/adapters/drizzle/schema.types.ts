import type { drizzle as drizzleD1 } from 'drizzle-orm/d1'
import { defineRelations } from 'drizzle-orm'
import { drizzle as drizzleSQLite } from 'drizzle-orm/better-sqlite3'
import { drizzle as drizzleLibsql } from 'drizzle-orm/libsql'
import { boolean, integer as pgInteger, pgSchema, text as pgText, timestamp, uuid } from 'drizzle-orm/pg-core'
import { drizzle as drizzlePg } from 'drizzle-orm/pglite'
import { integer, snakeCase, text } from 'drizzle-orm/sqlite-core'
import { DrizzleAdapter } from '../../../src/adapters/drizzle'

// Compiled by check:test. These calls deliberately exercise the public signature,
// including invalid schemas that must never be accepted through broad generics.
export function checkDrizzleSchemas(d1: ReturnType<typeof drizzleD1>) {
  const userColumns = () => ({
    id: text().primaryKey().$defaultFn(() => crypto.randomUUID()),
    name: text(),
    email: text().unique(),
    image: text(),
    emailVerified: integer({ mode: 'boolean' }),
    createdAt: integer({ mode: 'timestamp' }).notNull(),
    updatedAt: integer({ mode: 'timestamp' }).$defaultFn(() => new Date()),
  })
  const users = snakeCase.table('members', {
    ...userColumns(),
    role: text().$type<'admin' | 'user'>().default('user'),
    nickname: text(),
  })
  const accounts = snakeCase.table('identities', {
    userId: text().notNull().references(() => users.id),
    provider: text().notNull(),
    providerAccountId: text().notNull(),
    type: text().notNull(),
    accessToken: text(),
    refreshToken: text(),
    expiresAt: integer(),
    idToken: text(),
    tokenType: text(),
    scope: text(),
    sessionState: text(),
    createdAt: integer({ mode: 'timestamp' }).$defaultFn(() => new Date()),
  })
  const relations = defineRelations({ users, accounts }, r => ({
    users: { accounts: r.many.accounts({ from: r.users.id, to: r.accounts.userId }) },
  }))
  DrizzleAdapter(drizzleSQLite.mock(), users, accounts)
  DrizzleAdapter(drizzleLibsql.mock({ relations }), users, accounts)
  DrizzleAdapter(d1, users, accounts)

  const auth = pgSchema('auth')
  const pgUserColumns = () => ({
    id: uuid().primaryKey(),
    name: pgText(),
    email: pgText(),
    image: pgText(),
    emailVerified: boolean(),
    createdAt: timestamp().defaultNow(),
    updatedAt: timestamp().notNull(),
  })
  const pgUsers = auth.table('members', {
    ...pgUserColumns(),
    role: pgText().$type<'admin' | 'user'>(),
    nickname: pgText(),
  })
  const pgAccounts = auth.table('identities', {
    userId: uuid().notNull(),
    provider: pgText().notNull(),
    providerAccountId: pgText().notNull(),
    type: pgText(),
    accessToken: pgText(),
    refreshToken: pgText(),
    expiresAt: pgInteger(),
    idToken: pgText(),
    tokenType: pgText(),
    scope: pgText(),
  })
  const pgRelations = defineRelations({ pgUsers, pgAccounts }, r => ({
    pgUsers: { accounts: r.many.pgAccounts({ from: r.pgUsers.id, to: r.pgAccounts.userId }) },
  }))
  DrizzleAdapter(drizzlePg.mock({ relations: pgRelations }), pgUsers, pgAccounts)

  const numericId = snakeCase.table('numeric_id', { ...userColumns(), id: integer().primaryKey() })
  // @ts-expect-error gau IDs are strings
  DrizzleAdapter(drizzleSQLite.mock(), numericId, accounts)
  const nullableId = snakeCase.table('nullable_id', { ...userColumns(), id: text() })
  // @ts-expect-error gau IDs must be non-null
  DrizzleAdapter(drizzleSQLite.mock(), nullableId, accounts)
  const numericVerified = snakeCase.table('numeric_verified', { ...userColumns(), emailVerified: integer() })
  // @ts-expect-error emailVerified must map to a boolean
  DrizzleAdapter(drizzleSQLite.mock(), numericVerified, accounts)
  const stringTimestamp = auth.table('string_timestamp', { ...pgUserColumns(), updatedAt: timestamp({ mode: 'string' }) })
  // @ts-expect-error gau writes JavaScript Dates
  DrizzleAdapter(drizzlePg.mock(), stringTimestamp, pgAccounts)
  // @ts-expect-error database and tables must use the same dialect
  DrizzleAdapter(drizzlePg.mock(), users, accounts)
  // @ts-expect-error cannot mix SQLite users with PostgreSQL accounts
  DrizzleAdapter(drizzleSQLite.mock(), users, pgAccounts)
  // @ts-expect-error missing auth columns
  DrizzleAdapter(drizzleSQLite.mock(), snakeCase.table('incomplete', { id: text().primaryKey() }), accounts)
}
