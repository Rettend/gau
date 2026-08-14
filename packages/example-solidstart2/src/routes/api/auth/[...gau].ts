import { SolidAuth } from '@rttnd/gau/solid2'
import { auth } from '~/server/auth'

export const { GET, POST, OPTIONS } = SolidAuth(auth)
