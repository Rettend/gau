import type { GauSession } from '@rttnd/gau'
import { createAuthClient } from '@rttnd/gau/client/vanilla'

export function mountAuth() {
  const initial = document.getElementById('initial-session')!
  const auth = createAuthClient({ baseUrl: '/api/auth', session: JSON.parse(initial.textContent!) as GauSession })
  const labels: Record<string, string> = {
    github: 'GitHub',
    google: 'Google',
    microsoft: 'Microsoft',
    facebook: 'Facebook',
    discord: 'Discord',
  }
  // Phosphor icons, matching the UnoCSS icons in the framework examples.
  const paths: Record<string, string> = {
    github:
      'M208.31 75.68A59.78 59.78 0 0 0 202.93 28a8 8 0 0 0-6.93-4a59.75 59.75 0 0 0-48 24h-24a59.75 59.75 0 0 0-48-24a8 8 0 0 0-6.93 4a59.78 59.78 0 0 0-5.38 47.68A58.14 58.14 0 0 0 56 104v8a56.06 56.06 0 0 0 48.44 55.47A39.8 39.8 0 0 0 96 192v8H72a24 24 0 0 1-24-24a40 40 0 0 0-40-40a8 8 0 0 0 0 16a24 24 0 0 1 24 24a40 40 0 0 0 40 40h24v16a8 8 0 0 0 16 0v-40a24 24 0 0 1 48 0v40a8 8 0 0 0 16 0v-40a39.8 39.8 0 0 0-8.44-24.53A56.06 56.06 0 0 0 216 112v-8a58.14 58.14 0 0 0-7.69-28.32M200 112a40 40 0 0 1-40 40h-48a40 40 0 0 1-40-40v-8a41.74 41.74 0 0 1 6.9-22.48a8 8 0 0 0 1.1-7.69a43.8 43.8 0 0 1 .79-33.58a43.88 43.88 0 0 1 32.32 20.06a8 8 0 0 0 6.71 3.69h32.35a8 8 0 0 0 6.74-3.69a43.87 43.87 0 0 1 32.32-20.06a43.8 43.8 0 0 1 .77 33.58a8.09 8.09 0 0 0 1 7.65a41.7 41.7 0 0 1 7 22.52Z',
    google:
      'M228 128a100 100 0 1 1-22.86-63.64a12 12 0 0 1-18.51 15.28A76 76 0 1 0 203.05 140H128a12 12 0 0 1 0-24h88a12 12 0 0 1 12 12',
  }
  const error = document.getElementById('error')!
  const signout = document.getElementById('signout') as HTMLButtonElement
  const refresh = document.getElementById('refresh') as HTMLButtonElement | null

  async function run(action: () => Promise<unknown>) {
    error.hidden = true
    if (refresh) refresh.disabled = true
    try {
      await action()
    } catch {
      error.textContent = 'Could not update the session. Try again.'
      error.hidden = false
    } finally {
      if (refresh) refresh.disabled = false
    }
  }

  function button(label: string, action: () => Promise<unknown>) {
    const element = document.createElement('button')
    element.type = 'button'
    element.className = 'example-button'
    element.textContent = label
    element.onclick = () => {
      void run(action)
    }
    return element
  }

  function addIcon(element: HTMLElement, provider: string) {
    if (!paths[provider]) return
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 256 256')
    svg.setAttribute('aria-hidden', 'true')
    const path = document.createElementNS(svg.namespaceURI, 'path')
    path.setAttribute('fill', 'currentColor')
    path.setAttribute('d', paths[provider])
    svg.append(path)
    element.classList.add('example-provider')
    element.prepend(svg)
  }

  function render(session: GauSession) {
    if (!session.user && location.pathname !== '/') {
      location.replace('/')
      return
    }
    document.querySelector('#session > span')!.textContent = session.user
      ? `> ${session.user.name ?? session.user.email ?? session.user.id}`
      : 'Signed out.'
    signout.hidden = !session.user
    const data = document.getElementById('session-data')
    if (!data) return
    data.textContent = JSON.stringify(session, null, 2)
    const linked = session.accounts?.map((account) => account.provider) ?? []
    const available = (session.providers ?? []).filter((provider) => !linked.includes(provider))
    const signin = document.getElementById('signin')!
    const accounts = document.getElementById('linked')!
    const unlinked = document.getElementById('unlinked')!
    signin.replaceChildren()
    accounts.replaceChildren()
    unlinked.replaceChildren()
    document.getElementById('signin-section')!.hidden = !!session.user
    document.getElementById('linked-section')!.hidden = !session.user
    document.getElementById('unlinked-section')!.hidden = !session.user || !available.length
    for (const provider of linked) {
      const item = document.createElement('div')
      item.className = 'example-panel example-row'
      const label = document.createElement('span')
      label.textContent = labels[provider] ?? provider
      const unlink = button('×', () => auth.unlinkAccount(provider))
      unlink.setAttribute('aria-label', `Unlink ${label.textContent}`)
      unlink.disabled = linked.length === 1
      item.append(label, unlink)
      addIcon(item, provider)
      accounts.append(item)
    }
    for (const provider of available) {
      const target = session.user ? unlinked : signin
      const providerButton = button(labels[provider] ?? provider, async () => {
        const options = { redirectTo: `${location.origin}/account` }
        location.href = session.user ? await auth.linkAccount(provider, options) : await auth.signIn(provider, options)
      })
      addIcon(providerButton, provider)
      target.append(providerButton)
    }
  }

  auth.onSessionChange(render)
  render(auth.session)
  signout.onclick = () => {
    void run(() => auth.signOut())
  }
  if (refresh)
    refresh.onclick = () => {
      void run(() => auth.refreshSession())
    }
  void run(() => auth.handleRedirectCallback((url) => history.replaceState(null, '', url)))
}
