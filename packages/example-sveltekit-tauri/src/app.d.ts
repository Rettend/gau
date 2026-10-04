import type { GauSession } from '@rttnd/gau'

declare global {
  const __TAURI_DESKTOP__: boolean

  namespace App {
    // interface Error {}
    interface Locals {
      getSession: () => Promise<GauSession>
    }
    // interface PageData {}
    // interface Platform {}
  }
}

export {}
