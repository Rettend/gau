import type { GauAstroLocals } from '@rttnd/gau/astro'
import type { auth } from './server/auth'

declare global {
  namespace App {
    interface Locals extends GauAstroLocals<typeof auth> {}
  }
}
