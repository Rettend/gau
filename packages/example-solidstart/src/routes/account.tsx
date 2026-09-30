import { Protected } from '@rttnd/gau/client/solid'
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
