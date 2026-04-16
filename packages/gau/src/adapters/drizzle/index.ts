import type { Adapter } from '../../core/index'
import type { AccountsTable, UsersTable } from './shared'
import { is } from 'drizzle-orm'
import { MySqlDatabase } from 'drizzle-orm/mysql-core'
import { PgDatabase } from 'drizzle-orm/pg-core'

import { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'
import { MySqlDrizzleAdapter } from './mysql'
import { PostgresDrizzleAdapter } from './pg'
import { SQLiteDrizzleAdapter } from './sqlite'

export function DrizzleAdapter<
  U extends UsersTable,
  A extends AccountsTable,
>(
  db:
    | BaseSQLiteDatabase<'sync' | 'async', any, any>
    | MySqlDatabase<any, any, any, any>
    | PgDatabase<any, any, any>,
  users: U,
  accounts: A,
): Adapter {
  if (is(db, BaseSQLiteDatabase))
    return SQLiteDrizzleAdapter(db, users, accounts)

  if (is(db, MySqlDatabase))
    // @ts-expect-error Not implemented
    return MySqlDrizzleAdapter(db, users, accounts)

  if (is(db, PgDatabase))
    return PostgresDrizzleAdapter(db, users, accounts)

  throw new Error(
    `Unsupported database type (${typeof db}) in gau Drizzle adapter.`,
  )
}
