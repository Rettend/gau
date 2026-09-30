# Gau with Astro

An Astro 7 app with the same dark styling and OAuth account controls as the other Gau examples. It supports GitHub, Google, Microsoft, Facebook, and Discord. Two Svelte islands share a browser client; the header island stays mounted during ClientRouter navigation and accepts fresh session props.

From the repository root:

```sh
bun install
bun run build
```

Copy `.env.example` to `.env` in this directory. Set a random auth secret and the credentials for the providers you want to try. Callback URLs use `http://localhost:4321/api/auth/callback/PROVIDER`, for example:

- GitHub: `http://localhost:4321/api/auth/callback/github`
- Google: `http://localhost:4321/api/auth/callback/google`

```sh
bun run --cwd packages/example-astro dev
```

Open `http://localhost:4321`. Sign in, link another provider, unlink it, refresh the session, and inspect the session data. Keep at least one linked account.

Home and Account use ClientRouter navigation. The Protected page link uses full-page navigation and shows the session read on the server. Account and Protected page redirect home when signed out. Signing out submits a form and redirects home.

The memory adapter loses users when the server restarts. Use a persistent adapter for a deployed app.

```sh
bun run --cwd packages/example-astro check
bun run --cwd packages/example-astro build
```
