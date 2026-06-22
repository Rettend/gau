import { Buffer } from 'node:buffer'
import { v7 } from 'uuid'

export function uuidV7Base64url(): string {
  const uuidBytes = v7(undefined, Buffer.alloc(16))
  return uuidBytes.toString('base64url')
}
