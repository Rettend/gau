/// <reference types="@solidjs/start/env" />

import type { GauSession, ProviderIds } from '@rttnd/gau'
import type { Auth } from './server/auth'

declare global {
  namespace App {
    interface RequestEventLocals {
      getSession: () => Promise<GauSession<ProviderIds<Auth>>>
    }
  }
}

declare module 'solid-js/web' {
  interface RequestEvent {
    locals: App.RequestEventLocals
  }
}
