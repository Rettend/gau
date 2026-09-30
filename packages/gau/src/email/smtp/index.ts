import type { EmailSender } from '../index'
import type SMTPTransport from 'nodemailer/lib/smtp-transport'
import { createTransport } from 'nodemailer'

/** Node/Bun only. Install the optional nodemailer peer dependency. */
export function SMTP(config: SMTPTransport.Options | string): EmailSender {
  const transport = typeof config === 'string' ? createTransport(config) : createTransport(config)
  return async (message) => {
    const result = await transport.sendMail(message)
    if (result.rejected.length) throw new Error('SMTP rejected the recipient.')
  }
}
