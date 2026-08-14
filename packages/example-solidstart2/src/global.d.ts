/// <reference types="filesystem-routing/types" />

import type { GauSolid2Locals } from '@rttnd/gau/solid2'
import type { Auth } from './server/auth'

declare module '@solidjs/web' {
  interface RequestEventLocals extends GauSolid2Locals<Auth> {}
}

export {}
