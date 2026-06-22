/// <reference types="@solidjs/start/env" />

import type { GauServerSession, GauSession, ProviderIds } from '@rttnd/gau'
import type { Auth } from './server/auth'

declare global {
  namespace App {
    interface RequestEventLocals {
      getSession: () => Promise<GauSession<ProviderIds<Auth>>>
      getServerSession: () => Promise<GauServerSession<ProviderIds<Auth>>>
    }
  }
}

export {}
