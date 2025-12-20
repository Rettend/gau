// @refresh reload
import { AuthProvider } from '@rttnd/gau/client/solid'
import { createAsync, Router } from '@solidjs/router'
import { FileRoutes } from '@solidjs/start/router'
import { Suspense } from 'solid-js'
import { clientEnv } from '~/env/client'
import { getSession } from '~/server/session'
import '@unocss/reset/tailwind.css'
import 'virtual:uno.css'

export default function App() {
  return (
    <Router
      root={(props) => {
        const session = createAsync(() => getSession())
        return (
          <Suspense>
            <AuthProvider session={session} baseUrl={clientEnv.VITE_API_URL}>
              {props.children}
            </AuthProvider>
          </Suspense>
        )
      }}
    >
      <FileRoutes />
    </Router>
  )
}
