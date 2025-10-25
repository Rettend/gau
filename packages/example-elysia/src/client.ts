import type { GauSession } from '@rttnd/gau'
import type { ProviderIds } from '@rttnd/gau/core'
import type { Auth } from './auth'
import { createAuthClient } from '@rttnd/gau/client/vanilla'

type Provider = ProviderIds<Auth>
type Session = GauSession<Provider>

const auth = createAuthClient<Auth>({
  baseUrl: '/api/auth',
})

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el)
    throw new Error(`Missing element: ${id}`)
  return el as T
}

const sessionEl = byId<HTMLDivElement>('session')
const signinEl = byId<HTMLDivElement>('signin')
const linkedEl = byId<HTMLDivElement>('linked')
const unlinkedEl = byId<HTMLDivElement>('unlinked')
const signoutBtn = byId<HTMLButtonElement>('signout')

function renderSession(session: Session) {
  const root = document.querySelector('[un-cloak]')
  root?.removeAttribute('un-cloak')

  const user = session.user
  sessionEl.innerHTML = user
    ? `<div class="flex items-center justify-between"><div><div class="text-sm text-zinc-400">Signed in as</div><div class="text-xl">${user.name ?? 'Unnamed'}</div></div><span class="text-xs rounded border border-emerald-400/30 bg-emerald-900/30 px-2 py-1">userId: ${user.id ?? ''}</span></div>`
    : '<div class="text-zinc-300">Not signed in</div>'

  const linkedProviders = new Set((session.accounts ?? []).map(account => account.provider))
  const providers = session.providers ?? []

  signinEl.innerHTML = ''
  linkedEl.innerHTML = ''
  unlinkedEl.innerHTML = ''

  const redirectTo = window.location.href

  const createButton = (label: string, onClick: () => void) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'rounded border border-zinc-600 bg-zinc-700/50 px-3 py-2 text-sm hover:bg-zinc-700'
    button.textContent = label
    button.onclick = onClick
    return button
  }

  providers.forEach((provider) => {
    if (linkedProviders.has(provider)) {
      const item = document.createElement('div')
      item.className = 'flex items-center gap-2 rounded border border-emerald-400/30 bg-emerald-900/20 px-3 py-2'
      item.innerHTML = `<span class="capitalize">${provider}</span>`

      const unlinkBtn = document.createElement('button')
      unlinkBtn.type = 'button'
      unlinkBtn.className = 'text-red-400 hover:text-red-300 text-xl leading-none'
      unlinkBtn.title = 'Unlink'
      unlinkBtn.textContent = '×'
      unlinkBtn.onclick = async () => {
        await auth.unlinkAccount(provider)
      }

      item.appendChild(unlinkBtn)
      linkedEl.appendChild(item)
      return
    }

    const linkBtn = createButton(provider, async () => {
      const url = await auth.linkAccount(provider, { redirectTo })
      window.location.href = url
    })
    unlinkedEl.appendChild(linkBtn)

    const signInBtn = createButton(provider, async () => {
      const url = await auth.signIn(provider, { redirectTo })
      window.location.href = url
    })
    signinEl.appendChild(signInBtn)
  })

  signoutBtn.disabled = !user
}

async function setup() {
  auth.onSessionChange(renderSession)

  try {
    await auth.handleRedirectCallback(url => window.history.replaceState(null, '', url))
    await auth.refreshSession()
  }
  catch (error) {
    console.error('Failed to refresh session', error)
    renderSession(auth.session)
  }

  signoutBtn.onclick = async () => {
    await auth.signOut()
  }
}

setup().catch((error) => {
  console.error('Failed to initialise auth client', error)
  renderSession(auth.session)
})
