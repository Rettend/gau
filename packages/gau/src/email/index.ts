import { escapeHtml } from '../core/templates'

export interface EmailMessage {
  from: string
  to: string
  subject: string
  text: string
  html: string
}

/** Resolve when the service accepts the message; reject on failure. */
export type EmailSender = (message: EmailMessage) => Promise<void>

export interface EmailTemplateContext {
  email: string
  code?: string
  url?: string
  expiresAt: Date
  purpose: 'signin' | 'link'
}

export interface EmailConfig {
  from: string
  send: EmailSender
  mode?: 'code' | 'link' | 'both'
  /** Seconds. Defaults to 600. */
  expiresIn?: number
  /** Defaults to 5. */
  maxAttempts?: number
  linkOnly?: boolean
  render?: (
    context: EmailTemplateContext,
  ) => Pick<EmailMessage, 'subject' | 'text' | 'html'> | Promise<Pick<EmailMessage, 'subject' | 'text' | 'html'>>
  rateLimit?: {
    /** Seconds between sends to one address. Defaults to 60. */
    resendAfter?: number
    /** Sends per address per hour. Defaults to 5. */
    perAddress?: number
    /** Sends per IP per hour. Defaults to 20. */
    perIp?: number
    /** Total sends per hour. Defaults to 100. */
    total?: number
    /** Read the client address from your trusted runtime, not arbitrary forwarded headers. */
    getClientAddress?: (request: Request) => string | null | Promise<string | null>
  }
}

export interface EmailProvider {
  id: 'email'
  type: 'email'
  linkOnly?: boolean
  config: EmailConfig & { mode: 'code' | 'link' | 'both'; expiresIn: number; maxAttempts: number }
}

export function Email(config: EmailConfig): EmailProvider {
  const resolved = { ...config, mode: config.mode ?? 'code', expiresIn: config.expiresIn ?? 600, maxAttempts: config.maxAttempts ?? 5 }
  if (!['code', 'link', 'both'].includes(resolved.mode)) throw new Error('Unknown email mode.')
  for (const value of [
    resolved.expiresIn,
    resolved.maxAttempts,
    ...Object.values(config.rateLimit ?? {}).filter((v) => typeof v === 'number'),
  ]) {
    if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error('Email limits must be positive integers.')
  }
  if (!config.from || /[\r\n]/.test(config.from)) throw new Error('Email requires a valid sender address.')
  return { id: 'email', type: 'email', linkOnly: config.linkOnly, config: resolved }
}

export function renderEmail({
  code,
  url,
  expiresAt,
  purpose,
}: EmailTemplateContext): Pick<EmailMessage, 'subject' | 'text' | 'html'> {
  const subject = purpose === 'link' ? 'Verify your email' : 'Sign in to your account'
  const expiry = `Expires at ${expiresAt.toISOString()}. If you did not request this email, you can ignore it.`
  return {
    subject,
    text: [
      code && `Your code: ${code}`,
      url && `Continue in the browser where you requested this email: ${url}`,
      expiry,
    ]
      .filter(Boolean)
      .join('\n\n'),
    html: `<h1>${subject}</h1>${code ? `<p>Your code: <strong>${code}</strong></p>` : ''}${url ? `<p><a href="${escapeHtml(url)}">Continue</a> in the browser where you requested this email.</p>` : ''}<p>${expiry}</p>`,
  }
}
