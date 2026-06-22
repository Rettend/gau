import process from 'node:process'
import { parseEnv, serverScheme } from './schema'

export const serverEnv = parseEnv(serverScheme, process.env, 'server')
