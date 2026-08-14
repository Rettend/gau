import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGauServerFunctionsClientConfig } from '../../src/client/solid2/serverFunctions'
import { REFRESHED_TOKEN_HEADER, SESSION_TOKEN_KEY } from '../../src/client/token'

vi.mock('esm-env', () => ({ BROWSER: true }))

const storage = (() => {
  let values: Record<string, string> = {}
  return {
    getItem: (key: string) => values[key] ?? null,
    setItem: (key: string, value: string) => { values[key] = value },
    removeItem: (key: string) => { delete values[key] },
    clear: () => { values = {} },
  }
})()

describe('Solid 2 server-function client config', () => {
  beforeEach(() => {
    storage.clear()
    vi.stubGlobal('localStorage', storage)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses the explicitly configured endpoint and injects the current token', async () => {
    storage.setItem(SESSION_TOKEN_KEY, 'token-one')
    const config = createGauServerFunctionsClientConfig({
      endpoint: 'https://api.example.com/_server',
    })

    const init = await config.prepareRequest!({ method: 'POST' }, { id: 'fn', meta: undefined })

    expect(config.endpoint).toBe('https://api.example.com/_server')
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer token-one')

    storage.setItem(SESSION_TOKEN_KEY, 'token-two')
    const next = await config.prepareRequest!({}, { id: 'fn', meta: undefined })
    expect(new Headers(next.headers).get('Authorization')).toBe('Bearer token-two')
  })

  it('does not replace an existing Authorization header', async () => {
    storage.setItem(SESSION_TOKEN_KEY, 'gau-token')
    const config = createGauServerFunctionsClientConfig()
    const initial = { headers: { Authorization: 'Basic existing' } }

    const result = await config.prepareRequest!(initial, { id: 'fn', meta: undefined })

    expect(result).toBe(initial)
    expect(new Headers(result.headers).get('Authorization')).toBe('Basic existing')
  })

  it('observes refreshed bearer tokens from responses', () => {
    const config = createGauServerFunctionsClientConfig()
    const response = new Response(null, {
      headers: { [REFRESHED_TOKEN_HEADER]: 'refreshed-token' },
    })

    config.responseHandler!.handle(response, {
      id: 'fn',
      meta: undefined,
      args: [],
      context: undefined,
    })

    expect(storage.getItem(SESSION_TOKEN_KEY)).toBe('refreshed-token')
  })
})
