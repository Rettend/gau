import type { EmailMessage, EmailSender } from '../index'

type CloudflareConfig =
  | { accountId: string; apiToken: string }
  | { binding: { send: (message: EmailMessage) => Promise<unknown> } }

export function Cloudflare(config: CloudflareConfig): EmailSender {
  return async (message) => {
    if ('binding' in config) {
      await config.binding.send(message)
      return
    }
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.accountId)}/email/sending/send`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
      },
    )
    if (!response.ok) throw new Error(`Cloudflare rejected the email (${response.status}).`)
    const body = (await response.json()) as { success?: boolean; result?: { permanent_bounces?: string[] } }
    if (!body.success || body.result?.permanent_bounces?.length)
      throw new Error('Cloudflare could not accept the email.')
  }
}
