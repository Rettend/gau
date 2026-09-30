# Gau with Marko

A Marko 6 and Marko Run app with the same dark styling and OAuth account controls as the other Gau examples. It supports GitHub, Google, Microsoft, Facebook, and Discord.

From the repository root:

```sh
bun install
bun run build
```

Copy `.env.example` to `.env` in this directory. Set a random auth secret and the credentials for the providers you want to try. Callback URLs use `http://localhost:3000/api/auth/callback/PROVIDER`, for example:

- GitHub: `http://localhost:3000/api/auth/callback/github`
- Google: `http://localhost:3000/api/auth/callback/google`

```sh
bun run --cwd packages/example-marko-run dev
```

Open `http://localhost:3000`. Sign in, link another provider, unlink it, refresh the session, and inspect the session data. Keep at least one linked account.

Home, Account, and Protected page use full-page navigation. Account and Protected page redirect home when signed out. The protected page shows the session read on the server; the other pages also use a reactive session tag. Signing out submits a form and redirects home.

The memory adapter loses users when the server restarts. Use a persistent adapter for a deployed app.

Run `bun run --cwd packages/example-marko-run check` to build and check the app's types.
