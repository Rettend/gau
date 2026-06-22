// @refresh reload
import { AuthProvider } from '@rttnd/gau/client/solid2'
import { Router } from '@solidjs/router'
import { FileRoutes } from '@solidjs/start/router'
import { createSignal, Loading } from 'solid-js'
import { clientEnv } from '~/env/client'
import { getSession } from '~/server/session'
import '@unocss/reset/tailwind.css'
import 'virtual:uno.css'

export default function App() {
  return (
    <Router
      root={(props) => {
        const [session] = createSignal(() => getSession(), { deferStream: true })

        return (
          <Loading>
            <AuthProvider session={session} baseUrl={clientEnv.VITE_API_URL}>
              {props.children}
            </AuthProvider>
          </Loading>
        )
      }}
    >
      <FileRoutes />
    </Router>
  )
}
