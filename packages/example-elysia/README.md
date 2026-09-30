# Gau with Elysia

Copy `.env.example` to `.env` and set your auth secret and OAuth credentials. Callback URLs use `http://localhost:3000/api/auth/callback/github` and `http://localhost:3000/api/auth/callback/google`.

From the repository root:

```sh
bun install
bun run build
bun run --cwd packages/example-elysia dev
```

Open `http://localhost:3000`. Home, Account, and Protected page use full-page navigation. Account and Protected page redirect home when signed out. Sign in, link another provider, refresh the session, or expand Session data.

The memory adapter resets when the server restarts. The layout and browser controls are shared with Bun in `packages/example-shared`.
