<script lang="ts">
  import { page } from '$app/state'
  import AuthError from '../../../../../example-shared/AuthError.svelte'
</script>

<AuthError message={page.url.searchParams.get('message')} code={page.url.searchParams.get('code')} />
