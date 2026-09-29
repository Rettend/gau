#!/usr/bin/env node
import { Buffer } from 'node:buffer'
import process from 'node:process'

async function generateAuthSecret(): Promise<string> {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )

  const exported = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey)
  const base64 = Buffer.from(exported).toString('base64')
  const base64url = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
  return base64url
}

async function main() {
  const args = process.argv.slice(2)
  if (args[0] === 'secret') {
    const secret = await generateAuthSecret()
    console.log(`Add this to your .env file:\n\nAUTH_SECRET=${secret}`)
  }
  else {
    console.log('Usage: bunx gau secret')
  }
}

main().catch(console.error)
