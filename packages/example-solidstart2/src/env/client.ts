import { clientScheme, parseEnv } from './schema'

export const clientEnv = parseEnv(clientScheme, import.meta.env, 'client')
