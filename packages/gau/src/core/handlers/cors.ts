import type { Auth } from '../createAuth'

export function isOriginAllowed(origin: string, auth: Auth): boolean {
  if (auth.cors === false)
    return false
  const cfg = auth.cors
  if (cfg.allowedOrigins === 'all')
    return true
  if (cfg.allowedOrigins === 'trust') {
    if (auth.trustHosts === 'all')
      return true
    try {
      const u = new URL(origin)
      return auth.trustHosts.includes(u.host) || auth.trustHosts.includes(u.hostname)
    }
    catch {
      return false
    }
  }
  if (cfg.allowedOrigins.includes('*'))
    return true
  try {
    const u = new URL(origin)
    return cfg.allowedOrigins.includes(origin) || cfg.allowedOrigins.includes(u.origin) || cfg.allowedOrigins.includes(u.host) || cfg.allowedOrigins.includes(u.hostname)
  }
  catch {
    return cfg.allowedOrigins.includes(origin)
  }
}

export function applyCors(request: Request, response: Response, auth: Auth): Response {
  if (auth.cors === false)
    return response

  const origin = request.headers.get('Origin') || request.headers.get('origin')
  if (!origin)
    return response

  if (!isOriginAllowed(origin, auth))
    return response

  const cfg = auth.cors
  appendVary(response.headers, 'Origin')
  const allowCreds = cfg.allowCredentials
  const allowOriginValue = (cfg.allowedOrigins === 'all' && !allowCreds) ? '*' : origin
  response.headers.set('Access-Control-Allow-Origin', allowOriginValue)
  if (allowCreds)
    response.headers.set('Access-Control-Allow-Credentials', 'true')
  response.headers.set('Access-Control-Allow-Headers', cfg.allowedHeaders.join(', '))
  response.headers.set('Access-Control-Allow-Methods', cfg.allowedMethods.join(', '))
  if (cfg.exposeHeaders?.length)
    response.headers.set('Access-Control-Expose-Headers', cfg.exposeHeaders.join(', '))
  return response
}

function appendVary(headers: Headers, value: string): void {
  const current = headers.get('Vary')
  if (!current) {
    headers.set('Vary', value)
    return
  }

  const values = current.split(',').map(part => part.trim().toLowerCase())
  if (!values.includes('*') && !values.includes(value.toLowerCase()))
    headers.set('Vary', `${current}, ${value}`)
}

export function handlePreflight(request: Request, auth: Auth): Response {
  if (auth.cors === false)
    return new Response(null, { status: 204 })

  const origin = request.headers.get('Origin') || request.headers.get('origin')
  const cfg = auth.cors
  const headers: Record<string, string> = {}
  if (origin && isOriginAllowed(origin, auth)) {
    const allowCreds = cfg.allowCredentials
    const allowOriginValue = (cfg.allowedOrigins === 'all' && !allowCreds) ? '*' : origin
    headers['Access-Control-Allow-Origin'] = allowOriginValue
    if (allowCreds)
      headers['Access-Control-Allow-Credentials'] = 'true'
  }
  headers['Access-Control-Allow-Headers'] = cfg.allowedHeaders.join(', ')
  headers['Access-Control-Allow-Methods'] = cfg.allowedMethods.join(', ')
  if (cfg.maxAge != null)
    headers['Access-Control-Max-Age'] = String(cfg.maxAge)
  if (cfg.exposeHeaders?.length)
    headers['Access-Control-Expose-Headers'] = cfg.exposeHeaders.join(', ')
  return new Response(null, { status: 204, headers })
}
