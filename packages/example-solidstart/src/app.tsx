// @refresh reload
import { AuthProvider } from '@rttnd/gau/client/solid'
import { Router } from '@solidjs/router'
import { FileRoutes } from '@solidjs/start/router'
import { Suspense } from 'solid-js'
import { clientEnv } from './env/client'
import '@unocss/reset/tailwind.css'
import 'virtual:uno.css'

export default function App() {
  return (
    <AuthProvider baseUrl={clientEnv.VITE_API_URL}>
      <Router
        root={props => (
          <Suspense>{props.children}</Suspense>
        )}
      >
        <FileRoutes />
      </Router>
    </AuthProvider>
  )
}
