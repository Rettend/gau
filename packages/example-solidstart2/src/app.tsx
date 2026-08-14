// @refresh reload
import { AuthProvider } from '@rttnd/gau/client/solid2'
import type { ParentProps } from 'solid-js'
import { createSignal, Loading } from 'solid-js'
import { clientEnv } from '~/env/client'
import { getSession } from '~/server/session'
import { Router } from './router'
import '@unocss/reset/tailwind.css'
import 'virtual:uno.css'

export default function App() {
  return (
    <Router>
      {props => <AppContent>{props.children}</AppContent>}
    </Router>
  )
}

function AppContent(props: ParentProps) {
  const [session] = createSignal(() => getSession(), { deferStream: true })

  return (
    <Loading fallback={<main>Loading session…</main>}>
      <AuthProvider session={session} baseUrl={clientEnv.VITE_API_URL}>
        {props.children}
      </AuthProvider>
    </Loading>
  )
}
