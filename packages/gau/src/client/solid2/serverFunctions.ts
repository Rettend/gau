import type { ServerFunctionsClientConfig } from '@solidjs/web/server-functions/client'
import { getSessionToken, handleRefreshedToken } from '../token'

export type GauServerFunctionsClientConfig = ServerFunctionsClientConfig

export interface GauServerFunctionsClientOptions {
  /**
   * Solid's server-function endpoint. Use an absolute URL for a remote
   * backend. This is intentionally independent from `AuthProvider.baseUrl`.
   * @default '/_server'
   */
  endpoint?: string
}

/**
 * Creates composable Solid 2 server-function transport hooks for Gau.
 * Pass the result to `configureServerFunctionsClient()` before hydration.
 */
export function createGauServerFunctionsClientConfig(
  options: GauServerFunctionsClientOptions = {},
): GauServerFunctionsClientConfig {
  return {
    ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
    prepareRequest(init) {
      const token = getSessionToken()
      if (!token)
        return init

      const headers = new Headers(init.headers)
      if (headers.has('Authorization'))
        return init

      headers.set('Authorization', `Bearer ${token}`)
      return { ...init, headers }
    },
    responseHandler: {
      handle(response) {
        handleRefreshedToken(response)
      },
    },
  }
}
