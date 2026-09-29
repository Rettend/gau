import type { Adapter } from '../../core'
import type { PostgresDatabase } from './pg'
import type { PostgresAccountsTable, PostgresUsersTable, SQLiteAccountsTable, SQLiteUsersTable } from './schema'
import type { SQLiteDatabase } from './sqlite'
import { is } from 'drizzle-orm'
import { PgAsyncDatabase } from 'drizzle-orm/pg-core'
import { SQLiteAsyncDatabase } from 'drizzle-orm/sqlite-core'
import { PostgresDrizzleAdapter } from './pg'
import { SQLiteDrizzleAdapter } from './sqlite'

type SQLiteConfig = [db: SQLiteDatabase, users: SQLiteUsersTable, accounts: SQLiteAccountsTable]
type PostgresConfig = [db: PostgresDatabase, users: PostgresUsersTable, accounts: PostgresAccountsTable]
type DrizzleConfig = SQLiteConfig | PostgresConfig

function isSQLite(config: DrizzleConfig): config is SQLiteConfig {
  return is(config[0], SQLiteAsyncDatabase)
}

function isPostgres(config: DrizzleConfig): config is PostgresConfig {
  return is(config[0], PgAsyncDatabase)
}

export function DrizzleAdapter(...config: DrizzleConfig): Adapter {
  if (isSQLite(config))
    return SQLiteDrizzleAdapter(...config)
  if (isPostgres(config))
    return PostgresDrizzleAdapter(...config)
  throw new Error('Unsupported database in gau Drizzle adapter. Use SQLite or PostgreSQL.')
}
