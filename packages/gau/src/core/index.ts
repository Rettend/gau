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

export interface ClientAccount<TProviders extends string = string> {
  provider: TProviders
  providerAccountId: string
}

/**
 * Client-safe session data.
 */
export interface GauSession<TProviders extends string = string> {
  user: User | null
  session: Omit<Session, 'id'> | null
  accounts?: ClientAccount<TProviders>[] | null
  providers?: TProviders[]
}

/**
 * Full server-side session with complete account data including tokens.
 *
 * Never serialize this to the client - contains sensitive access/refresh tokens.
 */
export interface GauServerSession<TProviders extends string = string> {
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

export function toClientSession<TProviders extends string = string>(
  serverSession: GauServerSession<TProviders>,
): GauSession<TProviders> {
  const safeSession: Omit<Session, 'id'> | null = serverSession.session
    && (({ id: _id, ...rest }) => rest)(serverSession.session)

  return {
    user: serverSession.user,
    session: safeSession,
    accounts: serverSession.accounts?.map(acc => ({
      provider: acc.provider as TProviders,
      providerAccountId: acc.providerAccountId,
    })) ?? null,
    providers: serverSession.providers,
  }
}

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
export * from './errors'
export * from './handler'
export * from './templates'
export * from './utils'

export const REFRESHED_TOKEN_HEADER = 'X-Refreshed-Token'

/**
 * Helper to check if a session is an impersonation session.
 */
export function isImpersonating(session: Session | null): boolean {
  return session?.impersonatedBy != null
}
