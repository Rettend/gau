import { describe, expect, it } from 'vitest'
import { renderCancelledPage, renderErrorPage, renderSuccessPage } from '../../src/core/templates'

describe('templates', () => {
  describe('renderSuccessPage', () => {
    it('uses handoff-based auto close for custom-scheme redirects', () => {
      const html = renderSuccessPage({ redirectUrl: 'gau://oauth/callback?code=abc' })

      expect(html).toContain(`protocol === 'http:' || protocol === 'https:'`)
      expect(html).toContain(`document.addEventListener('visibilitychange', closeAfterHandoff);`)
      expect(html).toContain(`window.addEventListener('pagehide', function() {`)
      expect(html).toContain(`window.addEventListener('blur', closeAfterBlurFallback, { once: true });`)
      expect(html).toContain(`closeAfterInitialDelay();`)
      expect(html).toContain(`if (typeof document.hasFocus === 'function' && !document.hasFocus())`)
      expect(html).toContain(`scheduleClose(500);`)

      const listenerIndex = html.indexOf(`document.addEventListener('visibilitychange', closeAfterHandoff);`)
      const redirectIndex = html.indexOf('window.location.href = url;')
      expect(listenerIndex).toBeGreaterThan(-1)
      expect(redirectIndex).toBeGreaterThan(listenerIndex)
    })

    it('omits auto-close behavior when disabled', () => {
      const html = renderSuccessPage({
        redirectUrl: 'gau://oauth/callback?code=abc',
        autoClose: false,
      })

      expect(html).not.toContain('scheduleClose(500);')
      expect(html).not.toContain('visibilitychange')
      expect(html).toContain('window.location.href = url;')
    })
  })

  describe('renderErrorPage', () => {
    it('keeps delayed redirect with the shared close logic', () => {
      const html = renderErrorPage({
        message: 'Redirecting...',
        redirectUrl: 'gau://oauth/callback',
        redirectDelay: 4321,
      })

      expect(html).toContain('const url = "gau://oauth/callback";')
      expect(html).toContain('window.location.href = url;')
      expect(html).toContain('}, 4321);')
      expect(html).toContain(`document.addEventListener('visibilitychange', closeAfterHandoff);`)
    })
  })

  describe('renderCancelledPage', () => {
    it('uses the same close strategy as success page', () => {
      const html = renderCancelledPage({ redirectUrl: 'gau://oauth/callback' })

      expect(html).toContain('const url = "gau://oauth/callback";')
      expect(html).toContain(`window.addEventListener('blur', closeAfterBlurFallback, { once: true });`)
    })
  })
})
