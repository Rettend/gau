import { Protected } from '@rttnd/gau/client/solid2'
import AuthPanel from '~/components/AuthPanel'

export default Protected(
  () => (
    <>
      <h1 class="example-title">Your account</h1>
      <AuthPanel />
    </>
  ),
  '/',
)
