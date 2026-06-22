import { SolidAuth } from '@rttnd/gau/solidstart'
import { auth } from '~/server/auth'

export const { GET, POST, OPTIONS } = SolidAuth(auth)
