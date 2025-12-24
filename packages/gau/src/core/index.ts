export interface User {
  id: string
  name?: string | null
  email?: string | null
  emailVerified?: boolean | null
  image?: string | null
  role?: string | null
  isAdmin?: boolean
}

export interface Session {
  id: string
  sub: string
  [key: string]: unknown
}

export interface GauSession<TProviders extends string = string> {
  user: User | null
  session: Session | null
  accounts?: Account[] | null
  providers?: TProviders[]
}

export const NULL_SESSION = {
  user: null,
  session: null,
  accounts: null,
} as const

export interface NewUser extends Omit<User, 'id' | 'accounts' | 'isAdmin'> {
  id?: string
}

export interface Account {
  userId: string
  provider: string
  providerAccountId: string
  type?: string // e.g. "oauth"
  accessToken?: string | null
  refreshToken?: string | null
  expiresAt?: number | null // epoch seconds
  idToken?: string | null
  scope?: string | null
  tokenType?: string | null
  sessionState?: string | null
}

export interface NewAccount extends Account {}

export interface Adapter {
  getUser: (id: string) => Promise<User | null>
  getUserByEmail: (email: string) => Promise<User | null>
  getUserByAccount: (provider: string, providerAccountId: string) => Promise<User | null>
  getAccounts: (userId: string) => Promise<Account[]>
  getUserAndAccounts: (userId: string) => Promise<{ user: User, accounts: Account[] } | null>
  createUser: (data: NewUser) => Promise<User>
  linkAccount: (data: NewAccount) => Promise<void>
  unlinkAccount: (provider: string, providerAccountId: string) => Promise<void>
  updateAccount?: (data: Partial<Account> & { userId: string, provider: string, providerAccountId: string }) => Promise<void>
  updateUser: (data: Partial<User> & { id: string }) => Promise<User>
  deleteUser: (id: string) => Promise<void>
}

export class AuthError extends Error {
  override readonly cause?: unknown
  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'AuthError'
    this.cause = cause
  }
}

export function json<T>(data: T, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  if (!headers.has('Content-Type'))
    headers.set('Content-Type', 'application/json; charset=utf-8')
  return new Response(JSON.stringify(data), { ...init, headers })
}

export function redirect(url: string, status: 302 | 303 = 302): Response {
  return new Response(null, {
    status,
    headers: {
      Location: url,
    },
  })
}

export * from './cookies'
export * from './createAuth'
export * from './handler'
export * from './utils'

export const REFRESHED_TOKEN_HEADER = 'X-Refreshed-Token'
