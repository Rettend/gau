# Gau Solid 2 fullstack example

This example uses Solid 2 RC with `@solidjs/vite-plugin` start mode,
`filesystem-routing`, and Gau's preview `@rttnd/gau/solid2` Fetch integration.

It intentionally has no SolidStart, Vinxi, or Nitro dependency. Run `bun run
build`, then `bun run preview` to exercise the host-neutral Vite handler.

## Email login

Set `RESEND_TOKEN` in `.env`. The default sender, `Gau <onboarding@resend.dev>`,
can only send to the email address on your Resend account. To send to other
people, verify a domain in Resend and set `EMAIL_FROM` to an address on it.

Run `bun run db:push` against your development database to add the verification
table, then `bun run dev`. Enter your email to receive a code and a sign-in link.
Enter the code in the app, or open the link in the browser where you requested it.
You can also link an email after signing in with a social account.
