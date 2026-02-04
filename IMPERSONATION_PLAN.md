# User Impersonation Implementation Plan

## Goal

Add opt-in user impersonation with minimal API surface. Invisible to users who don't enable it.

---

## Configuration

New optional `impersonation` key in `createAuth`:

```ts
createAuth({
  impersonation: {
    enabled: true,
    allowedRoles?: string[]        // Roles that can impersonate (default: adminRoles)
    cannotImpersonate?: string[]   // Roles that cannot be impersonated (default: adminRoles)
    maxTTL?: number                // Max impersonation duration in seconds (default: 3600)
    onImpersonate?: (ctx) => void  // Audit hook
  }
})
```

If `impersonation` is undefined or `enabled: false`, methods throw/return null.

---

## New Methods on `Auth`

### `auth.startImpersonation(adminUserId, targetUserId, options?)`

**Options:**

- `ttl?: number` - Session duration (capped by `maxTTL`)
- `reason?: string` - Passed to `onImpersonate` hook

**Returns:** `ImpersonationResult`

- `token` - The impersonation session JWT
- `cookie` - Set-Cookie for impersonation session
- `originalCookie` - Set-Cookie for stashed admin session

**Behavior:**

1. Validate impersonation is enabled
2. Validate admin exists and has allowed role
3. Validate target exists and doesn't have protected role
4. Call `onImpersonate` hook if defined
5. Issue impersonation session with claims: `{ impersonatedBy, impersonationExpiresAt }`
6. Sign admin's original session into a stash cookie

### `auth.endImpersonation(request)`

**Returns:** `EndImpersonationResult | null`

- `token` - Restored admin session token
- `cookie` - Set-Cookie for restored session
- `clearCookies` - Array of Set-Cookie headers to clear stash

**Behavior:**

1. Extract stashed session from cookie
2. Validate it's still valid
3. Reissue as primary session
4. Return clear instructions for stash cookie

Returns `null` if no stash cookie found (graceful no-op).

---

## Cookies

| Cookie | Purpose |
|--------|---------|
| `__gau-session-token` | Primary session (impersonation session during impersonation) |
| `__gau-session-stash` | Stashed admin session (only exists during impersonation) |

Both are `HttpOnly`, `Secure`, `SameSite=Lax`.

---

## Session Claims

During impersonation, the session JWT includes:

```ts
{
  sub: targetUserId,
  impersonatedBy: adminUserId,
  impersonationExpiresAt: number  // epoch seconds
}
```

---

## Client Awareness

### Session Type Extension

```ts
interface Session {
  // existing...
  impersonatedBy?: string
  impersonationExpiresAt?: number
}
```

### Client Helper (optional convenience)

```ts
// In useAuth return object or as a utility
function isImpersonating(session: Session | null): boolean {
  return session?.impersonatedBy != null
}
```

---

## Framework Integration

**Not built-in.** Docs will provide copy-paste examples:

- `POST /api/admin/impersonate` - Calls `auth.startImpersonation()`
- `POST /api/admin/unimpersonate` - Calls `auth.endImpersonation()`

Examples for both SvelteKit and SolidStart in the advanced guide.

---

## Invisibility to Non-Users

1. `impersonation` config is **optional and defaults to undefined**
2. `startImpersonation` / `endImpersonation` methods always exist but:
   - Return `null` or throw `AuthError` if impersonation not enabled
3. No new routes, no new cookies unless actively used
4. Session types use optional fields (`impersonatedBy?: string`)
5. No client-side changes unless user checks `session.impersonatedBy`

---

## Security Considerations (for docs)

- Always validate admin status in your route handler
- Log all impersonation events via `onImpersonate`
- Set reasonable `maxTTL` (default 1 hour)
- Consider UI indicator showing impersonation is active
- Impersonation sessions should be visually distinct

---

## Implementation Order

1. **Types** - Add `ImpersonationConfig`, `ImpersonationResult`, session claim types
2. **Config parsing** - Handle `impersonation` in `createAuth`, merge with defaults
3. **Cookie helpers** - Stash/restore logic for `__gau-session-stash`
4. **`startImpersonation`** - Core method
5. **`endImpersonation`** - Core method
6. **Tests** - Unit tests for both methods
7. **Docs** - Update `advanced.mdx` with full guide and framework examples
