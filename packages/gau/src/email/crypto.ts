export function randomSecret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function randomCode(): string {
  const values = new Uint32Array(1)
  do {
    crypto.getRandomValues(values)
  } while (values[0]! >= 4294000000)
  return String(values[0]! % 1000000).padStart(6, '0')
}
