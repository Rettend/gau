import { getRandomValues, randomUUID } from 'node:crypto'
import { vi } from 'vitest'

declare global {
  // eslint-disable-next-line vars-on-top
  var __TAURI_INTERNALS__: object | undefined
  interface GlobalThis {

    __TAURI_INTERNALS__?: object
  }
}

Object.defineProperty(globalThis, 'crypto', {
  value: {
    randomUUID: vi.fn(randomUUID),
    subtle: globalThis.crypto.subtle,
    getRandomValues: vi.fn(getRandomValues),
  },
  writable: true,
})
