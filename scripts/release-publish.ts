import { publishRelease, readReleaseVersion } from './release-shared'

if (import.meta.main) {
  await publishRelease(await readReleaseVersion(process.cwd(), true))
}
