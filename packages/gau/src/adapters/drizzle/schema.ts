import type { AnyPgColumn, PgTableWithColumns } from 'drizzle-orm/pg-core'
import type { AnySQLiteColumn, SQLiteTableWithColumns } from 'drizzle-orm/sqlite-core'
import type { AccountRow, UserRow } from './shared'
import type { VerificationRecord } from '../../core/verification'

// Describe the fields gau reads and writes, while allowing extra application columns.
// Auth fields must be writable; IDs must be non-null strings.
type ColumnConfig<T> = {
  data: NonNullable<T>
  notNull: null extends T ? boolean : true
  generated: undefined
  identity: undefined
}

type SQLiteColumns<T> = { [K in keyof T]: AnySQLiteColumn<ColumnConfig<T[K]>> }
type PostgresColumns<T> = { [K in keyof T]: AnyPgColumn<ColumnConfig<T[K]>> }

type SQLiteAuthTable<T> = SQLiteTableWithColumns<{
  name: string
  schema: string | undefined
  dialect: 'sqlite'
  columns: SQLiteColumns<T>
}>

type PostgresAuthTable<T> = PgTableWithColumns<{
  name: string
  schema: string | undefined
  dialect: 'pg'
  columns: PostgresColumns<T>
}>

export type SQLiteUsersTable = SQLiteAuthTable<UserRow> & {
  role?: AnySQLiteColumn<ColumnConfig<string | null>>
}
export type SQLiteAccountsTable = SQLiteAuthTable<AccountRow> & {
  sessionState?: AnySQLiteColumn<ColumnConfig<string | null>>
}
export type PostgresUsersTable = PostgresAuthTable<UserRow> & {
  role?: AnyPgColumn<ColumnConfig<string | null>>
}
export type PostgresAccountsTable = PostgresAuthTable<AccountRow> & {
  sessionState?: AnyPgColumn<ColumnConfig<string | null>>
}

export type SQLiteVerificationTable = SQLiteAuthTable<VerificationRecord>
export type PostgresVerificationTable = PostgresAuthTable<VerificationRecord>
