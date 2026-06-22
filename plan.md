# gau cleanup plan

Temporary working plan for the current refactor pass.

## Ground rules

- Skip example apps unless a touched change forces a follow-up.
- Use `bun` only.
- Use `tsgo`/repo checks where relevant.
- Do **not** run lint during the refactor passes.
- Keep changes local to the current large item.
- Create **one local commit per large item** after checks pass.

## GitButler CLI quick guide

Fast path for this repo, assuming one applied branch/stack:

1. Inspect current state:
   - `but status`
   - `but diff`
2. Do a large, coherent batch of work.
3. Commit the whole batch to the active stack:
   - `but commit -m "<message>"`

Useful commands:

- `but status` — workspace + applied stack overview
- `but diff` — inspect current uncommitted diff
- `but branch list` — see applied/unapplied branches
- `but branch new <name>` — create a new stack if we need one
- `but commit -m "<message>"` — commit all current changes to the active stack
- `but commit <branch> -m "<message>"` — commit to a specific stack when multiple are applied
- `but stage <file-or-hunk> <branch>` — only when we need to split changes across stacks
- `but undo` — revert the last GitButler operation quickly

Recommended workflow here:

- Prefer **large-item commits**, not tiny churn commits.
- Prefer `but commit -m ...` over fine-grained staging unless a change truly belongs on another stack.
- Check `but status` + `but diff` right before each commit.

## Large items

### 1. Shared client/session flow + obvious client bugs

Goal:

- Extract duplicated browser/Tauri auth action flow from the Svelte and Solid clients into shared helpers built on `createAuthClient`.

Scope:

- `packages/gau/src/client/vanilla/index.ts`
- `packages/gau/src/client/svelte/index.svelte.ts`
- `packages/gau/src/client/solid/index.tsx`
- `packages/gau/src/runtimes/tauri/index.ts`

Expected outcomes:

- One source of truth for sign-in/link defaults, redirect callback handling, and Tauri bridge startup.
- Fix obvious bugs/regressions in the current client flow.
- Remove framework-specific duplicate fallback code where safe.

Follow-through:

- Add focused tests for shared client behavior.

### 2. Shared SvelteKit/SolidStart server-session helpers

Goal:

- Deduplicate auth instance resolution, server-session lookup, null-session fallback, provider list generation, and locals caching.

Scope:

- `packages/gau/src/sveltekit/index.ts`
- `packages/gau/src/solidstart/index.ts`
- small shared helper(s) under `packages/gau/src/core` or a nearby shared integration module

### 3. Break up `handleCallback()` without changing behavior

Goal:

- Split callback parsing, hook execution, user/account resolution, persistence, and response building into smaller internal helpers.

Scope:

- `packages/gau/src/core/handlers/callback.ts`
- nearby handler helpers if needed

### 4. Normalize provider helpers

Goal:

- Reduce copy-paste across providers and make params/refresh behavior more consistent.

Scope:

- `packages/gau/src/oauth/providers/*`
- `packages/gau/src/oauth/index.ts`
- shared oauth helper(s)

### 5. Collapse Drizzle adapter duplication

Goal:

- Extract common adapter logic while keeping dialect-specific DB calls small and obvious.

Scope:

- `packages/gau/src/adapters/drizzle/sqlite.ts`
- `packages/gau/src/adapters/drizzle/pg.ts`
- shared drizzle helper(s)

### 6. Testing + structure improvements

Goal:

- Improve test coverage and test structure in the touched areas.
- Try to add client-facing tests where practical, even if framework-specific test setup is awkward.

Notes:

- Client tests are currently the hardest part.
- Prefer extracting logic into plain TS helpers so more of it can be tested without full Svelte/Solid component harnesses.
- Also take small local structure wins when they directly support the refactors above.

## Current execution order

1. Create this plan.
2. Implement item 1.
3. Run focused checks/tests.
4. Review diff and do one obvious follow-up if justified.
5. Commit item 1 locally with GitButler.
6. Move to item 2.
