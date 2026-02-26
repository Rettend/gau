const baseStyles = `
  body {
    font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";
    background-color: #09090b;
    color: #fafafa;
    display: flex;
    justify-content: center;
    align-items: center;
    height: 100vh;
    margin: 0;
    text-align: center;
  }
  .card {
    background-color: #18181b;
    border: 1px solid #27272a;
    border-radius: 0.75rem;
    padding: 2rem;
    max-width: 320px;
  }
  h1 {
    font-size: 1.25rem;
    font-weight: 600;
    margin: 0 0 0.5rem;
  }
  p {
    margin: 0;
    color: #a1a1aa;
  }
  .error-code {
    font-family: ui-monospace, monospace;
    font-size: 0.75rem;
    color: #71717a;
    margin-top: 0.5rem;
  }
  a {
    display: inline-block;
    margin-top: 1rem;
    color: #3b82f6;
    text-decoration: none;
  }
  a:hover {
    text-decoration: underline;
  }
`

export interface ErrorPageOptions {
  /** Error title (default: "Authentication Error") */
  title?: string
  /** Error message to display */
  message: string
  /** Error code to display */
  code?: string
  /** URL to redirect to (shown as "Go back" link, also used for auto-redirect) */
  redirectUrl?: string
  /** Auto-redirect after showing error (default: true if redirectUrl provided) */
  autoRedirect?: boolean
  /** Delay before auto-redirect in ms (default: 3000) */
  redirectDelay?: number
  /** Attempt to close the window after redirect (for OAuth popups) */
  autoClose?: boolean
}

export function renderErrorPage(options: ErrorPageOptions): string {
  const {
    title = 'Authentication Error',
    message,
    code,
    redirectUrl,
    autoRedirect = !!redirectUrl,
    redirectDelay = 3000,
    autoClose = true,
  } = options

  const redirectScript = redirectUrl && autoRedirect
    ? `
    window.onload = function() {
      setTimeout(function() {
        window.location.href = ${JSON.stringify(redirectUrl)};
        ${autoClose ? 'setTimeout(window.close, 500);' : ''}
      }, ${redirectDelay});
    };
    `
    : ''

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>${baseStyles}</style>
  ${redirectScript ? `<script>${redirectScript}</script>` : ''}
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
    ${code ? `<p class="error-code">${escapeHtml(code)}</p>` : ''}
    ${redirectUrl ? `<a href="${escapeHtml(redirectUrl)}">Go back</a>` : ''}
  </div>
</body>
</html>`
}

export interface SuccessPageOptions {
  /** Success title (default: "Authentication Successful") */
  title?: string
  /** Success message to display */
  message?: string
  /** URL to redirect to */
  redirectUrl: string
  /** Attempt to close the window after redirect (for OAuth popups) */
  autoClose?: boolean
}

export function renderSuccessPage(options: SuccessPageOptions): string {
  const {
    title = 'Authentication Successful',
    message = 'You can now close this window.',
    redirectUrl,
    autoClose = true,
  } = options

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>${baseStyles}</style>
  <script>
    window.onload = function() {
      const url = ${JSON.stringify(redirectUrl)};
      window.location.href = url;
      ${autoClose ? 'setTimeout(window.close, 500);' : ''}
    };
  </script>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
  </div>
</body>
</html>`
}

export interface CancelledPageOptions {
  /** Title (default: "Authentication Cancelled") */
  title?: string
  /** Message to display */
  message?: string
  /** URL to redirect to */
  redirectUrl?: string
  /** Attempt to close the window after redirect (for OAuth popups) */
  autoClose?: boolean
}

export function renderCancelledPage(options: CancelledPageOptions = {}): string {
  const {
    title = 'Authentication Cancelled',
    message = 'Redirecting you back to the app...',
    redirectUrl = '/',
    autoClose = true,
  } = options

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>${baseStyles}</style>
  <script>
    window.onload = function() {
      const url = ${JSON.stringify(redirectUrl)};
      window.location.href = url;
      ${autoClose ? 'setTimeout(window.close, 500);' : ''}
    };
  </script>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
  </div>
</body>
</html>`
}

export function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}
