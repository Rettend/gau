import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { Cloudflare } from '../../src/email/cloudflare'
import { Resend } from '../../src/email/resend'
import { SMTP } from '../../src/email/smtp'

const smtp = vi.hoisted(() => ({ sendMail: vi.fn(), createTransport: vi.fn() }))
vi.mock('nodemailer', () => ({ createTransport: smtp.createTransport.mockReturnValue({ sendMail: smtp.sendMail }) }))

const message = {
  from: 'login@example.com',
  to: 'user@example.com',
  subject: 'Sign in',
  text: 'Your code: 123456',
  html: '<p>123456</p>',
}
afterEach(() => {
  vi.restoreAllMocks()
  smtp.sendMail.mockReset()
})

describe('email senders', () => {
  it('sends through Resend without exposing API errors or credentials', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
    await Resend({ apiKey: 'secret' })(message)
    expect(fetch).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({
        body: JSON.stringify(message),
        headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      }),
    )
    fetch.mockResolvedValue(new Response('sensitive details', { status: 429 }))
    await expect(Resend({ apiKey: 'secret' })(message)).rejects.toThrow('Resend rejected the email (429).')
  })

  it('handles Cloudflare API failures and rejected recipients', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ success: true }))
    const send = Cloudflare({ accountId: 'account', apiToken: 'token' })
    await send(message)
    expect(fetch).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/accounts/account/email/sending/send',
      expect.objectContaining({ body: JSON.stringify(message) }),
    )
    fetch.mockResolvedValue(Response.json({ success: false }))
    await expect(send(message)).rejects.toThrow('could not accept')
    fetch.mockResolvedValue(Response.json({ success: true, result: { permanent_bounces: ['user@example.com'] } }))
    await expect(send(message)).rejects.toThrow('could not accept')
  })

  it('accepts a Cloudflare Worker binding', async () => {
    const binding = { send: vi.fn(async () => ({ messageId: 'id' })) }
    await Cloudflare({ binding })(message)
    expect(binding.send).toHaveBeenCalledWith(message)
  })

  it('uses SMTP transport and rejects refused recipients', async () => {
    const send = SMTP({ host: 'mail.example.com', port: 465, secure: true })
    smtp.sendMail.mockResolvedValue({ rejected: [] })
    await send(message)
    expect(smtp.sendMail).toHaveBeenCalledWith(message)
    smtp.sendMail.mockResolvedValue({ rejected: ['user@example.com'] })
    await expect(send(message)).rejects.toThrow('SMTP rejected')
  })
})
