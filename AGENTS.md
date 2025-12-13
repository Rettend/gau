# gau

**gau** is a flexible, self-hostable OAuth2.1 library similar to Auth.js, built with first-class Tauri support.

## Core Philosophy

- **Everything-agnostic**: Framework, runtime, and database agnostic
- **Web Standards**: Uses Web Crypto and Fetch APIs exclusively
- **Self-hostable**: No docker and stuff, run anywhere
- **TypeScript-first**: Fully typed with strong type inference

## Architecture

```txt
packages/gau/src/
├── core/           # Framework-agnostic auth logic
├── adapters/       # Database adapters (Drizzle: SQLite, PostgreSQL, MySQL)
├── oauth/          # OAuth providers (GitHub, Google, Discord, Facebook, Microsoft)
├── jwt/            # JWT signing/verification (ES256, HS256)
├── client/         # Frontend client helpers (Svelte, SolidJS, Vanilla)
├── sveltekit/      # SvelteKit integration
├── solidstart/     # SolidStart integration
└── runtimes/       # Runtime-specific code (Bun, Tauri)
```

## Key Concepts

### 1. `createAuth(options)` - Core Factory

Creates the auth instance with all configuration:

```ts
const auth = createAuth({
  adapter, // Database adapter (required)
  providers, // OAuth providers array (required)
  basePath, // API route prefix (default: '/api/auth')
  jwt: { secret }, // JWT config with secret
  cookies: {}, // Cookie configuration
  roles: {}, // Role-based access control config
  profiles: {}, // Provider-specific profile overrides
  // Hooks:
  onOAuthExchange, // Intercept OAuth callback
  mapExternalProfile, // Transform provider user data
  onBeforeLinkAccount,
  onAfterLinkAccount
})
```

### 2. `createHandler(auth)` - Request Handler

Returns a `(Request) => Promise<Response>` function handling these routes:

- `GET /:provider` - Start OAuth flow
- `GET /callback/:provider` - OAuth callback
- `GET /link/:provider` - Link additional account
- `GET /session` - Get current session
- `POST /signout` - Sign out
- `POST /token` - Exchange token
- `POST /unlink/:provider` - Unlink account

### 3. Session Strategy

- **Cookie-based**: Default for web apps, uses `gau_session` cookie
- **Token-based**: For mobile/Tauri apps, uses Bearer token
- Sessions are JWTs containing `sub` (user ID) and custom claims

### 4. `issueSession(userId, options?)` - Programmatic Sessions

Issue a session for any user without OAuth flow. Returns both token and Set-Cookie header:

```ts
const { token, cookie, cookieName, maxAge } = await auth.issueSession(userId, {
  data: { isGuest: true }, // Custom claims
  ttl: 3600 // Override default TTL
})

// Web: Set cookie in response
response.headers.set('Set-Cookie', cookie)

// Mobile/Tauri: Use Bearer token
fetch(url, { headers: { Authorization: `Bearer ${token}` } })
```

Use cases: guest login, invite redemption, admin impersonation, device claiming.

### 5. `refreshSession(token, options?)` - Extend Sessions

Refresh an existing session, issuing a new token with extended TTL. Preserves custom claims:

```ts
const refreshed = await auth.refreshSession(token, {
  ttl: 3600, // Override TTL
  threshold: 0.5 // Only refresh if past 50% of TTL
})
if (refreshed)
  response.headers.set('Set-Cookie', refreshed.cookie)
```

Returns `null` if token is invalid/expired/below threshold or user no longer exists.

### 6. Automatic Account Linking

Users can link multiple OAuth providers to one account. Controlled by:

- `autoLink`: `'verifiedEmail'` | `'always'` | `'never'`
- `allowDifferentEmails`: Allow linking accounts with different emails
- `updateUserInfoOnLink`: Update user profile when linking

## Core Interfaces

```ts
interface User {
  id: string
  name?: string | null
  email?: string | null
  emailVerified?: boolean | null
  image?: string | null
  role?: string | null
}

interface Session {
  id: string
  sub: string // User ID
  [key: string]: unknown
}

interface Adapter {
  getUser
  getUserByEmail
  getUserByAccount
  getAccounts
  getUserAndAccounts
  createUser
  updateUser
  deleteUser
  linkAccount
  unlinkAccount
  updateAccount
}
```

## Framework Integrations

### SvelteKit

```ts
// src/routes/api/auth/[...gau]/+server.ts
import { SvelteKitAuth } from '@rttnd/gau/sveltekit'

export const { GET, POST, handle } = SvelteKitAuth(auth)

// Client: use createSvelteAuth() or useAuth()
```

### SolidStart

```ts
import { SolidStartAuth } from '@rttnd/gau/solidstart'

export const { GET, POST } = SolidStartAuth(auth)

// Client: use createSolidAuth() or useAuth()
```

### Vanilla/Bun/ElysiaJS

```ts
import { createHandler } from '@rttnd/gau/core'

const handler = createHandler(auth)
Bun.serve({ fetch: handler })
```

## Database Adapters

Currently supports Drizzle ORM with:

- SQLite (better-sqlite3, libSQL/Turso)
- PostgreSQL (pg, pglite)
- MySQL (planned)

Memory adapter available for testing.

## OAuth Providers

Built-in: `GitHub`, `Google`, `Discord`, `Facebook`, `Microsoft`

Each provider implements:

```ts
interface OAuthProvider {
  id: string
  getAuthorizationUrl: (state, codeVerifier, options) => any
  validateCallback: (code, codeVerifier, redirectUri) => any
  refreshAccessToken?: (refreshToken) => any
}
```

## Tauri Support

Special handling for desktop and mobile apps:

- Deep linking callback via custom URI scheme
- Token-based session strategy
- Works with `@tauri-apps/api` and plugins

## File Naming Conventions

- `*.svelte.ts` - Svelte 5 runes files
- Test files in `packages/gau/test/` mirror src structure
- Examples in `packages/example-*`

## Testing

Uses Vitest with projects:

- `fast` - Quick unit tests (SQLite)
- `pg` - PostgreSQL integration tests
