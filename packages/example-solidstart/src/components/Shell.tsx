import type { ParentProps } from 'solid-js'
import { useLocation } from '@solidjs/router'
import '../../../example-shared/styles.css'

export default function Shell(props: ParentProps) {
  const location = useLocation()
  return (
    <div class="example-shell" data-framework="solidstart">
      <div class="example-content">
        <header class="example-header">
          <a href="/" class="example-brand">
            gau <span>/ solidstart</span>
          </a>
          <nav aria-label="Main" class="example-nav">
            <a href="/" aria-current={location.pathname === '/' ? 'page' : undefined}>
              Home
            </a>
            <a href="/account" aria-current={location.pathname === '/account' ? 'page' : undefined}>
              Account
            </a>
            <a href="/protected" aria-current={location.pathname === '/protected' ? 'page' : undefined}>
              Protected page
            </a>
          </nav>
        </header>
        <main>{props.children}</main>
      </div>
    </div>
  )
}
