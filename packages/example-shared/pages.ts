import type { Auth } from '@rttnd/gau'
import { getSessionTokenFromRequest, toClientSession } from '@rttnd/gau'

function escape(value: string) {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  )
}

export function createPages(auth: Auth, framework: 'bun' | 'elysia') {
  return async (request: Request) => {
    const url = new URL(request.url)
    const path = url.pathname
    if (!['/', '/account', '/protected', '/auth/error'].includes(path))
      return new Response('Not found', { status: 404 })

    const { token } = getSessionTokenFromRequest(request)
    const serverSession = token ? await auth.validateSession(token) : null
    if ((path === '/account' || path === '/protected') && !serverSession?.user)
      return Response.redirect(new URL('/', url), 302)
    const session = {
      ...toClientSession(serverSession ?? { user: null, session: null }),
      providers: [...auth.providerMap.keys()],
    }
    const title =
      path === '/account'
        ? 'Your account'
        : path === '/protected'
          ? 'Protected page'
          : path === '/auth/error'
            ? 'Authentication error'
            : 'Authentication'
    const content =
      path === '/auth/error'
        ? `<div class="example-panel example-stack"><p>${escape(url.searchParams.get('message') ?? 'Could not complete authentication. Try again.')}</p><p class="example-muted">${escape(url.searchParams.get('code') ?? '')}</p><div><a class="example-button" href="/">Go back</a></div></div>`
        : `<div class="example-stack">
          ${path === '/protected' ? '<p class="example-muted">This session was read on the server for this page request.</p>' : ''}
          <div id="session" class="example-panel example-row"><span>${escape(session.user?.name ?? session.user?.email ?? (session.user ? session.user.id : 'Signed out.'))}</span>
            <button id="signout" class="example-button example-danger" ${session.user ? '' : 'hidden'} aria-label="Sign out">/logout</button>
          </div>
          ${
            path === '/protected'
              ? `<pre class="example-panel">${escape(JSON.stringify(session, null, 2))}</pre>`
              : `
          <section id="signin-section" class="example-stack" ${session.user ? 'hidden' : ''}><h2>Sign In</h2><div id="signin" class="example-row"></div></section>
          <section id="linked-section" class="example-stack" ${session.user ? '' : 'hidden'}><h2>Linked Accounts</h2><div id="linked" class="example-row"></div></section>
          <section id="unlinked-section" class="example-stack" hidden><h2>Link More Accounts</h2><div id="unlinked" class="example-row"></div></section>
          <div class="example-row"><button id="refresh" class="example-button">Refresh session</button><a href="/protected" class="example-muted">View protected page →</a></div>
          <details class="example-panel example-session"><summary class="example-muted">Session data</summary><pre id="session-data">${escape(JSON.stringify(session, null, 2))}</pre></details>`
          }
          <p id="error" role="alert" class="example-error" hidden></p>
        </div>`
    return new Response(
      `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Gau · ${framework}</title><link rel="stylesheet" href="/styles.css"></head>
<body class="example-shell" data-framework="${framework}"><div class="example-content">
<header class="example-header"><a class="example-brand" href="/">gau <span>/ ${framework}</span></a>
<nav class="example-nav" aria-label="Main">${[
        ['/', 'Home'],
        ['/account', 'Account'],
        ['/protected', 'Protected page'],
      ]
        .map(([href, label]) => `<a href="${href}"${path === href ? ' aria-current="page"' : ''}>${label}</a>`)
        .join('')}</nav></header>
<main><h1 class="example-title${path === '/auth/error' ? ' example-error' : ''}">${title}</h1>${content}</main></div>
<script type="application/json" id="initial-session">${JSON.stringify(session).replace(/</g, '\\u003c')}</script>
${path === '/auth/error' ? '' : '<script type="module" src="/client.js"></script>'}</body></html>`,
      {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      },
    )
  }
}
