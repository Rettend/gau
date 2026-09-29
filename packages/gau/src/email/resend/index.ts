import type { EmailSender } from '../index'

export function Resend({ apiKey }: { apiKey: string }): EmailSender {
  return async (message) => {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    })
    if (!response.ok) throw new Error(`Resend rejected the email (${response.status}).`)
  }
}
